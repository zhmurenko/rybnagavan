import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup } from 'telegraf';
import { createClient, OAuthStrategy } from '@wix/sdk';
import { services, availability } from '@wix/bookings';
import dotenv from 'dotenv';

dotenv.config();

const {
  BOT_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  WIX_REFRESH_TOKEN,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !PUBLIC_URL) {
  console.error('Missing one of required ENV variables: BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, PUBLIC_URL');
  process.exit(1);
}

const app = express();

// ====== WIX CLIENT ======
let accessToken = null;
async function refreshAccessToken() {
  if (!WIX_REFRESH_TOKEN) {
    console.warn('No WIX_REFRESH_TOKEN yet, skipping refresh');
    return null;
  }

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: WIX_REFRESH_TOKEN,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });

  const res = await fetch('https://www.wix.com/oauth/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Failed to refresh token: ${JSON.stringify(data)}`);

  accessToken = data.access_token;
  console.log('Access token refreshed');
  return accessToken;
}

function getWixClient() {
  if (!accessToken) throw new Error('No access token, refresh first');
  return createClient({
    modules: { services, availability },
    auth: OAuthStrategy({ clientId: CLIENT_ID, tokens: { accessToken } }),
  });
}

// ====== TELEGRAM BOT ======
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Привет! Выберите действие:', Markup.keyboard([
    ['Забронировать'],
  ]).resize());
});

// Команда для теста услуг
bot.command('services', async (ctx) => {
  try {
    await refreshAccessToken();
    const wixClient = getWixClient();
    const res = await wixClient.services.queryServices().find();
    if (res.items.length === 0) return ctx.reply('Нет услуг');
    ctx.reply(res.items.map(s => `${s.name} — ${s.id}`).join('\n'));
  } catch (e) {
    console.error(e);
    ctx.reply('Ошибка получения списка услуг');
  }
});

app.use(bot.webhookCallback('/telegram'));
bot.telegram.setWebhook(`${PUBLIC_URL}/telegram`);

// ====== DEBUG ENDPOINTS ======
app.get('/debug/services', async (req, res) => {
  try {
    await refreshAccessToken();
    const wixClient = getWixClient();
    const servicesList = await wixClient.services.queryServices().find();
    res.json(servicesList.items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/debug/availability', async (req, res) => {
  const { serviceId, ymd } = req.query;
  if (!serviceId || !ymd) return res.status(400).json({ error: 'Need serviceId & ymd' });
  try {
    await refreshAccessToken();
    const wixClient = getWixClient();
    const avail = await wixClient.availability.queryAvailability({
      from: `${ymd}T00:00:00Z`,
      to: `${ymd}T23:59:59Z`,
      serviceId,
    });
    res.json(avail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ====== OAUTH CALLBACK (новый роут для получения refresh_token) ======
app.get('/oauth/callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code) return res.status(400).send('Missing ?code');

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${PUBLIC_URL}/oauth/callback`,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });

    const r = await fetch('https://www.wix.com/oauth/access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });

    const data = await r.json();

    if (!r.ok) {
      console.error('OAuth exchange failed:', data);
      return res.status(500).send(`OAuth exchange failed: ${JSON.stringify(data)}`);
    }

    console.log('=== OAUTH TOKENS ===', data); // тут будет refresh_token

    res.send(`
      <h3>Успех 🎉</h3>
      <p>Скопируй <b>refresh_token</b> и добавь его в Render → Environment Variables как <code>WIX_REFRESH_TOKEN</code>.</p>
      <pre>${JSON.stringify(data, null, 2)}</pre>
    `);
  } catch (e) {
    console.error(e);
    res.status(500).send('Internal error');
  }
});

// ====== START SERVER ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
