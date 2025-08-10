import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, OAuthStrategy } from '@wix/sdk';
import {
  services as servicesApi,
  bookings as bookingsApi,
} from '@wix/bookings';

const app = express();
app.use(express.json());

// sanity-проверка env
['BOT_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'PUBLIC_URL'].forEach(k => {
  if (!process.env[k]) console.error(`ENV ${k} is missing`);
});

// Инициализация Wix SDK
const wix = createClient({
  modules: {
    services: servicesApi,
    bookings: bookingsApi,
  },
  auth: OAuthStrategy({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  }),
});

// Контекст сайта обязателен
if (process.env.SITE_ID) {
  try {
    wix.setSite({ siteId: process.env.SITE_ID });
    console.log('Wix site set:', process.env.SITE_ID);
  } catch (e) {
    console.error('setSite error:', e);
  }
} else {
  console.warn('ENV SITE_ID is missing — services may fail');
}

// Telegram Bot
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) =>
  ctx.reply('Привіт! Оберіть дію:', Markup.keyboard([['🗂 Послуги']]).resize())
);

// Список послуг
bot.hears('🗂 Послуги', async (ctx) => {
  try {
    const resp = await wix.services.queryServices().find();
    const items = resp?.items || [];
    if (!items.length) return ctx.reply('Послуг поки немає.');

    const rows = items.map(s => `• ${s.info?.name || 'Без назви'} — ${s._id}`).join('\n');
    ctx.reply(`Доступні послуги:\n${rows}`);
  } catch (e) {
    console.error('services error:', e?.response?.data || e);
    ctx.reply('Не вдалось отримати список послуг.');
  }
});

// HTTP
app.get('/', (_, res) => res.send('ok — /health, бот у Telegram'));
app.get('/health', (_, res) => res.send('ok'));
app.use(bot.webhookCallback(`/tg/${process.env.BOT_TOKEN}`));

// Запуск + вебхук
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
