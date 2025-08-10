// server.mjs
// ============================================================
// Rybna Gavan: Telegram bot + Wix OAuth + New Booking Notifier
// ============================================================

import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

// -------- ENV --------
const {
  PORT = 3000,
  TIMEZONE = 'Europe/Kiev',
  PUBLIC_URL,          // https://rybnagavan.onrender.com
  CLIENT_ID,           // 8a1b6acb-ea34-4224-a914-21aea52b7709
  CLIENT_SECRET,       // твій Wix secret
  BOT_TOKEN,           // токен бота від BotFather
  WIX_REFRESH_TOKEN,   // з'явиться після OAuth
  ADMIN_CHAT_ID        // chat id, куди слати нотифікації
} = process.env;

const app = express();
app.use(express.json());

const log = (...a) => console.log('[srv]', ...a);

// ======================== OAuth / Tokens ========================

// 1) Посилання для інсталяції (через твій сервер)
app.get('/install', (req, res) => {
  try {
    if (!CLIENT_ID || !PUBLIC_URL) {
      return res.status(400).send('CLIENT_ID or PUBLIC_URL is missing in env');
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/oauth/callback`);
    const scope = encodeURIComponent('offline_access bookings.read bookings.manage');
    const url =
      `https://www.wix.com/installer/install?` +
      `client_id=${CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=rybnagavan`;
    res.redirect(url);
  } catch (e) {
    log('install redirect error:', e);
    res.status(500).send('Install redirect error');
  }
});

// 2) Колбек: міняємо code -> tokens (показуємо refresh_token у браузері)
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`OAuth error: ${error} - ${error_description || ''}`);
    if (!code) return res.status(400).send('Missing "code"');

    const r = await fetch('https://www.wix.com/oauth/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      })
    });
    const data = await r.json();
    if (!r.ok) {
      log('OAuth exchange failed:', data);
      return res.status(500).send(`Token exchange failed: <pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    const { refresh_token, access_token, expires_in } = data;
    log('== TOKENS RECEIVED == expires_in:', expires_in);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <h2>✅ OAuth успішний</h2>
      <p>Скопіюй цей <b>WIX_REFRESH_TOKEN</b> у Render → Environment:</p>
      <pre style="padding:12px;border:1px solid #ccc">${refresh_token}</pre>
      <hr/>
      <details><summary>Поточний access_token (короткоживучий)</summary>
      <pre style="padding:12px;border:1px solid #ccc;white-space:pre-wrap">${access_token}</pre></details>
    `);
  } catch (e) {
    log('OAuth callback error:', e);
    res.status(500).send('OAuth callback error');
  }
});

