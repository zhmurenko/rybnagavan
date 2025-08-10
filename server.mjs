// server.mjs
// ===================== Rybna Gavan bot + Wix OAuth =====================
// Вимагає змінні оточення:
// BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, PUBLIC_URL, WIX_REFRESH_TOKEN (після інсталяції)
// Не забудь у Wix Headless клієнті додати Redirect URI:  https://<твій_домен>.onrender.com/oauth/callback

import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';

const {
  BOT_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  PUBLIC_URL,
  WIX_REFRESH_TOKEN,
  PORT = 3000,
  TIMEZONE = 'Europe/Kiev',
} = process.env;

// -------------------------- helpers --------------------------

/** Лог короткими тегами */
const log = (...args) => console.log('[srv]', ...args);

/** Обмін refresh_token -> access_token (короткоживучий) */
async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !WIX_REFRESH_TOKEN) {
    throw new Error('Missing CLIENT_ID / CLIENT_SECRET / WIX_REFRESH_TOKEN');
  }

  const resp = await fetch('https://www.wix.com/oauth/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: WIX_REFRESH_TOKEN,
    }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`refresh_token exchange failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

/** REST: отримати список послуг Bookings */
async function fetchServices() {
  const access = await getAccessToken();

  const resp = await fetch('https://www.wixapis.com/bookings/v1/services/query', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: {} }),
  });

  const data = await resp.json();
  if (!resp.ok) {
    throw new Error(`services query failed: ${JSON.stringify(data)}`);
  }
  return data.services || data.items || [];
}

// -------------------------- express app --------------------------

const app = express();
app.use(express.json());

app.get('/', (_req, res) => {
  res.type('text').send('RybnaGavan bot is alive');
});

app.get('/ping', (_req, res) => {
  res.json({ ok: true, ts: Date.now(), tz: TIMEZONE });
});

// ===== 1) START INSTALL =====
app.get('/install', (req, res) => {
  try {
    if (!CLIENT_ID || !PUBLIC_URL) {
      return res
        .status(400)
        .send('CLIENT_ID or PUBLIC_URL is not set in env');
    }
    const redirectUri = encodeURIComponent(`${PUBLIC_URL}/oauth/callback`);
    // мінімальний скоуп; при потребі додай ще
    const scope = encodeURIComponent('offline_access bookings.read bookings.manage');
    const url = `https://www.wix.com/installer/install?client_id=${CLIENT_ID}&redirect_uri=${redirectUri}&scope=${scope}&state=rybnagavan`;

    res.redirect(url);
  } catch (e) {
    log('install redirect error:', e);
    res.status(500).send('Install redirect error');
  }
});

// ===== 2) OAUTH CALLBACK =====
app.get('/oauth/callback', async (req, res) => {
  try {
    const { code, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(`OAuth error: ${error} - ${error_description || ''}`);
    }
    if (!code) {
      return res.status(400).send('Missing "code"');
    }

    const tokenResp = await fetch('https://www.wix.com/oauth/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      }),
    });

    const data = await tokenResp.json();
    if (!tokenResp.ok) {
      log('Token exchange failed:', data);
      return res
        .status(500)
        .send(`Token exchange failed: <pre>${JSON.stringify(data, null, 2)}</pre>`);
    }

    const { refresh_token, access_token, expires_in } = data;
    log('== TOKENS RECEIVED == expires_in:', expires_in);

    // На Render не можемо оновити env з коду, тож просто показуємо користувачу:
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <h2>✅ Установка успішна</h2>
      <p>Скопіюй цей <b>WIX_REFRESH_TOKEN</b> у змінні оточення Render і натисни <i>Save, rebuild, and deploy</i>:</p>
      <pre style="padding:12px;border:1px solid #ccc;white-space:pre-wrap">${refresh_token}</pre>
      <hr/>
      <p><small>Короткоживучий access_token (для дебагу):</small></p>
      <pre style="padding:12px;border:1px solid #ccc;white-space:pre-wrap">${access_token}</pre>
    `);
  } catch (e) {
    log('OAuth callback error:', e);
    res.status(500).send('OAuth callback error');
  }
});

// ===== 3) DEBUG: перевірка сервісів (ручна) =====
app.get('/debug/services', async (_req, res) => {
  try {
    const items = await fetchServices();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// -------------------------- telegram bot --------------------------

let bot;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  bot.start(async (ctx) => {
    const kb = Markup.keyboard([['📦 Послуги']]).resize();
    await ctx.reply('Привіт! Оберіть дію:', kb);
  });

  bot.hears('📦 Послуги', async (ctx) => {
    try {
      const services = await fetchServices();
      if (!services.length) {
        return ctx.reply('Не вдалося отримати список послуг.');
      }
      const lines = services.map((s) => {
        const id = s._id || s.id || s.appId || '—';
        const name = s.name?.translated?.uk || s.name?.translated?.ru || s.name?.translated?.en || s.name || 'Без назви';
        return `• ${name} — <code>${id}</code>`;
      });
      await ctx.replyWithHTML(
        `Доступні послуги:\n${lines.join('\n')}\n\nНадішли <code>/slots &lt;SERVICE_ID&gt;</code> щоб побачити вільні слоти (роут під підключення готовий, логіку можна розвинути).`
      );
    } catch (e) {
      log('tg services error:', e);
      await ctx.reply('Не вдалося отримати список послуг.');
    }
  });

  // приклад технічної команди, розшириш за потреби
  bot.command('slots', async (ctx) => {
    const [, serviceId] = ctx.message.text.trim().split(/\s+/);
    if (!serviceId) {
      return ctx.reply('Вкажи ID послуги: /slots <SERVICE_ID>');
    }
    return ctx.reply('Слоти поки що не підключені у цьому файлі. Але OAuth вже працює ✔️');
  });

  // webhook
  const webhookPath = `/tg/${BOT_TOKEN}`;
  app.use(bot.webhookCallback(webhookPath));

  async function setWebhook() {
    if (!PUBLIC_URL) {
      log('PUBLIC_URL not set, skip webhook');
      return;
    }
    const url = `${PUBLIC_URL}${webhookPath}`;
    try {
      await bot.telegram.setWebhook(url);
      log('Webhook set to', url);
    } catch (e) {
      log('setWebhook error:', e);
    }
  }

  setWebhook();
} else {
  log('BOT_TOKEN not set — бот відключено.');
}

// -------------------------- start server --------------------------

app.listen(PORT, () => {
  log(`Server listening on ${PORT} TIMEZONE = ${TIMEZONE}`);
  if (!CLIENT_ID) log('WARN: CLIENT_ID is missing');
  if (!CLIENT_SECRET) log('WARN: CLIENT_SECRET is missing');
  if (!PUBLIC_URL) log('WARN: PUBLIC_URL is missing (webhook/install won’t work)');
});
