// server.mjs
// Node >=18 (на Render fetch глобальный). Модульный режим (type: module).

import express from 'express';
import bodyParser from 'body-parser';
import { Telegraf, Markup } from 'telegraf';

// =========================
// ENV
// =========================
const {
  PORT = 3000,
  PUBLIC_URL = 'https://rybnagavan.onrender.com',
  TIMEZONE = 'Europe/Kiev',
  BOT_TOKEN,                // Telegram
  CLIENT_ID,                // Wix OAuth client id
  CLIENT_SECRET,            // Wix OAuth client secret
  WIX_REFRESH_TOKEN         // Wix Refresh token (после OAuth обмена)
} = process.env;

if (!PUBLIC_URL) console.warn('WARN: PUBLIC_URL is not set');
if (!TIMEZONE) console.warn('WARN: TIMEZONE is not set, default Europe/Kiev');

// =========================
// App
// =========================
const app = express();
app.use(bodyParser.json());

// =========================
// Telegram bot (минималка)
// =========================
let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start((ctx) =>
    ctx.reply(
      'Привіт! Я тут. Основне — OAuth з Wix. Команди:\n' +
      '/services — показати послуги (через Wix API)\n' +
      '/authlink — посилання для авторизації Wix (OAuth)'
    )
  );

  bot.command('authlink', (ctx) => {
    const url = buildWixInstallLink();
    ctx.reply(
      'Відкрий посилання для авторизації у Wix (OAuth):\n' + url,
      { disable_web_page_preview: true }
    );
  });

  bot.command('services', async (ctx) => {
    try {
      const list = await wixListServices();
      if (!list.length) return ctx.reply('Послуги не знайдені.');
      const lines = list.map(s => `• ${s.name} — ${s._id}`).join('\n');
      ctx.reply('Доступні послуги:\n' + lines);
    } catch (e) {
      console.error('services error:', e);
      ctx.reply('Не вдалось отримати послуги.');
    }
  });

  // Вебхук
  app.use(await bot.createWebhook({ domain: PUBLIC_URL }));
} else {
  console.warn('BOT_TOKEN не задан — Telegram бот відключений.');
}

// =========================
// Wix OAuth helpers
// =========================

// 1) Ссылка для установки / авторизации приложения (headless)
function buildWixInstallLink() {
  const params = new URLSearchParams({
    client_id: CLIENT_ID ?? '',
    redirect_uri: `${PUBLIC_URL}/oauth/callback`,
    // Вкажи тільки потрібні скоупи. Для бронювання зазвичай потрібні:
    // offline_access + читання/керування бронями/послугами.
    scope: [
      'offline_access',
      'bookings.read',
      'bookings.manage'
    ].join(' '),
    state: 'rybnagavan'
  });
  return `https://www.wix.com/installer/install?${params.toString()}`;
}

// 2) Обмен кода на refresh_token (коллбек)
app.get('/oauth/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    return res
      .status(400)
      .send(`OAuth error: ${error} - ${error_description || ''}`);
  }
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    const tokenRes = await fetch('https://www.wix.com/oauth/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      }),
    });

    const data = await tokenRes.json();
    console.log('OAuth exchange result:', data);

    if (!tokenRes.ok) {
      return res
        .status(500)
        .send(`OAuth exchange failed: ${tokenRes.status} ${JSON.stringify(data)}`);
    }

    // Показываем токены пользователю прямо в браузере (скопируй WIX_REFRESH_TOKEN)
    res
      .status(200)
      .send(
        `<pre>OK
access_token: ${data.access_token || '(получается, но истечет быстро)'}
refresh_token: ${data.refresh_token || '(не пришел)'}
expires_in: ${data.expires_in || ''}
scope: ${data.scope || ''}

/**
 * СКОПІЮЙ "refresh_token" і встав у Render як:
 * WIX_REFRESH_TOKEN=...
 * Потім Redeploy.
 */
</pre>`
      );
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send('Error during token exchange');
  }
});