// 3) Отримуємо короткоживучий access_token по refresh_token
async function getAccessTokenFromRefresh() {
  if (!CLIENT_ID || !CLIENT_SECRET || !WIX_REFRESH_TOKEN) {
    throw new Error('Missing CLIENT_ID/CLIENT_SECRET/WIX_REFRESH_TOKEN');
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
  if (!r.ok) throw new Error(`refresh exchange failed: ${r.status} ${JSON.stringify(j)}`);
  return j.access_token;
}

// 4) Загальний помічник для Admin API
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
  if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(j)}`);
  return j;
}

// ======================== Debug & Health ========================

app.get('/', (_req, res) => res.type('text').send('OK RybnaGavan'));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tz: TIMEZONE,
    now: new Date().toISOString(),
    has: {
      PUBLIC_URL: !!PUBLIC_URL,
      CLIENT_ID: !!CLIENT_ID,
      CLIENT_SECRET: !!CLIENT_SECRET,
      BOT_TOKEN: !!BOT_TOKEN,
      WIX_REFRESH_TOKEN: !!WIX_REFRESH_TOKEN,
      ADMIN_CHAT_ID: !!ADMIN_CHAT_ID
    }
  });
});

// Сервіси (список)
app.get('/debug/services', async (_req, res) => {
  try {
    const data = await wixFetch('/bookings/v1/services/query', { query: { paging: { limit: 50 } } });
    const items = (data.services || data.items || []).map(s => ({
      _id: s._id || s.id,
      name:
        s.name?.['uk'] ||
        s.name?.['ru'] ||
        s.name?.['en'] ||
        s.name?.plain ||
        s.name || 'Без назви'
    }));
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Доступність на день
// GET /debug/availability?serviceId=<UUID>&ymd=YYYY-MM-DD
app.get('/debug/availability', async (req, res) => {
  const { serviceId, ymd, tz = TIMEZONE } = req.query;
  if (!serviceId || !ymd) return res.status(400).json({ ok: false, error: 'need serviceId & ymd' });

  // Calendar v2 (як у твоїх скрінах)
  const body = {
    filter: { serviceId },
    start: `${ymd}T00:00:00${offsetForTZ(tz)}`,
    end: `${ymd}T23:59:59${offsetForTZ(tz)}`,
    timezone: tz,
  };

  try {
    const data = await wixFetch('/bookings/v2/availability/calendar', body);
    res.json({ ok: true, timezone: tz, start: body.start, end: body.end, raw: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

function offsetForTZ(tz) {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(now);
    const off = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT+0';
    const m = off.match(/GMT([+\-]\d+)(?::(\d{2}))?/i);
    if (!m) return '+00:00';
    const sign = m[1].startsWith('-') ? '-' : '+';
    const hh = String(Math.abs(parseInt(m[1], 10))).padStart(2, '0');
    const mm = m[2] || '00';
    return `${sign}${hh}:${mm}`;
  } catch {
    return '+00:00';
  }
}

// ======================== Telegram Bot ========================

let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const kb = Markup.keyboard([['📦 Послуги']]).resize();
    await ctx.reply('Привіт! Бот активний. Для нотифікацій встанови ADMIN_CHAT_ID.', kb);
  });

  // Дізнатися свій chat id
  bot.command('whoami', async (ctx) => {
    await ctx.reply(`Ваш chat id: <code>${ctx.chat.id}</code>`, { parse_mode: 'HTML' });
  });

  // Показати послуги
  bot.hears('📦 Послуги', async (ctx) => {
    try {
      const data = await wixFetch('/bookings/v1/services/query', { query: { paging: { limit: 50 } } });
      const items = (data.services || data.items || []);
      if (!items.length) return ctx.reply('Послуги не знайдені.');
      const lines = items.map(s => `• ${s.name?.['uk'] || s.name?.['ru'] || s.name?.['en'] || s.name} — <code>${s._id || s.id}</code>`);
      await ctx.replyWithHTML(`Доступні послуги:\n${lines.join('\n')}`);
    } catch (e) {
      await ctx.reply('Помилка отримання послуг.');
    }
  });

  // webhook
  const webhookPath = `/tg/${BOT_TOKEN}`;
  app.use(bot.webhookCallback(webhookPath));
  (async () => {
    if (PUBLIC_URL) {
      try {
        await bot.telegram.setWebhook(`${PUBLIC_URL}${webhookPath}`);
        log('Webhook set to', `${PUBLIC_URL}${webhookPath}`);
      } catch (e) {
        log('setWebhook error:', e);
      }
    }
  })();

} else {
  log('BOT_TOKEN not set — бот вимкнено.');
}

// Діагностика: ручний сет вебхука
app.get('/set-webhook', async (_req, res) => {
  try {
    if (!bot) return res.status(400).send('Bot not initialized');
    if (!PUBLIC_URL) return res.status(400).send('PUBLIC_URL missing');
    const url = `${PUBLIC_URL}/tg/${BOT_TOKEN}`;
    await bot.telegram.setWebhook(url);
    res.json({ ok: true, webhook: url });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ======================== New Booking Notifier ========================

// Надіслати повідомлення адміну
async function notify(text) {
  try {
    if (!bot) return;
    if (!ADMIN_CHAT_ID) {
      console.warn('[notify] ADMIN_CHAT_ID is not set — skip');
      return;
    }
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) {
    console.error('[notify] send error:', e);
  }
}

// Витяг нових броней (останні за createdDate)
async function wixQueryLatestBookings(limit = 50) {
  const access = await getAccessTokenFromRefresh();
  const r = await fetch('https://www.wixapis.com/bookings/v1/bookings/query', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: {
        paging: { limit },
        sort: [{ fieldName: 'createdDate', order: 'DESC' }]
      }
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`/bookings.query ${r.status} ${JSON.stringify(j)}`);
  return j.bookings || j.items || [];
}

// Форматування
function fmtLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('uk-UA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
function cleanPhone(p) {
  return (p || '').replace(/[^\d+]/g, '');
}
function extractAmount(b) {
  const amount =
    b.totalPrice?.amount ??
    b.price?.amount ??
    b.payment?.amount ??
    b.order?.totals?.grandTotal?.amount ??
    b.order?.price?.amount ??
    null;
  const currency =
    b.totalPrice?.currency ??
    b.price?.currency ??
    b.payment?.currency ??
    b.order?.totals?.grandTotal?.currency ??
    b.order?.price?.currency ??
    'UAH';
  return { amount, currency };
}
function extractPhone(b) {
  return (
    b.contactDetails?.phone ||
    b.customer?.phone ||
    b.participants?.[0]?.contactDetails?.phone ||
    '—'
  );
}
function extractFullName(b) {
  return (
    b.contactDetails?.fullName ||
    b.customer?.name ||
    b.participants?.[0]?.contactDetails?.fullName ||
    '—'
  );
}
function extractServiceName(b) {
  return (
    b.service?.name?.translated?.uk ||
    b.service?.name?.translated?.ru ||
    b.service?.name?.translated?.en ||
    b.service?.name ||
    'Послуга'
  );
}
function extractSector(b) {
  return (
    b.slot?.resource?.name ||
    b.resource?.name ||
    b.resources?.[0]?.name ||
    `Сектор (id: ${b.slot?.resource?.id || b.resource?.id || b.resources?.[0]?.id || '—'})`
  );
}
function extractStart(b) {
  return b.slot?.startDate || b.startTime || b.slot?.startTime || null;
}
function extractEnd(b) {
  return b.slot?.endDate || b.endTime || b.slot?.endTime || null;
}

// Пам'ятаємо «поріг» останньої побаченої броні
let lastSeenCreated = null;

// Перевірка нових броней
async function checkNewBookings() {
  try {
    const list = await wixQueryLatestBookings(50);
    if (!list.length) return;

    const pickCreated = (b) => b.createdDate || b.bookingInfo?.createdDate || b._createdDate || b._created || null;

    if (!lastSeenCreated) {
      lastSeenCreated = pickCreated(list[0]); // не спамимо ретроспективні
      return;
    }

    const fresh = [];
    for (const b of list) {
      const cd = pickCreated(b);
      if (!cd) continue;
      if (cd > lastSeenCreated) fresh.push(b);
      else break; // список відсортований DESC
    }
    if (!fresh.length) return;

    lastSeenCreated = pickCreated(fresh[0]) || lastSeenCreated;

    // шлемо у хронологічному порядку (старіші → новіші)
    for (let i = fresh.length - 1; i >= 0; i--) {
      const b = fresh[i];
      const serviceName = extractServiceName(b);
      const sectorName  = extractSector(b);
      const startIso    = extractStart(b);
      const endIso      = extractEnd(b);
      const { amount, currency } = extractAmount(b);
      const priceTxt = amount != null ? `${new Intl.NumberFormat('uk-UA').format(amount)} ${currency}` : '—';
      const fullName  = extractFullName(b);
      const phone     = extractPhone(b);
      const bid       = b._id || b.id || '—';

      const msg =
        `🆕 <b>Нова бронь</b>\n` +
        `• Послуга: <b>${serviceName}</b>\n` +
        `• Сектор: <b>${sectorName}</b>\n` +
        `• Дата/час: <b>${fmtLocal(startIso)}</b>${endIso ? ` → <b>${fmtLocal(endIso)}</b>` : ''}\n` +
        `• До оплати: <b>${priceTxt}</b>\n` +
        `• Клієнт: ${fullName}\n` +
        `• Телефон: <a href="tel:${cleanPhone(phone)}">${phone}</a>\n` +
        `• ID: <code>${bid}</code>`;

      await notify(msg);
    }
  } catch (e) {
    console.error('[checkNewBookings] error:', e?.message || e);
  }
}

// таймер (кожні 60 сек)
setInterval(checkNewBookings, 60 * 1000);

// ручний тригер з браузера
app.get('/admin/trigger-notify', async (_req, res) => {
  try {
    await checkNewBookings();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ======================== Start ========================
app.listen(PORT, () => {
  log(`Server listening on ${PORT} TZ=${TIMEZONE}`);
  if (!PUBLIC_URL) log('WARN: PUBLIC_URL missing');
  if (!CLIENT_ID) log('WARN: CLIENT_ID missing');
  if (!CLIENT_SECRET) log('WARN: CLIENT_SECRET missing');
  if (!BOT_TOKEN) log('WARN: BOT_TOKEN missing (бот вимкнено)');
});
