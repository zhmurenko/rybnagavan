import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, ApiKeyStrategy } from '@wix/sdk';
import {
  services as servicesApi,
  bookings as bookingsApi,
} from '@wix/bookings';

const app = express();
app.use(express.json());

// ===== sanity-check env =====
['BOT_TOKEN', 'ADMIN_API_KEY', 'SITE_ID', 'PUBLIC_URL'].forEach(k => {
  if (!process.env[k]) console.error(`ENV ${k} is missing`);
});

// ===== Wix SDK with Admin API Key =====
const wix = createClient({
  modules: {
    services: servicesApi,
    bookings: bookingsApi,
  },
  auth: ApiKeyStrategy({
    siteId: process.env.SITE_ID,
    apiKey: process.env.ADMIN_API_KEY,
  }),
});

// ---------- helpers ----------
const headerJSON = { 'Content-Type': 'application/json' };
const wixHeaders = {
  ...headerJSON,
  // для Admin API Key так:
  Authorization: process.env.ADMIN_API_KEY,
  'wix-site-id': process.env.SITE_ID,
};

// REST fallback: services
async function restQueryServices() {
  const url = 'https://www.wixapis.com/bookings/v1/services/query';
  const r = await fetch(url, {
    method: 'POST',
    headers: wixHeaders,
    body: JSON.stringify({ query: {} }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`REST services ${r.status}: ${t}`);
  }
  return r.json();
}

// REST: availability
async function restQueryAvailability({ serviceId, from, to }) {
  const url = 'https://www.wixapis.com/bookings/v1/availability/query';
  const r = await fetch(url, {
    method: 'POST',
    headers: wixHeaders,
    body: JSON.stringify({ query: { serviceId, from, to } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`REST availability ${r.status}: ${t}`);
  }
  return r.json();
}

// get services (SDK -> REST fallback)
async function getServices() {
  try {
    const resp = await wix.services.queryServices().find();
    return resp?.items ?? [];
  } catch (e) {
    console.warn('SDK services failed, fallback to REST:', e?.response?.data || e?.message || e);
    const j = await restQueryServices();
    return j?.services ?? j?.items ?? [];
  }
}

// ---------- Telegram Bot ----------
const bot = new Telegraf(process.env.BOT_TOKEN);

// /start
bot.start((ctx) =>
  ctx.reply(
    'Привіт! Оберіть дію:',
    Markup.keyboard([['🗂 Послуги', '🗓 Забронювати']]).resize()
  )
);

// список послуг
bot.hears('🗂 Послуги', async (ctx) => {
  try {
    const items = await getServices();
    if (!items.length) return ctx.reply('Послуг поки немає.');

    // у REST и SDK формы немного отличаются — подстрахуемся
    const rows = items.map(s => {
      const id = s._id || s.id;
      const name = s.info?.name || s.name || 'Без назви';
      return `• ${name} — ${id}`;
    }).join('\n');

    return ctx.reply(
      `Доступні послуги:\n${rows}\n\nНадішли /slots <SERVICE_ID> щоб побачити вільні слоти на сьогодні.`
    );
  } catch (e) {
    console.error('services error:', e?.response?.data || e);
    ctx.reply('Не вдалось отримати список послуг.');
  }
});

// слоти на сьогодні: /slots <SERVICE_ID>
bot.command('slots', async (ctx) => {
  try {
    const [, serviceId] = ctx.message.text.split(' ').map(s => s.trim());
    if (!serviceId) return ctx.reply('Надішли: /slots <SERVICE_ID>');

    const from = new Date();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const j = await restQueryAvailability({
      serviceId,
      from: from.toISOString(),
      to: to.toISOString(),
    });

    const slots = j?.slots || j?.availability?.slots || [];
    if (!slots.length) return ctx.reply('Немає доступних слотів на обраний період.');

    const btns = slots.slice(0, 6).map(s => {
      const start = (s.startTime || s.slot?.startTime || '').slice(11, 16);
      const end = (s.endTime || s.slot?.endTime || '').slice(11, 16);
      const slotId = s.slot?.id || s.id || s.slotId;
      return [Markup.button.callback(`${start} → ${end}`, `pick:${serviceId}:${slotId}`)];
    });

    ctx.reply('Оберіть слот:', Markup.inlineKeyboard(btns));
  } catch (e) {
    console.error('availability error:', e?.message || e);
    ctx.reply('Не вдалось отримати слоти.');
  }
});

// простые «сессии» на процесс
const sessions = new Map();

bot.action(/pick:(.+):(.+)/, async (ctx) => {
  const [, serviceId, slotId] = ctx.match;
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { serviceId, slotId });
  return ctx.reply('Надішли свій номер телефону у форматі +380...');
});

bot.on('text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s?.slotId) return;

  const phone = ctx.message.text.trim();
  if (!/^\+?\d{10,15}$/.test(phone)) return ctx.reply('Схоже, це не номер. Надішли номер у форматі +380...');

  try {
    const r = await wix.bookings.createBooking({
      booking: {
        slot: { slotId: s.slotId, serviceId: s.serviceId },
        contactDetails: { fullName: ctx.from.first_name || 'Guest', phone },
        participants: 1,
      }
    });
    const id = r?.booking?._id || r?.booking?.id;
    sessions.delete(ctx.from.id);
    return ctx.reply(`✅ Бронювання створено! ID: ${id}\n(Оплату додамо окремим посиланням)`);
  } catch (e) {
    console.error('book error:', e?.response?.data || e);
    return ctx.reply('Не вдалось створити бронь. Спробуй інший слот.');
  }
});

// ---------- HTTP ----------
app.get('/', (_, res) => res.send('ok — /health, /debug/services, /debug/sdk'));
app.get('/health', (_, res) => res.send('ok'));

// debug: сырой ответ по услугам
app.get('/debug/services', async (_, res) => {
  try {
    const items = await getServices();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message || e });
  }
});

// debug: что есть в SDK
app.get('/debug/sdk', (_, res) => {
  res.json({
    has: {
      services_query: !!(wix.services?.queryServices),
      bookings_create: !!(wix.bookings?.createBooking),
    }
  });
});

// Webhook
app.use(bot.webhookCallback(`/tg/${process.env.BOT_TOKEN}`));

// ---------- start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    const url = `${process.env.PUBLIC_URL}/tg/${process.env.BOT_TOKEN}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook set to', url);
  } catch (e) {
    console.error('Webhook set error:', e?.response?.data || e);
  }
  console.log('Server listening on', PORT);
});