// 3) Функция обмена refresh_token -> access_token
async function getAccessTokenFromRefresh() {
  if (!WIX_REFRESH_TOKEN) {
    throw new Error('WIX_REFRESH_TOKEN is not set. Спочатку пройди OAuth.');
  }
  const r = await fetch('https://www.wix.com/oauth/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: WIX_REFRESH_TOKEN,
    }),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`Refresh exchange failed: ${r.status} ${JSON.stringify(j)}`);
  }
  return j.access_token;
}

// Общий помощник для Wix API
async function wixFetch(path, body = {}) {
  const access = await getAccessTokenFromRefresh();
  const r = await fetch(`https://www.wixapis.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  }
  return j;
}

// =========================
// Wix: Services & Availability (debug endpoints)
// =========================

// Получить список услуг
async function wixListServices() {
  // Минимальный валидный фильтр (пустой не допускается в некоторых аккаунтах)
  const body = {
    query: {
      filter: { hidden: false }, // подстраховка, чтобы не был пуст
      sort: [{ fieldName: 'name', order: 'ASC' }],
      paging: { limit: 50 },
    },
  };
  const data = await wixFetch('/bookings/v1/services/query', body);
  return (data.services || []).map((s) => ({
    _id: s._id || s.id || s.appId || s.appid || 'unknown',
    name: s.name?.['ru'] || s.name?.['uk'] || s.name?.['en'] || s.name || 'Без назви',
  }));
}

// DEBUG: список услуг (в браузер)
app.get('/debug/services', async (_req, res) => {
  try {
    const list = await wixListServices();
    res.json({ ok: true, services: list });
  } catch (e) {
    console.error('debug/services error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// DEBUG: доступность за день
// GET /debug/availability?serviceId=<UUID>&ymd=2025-08-15
app.get('/debug/availability', async (req, res) => {
  const serviceId = req.query.serviceId;
  const ymd = req.query.ymd; // YYYY-MM-DD
  if (!serviceId || !ymd) {
    return res.status(400).json({ ok: false, error: 'need serviceId and ymd=YYYY-MM-DD' });
  }

  // Вспомогательные ISO границы дня в TZ
  const dayStart = `${ymd}T00:00:00${tzOffset(TIMEZONE)}`;
  const dayEnd = `${ymd}T23:59:59${tzOffset(TIMEZONE)}`;

  try {
    // Этот эндпоинт стабильно возвращает availabilityEntries (как у тебя на скрине)
    const body = {
      filter: {
        serviceId,
      },
      start: dayStart,
      end: dayEnd,
      timezone: TIMEZONE,
    };
    const data = await wixFetch('/bookings/v2/availability/calendar', body);
    res.json({
      ok: true,
      timezone: TIMEZONE,
      start: dayStart,
      end: dayEnd,
      raw: data,
    });
  } catch (e) {
    console.error('debug/availability error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Простой корень (проверка живости)
app.get('/', (_req, res) => {
  res.type('text').send('OK rybnagavan bot server');
});

// =========================
// Utils
// =========================

// Простейший офсет (+03:00) для указанной TZ.
// Для Production лучше использовать библиотеку (luxon/dayjs/tz).
function tzOffset(tz) {
  try {
    const now = new Date();
    // Получим смещение как форматированный DST-учитывающий offest:
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset'
    }).formatToParts(now);
    const off = fmt.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
    // off формата GMT+3 — приведём к +03:00
    const m = off.match(/GMT([+\-]\d+)(?::(\d{2}))?/i);
    if (m) {
      const h = String(Math.abs(parseInt(m[1], 10))).padStart(2, '0');
      const sign = m[1].startsWith('-') ? '-' : '+';
      const mm = m[2] ?? '00';
      return `${sign}${h}:${mm}`;
    }
    return '+00:00';
  } catch {
    return '+00:00';
  }
}

// =========================
// Start
// =========================
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}  TIMEZONE = ${TIMEZONE}`);
  console.log(`==> Your service is live 🎉`);
  console.log(`==> Available at your primary URL ${PUBLIC_URL}`);
});
