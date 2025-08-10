import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, OAuthStrategy } from '@wix/sdk';
import { bookings } from '@wix/bookings';

const app = express();
app.use(express.json());

// ---- валидация переменных окружения (чтобы сразу видно было в логах) ----
['BOT_TOKEN', 'CLIENT_ID', 'CLIENT_SECRET', 'PUBLIC_URL'].forEach((k) => {
  if (!process.env[k]) {
    console.error(`ENV ${k} is missing`);
  }
});

// ---- Wix SDK (OAuth: client_credentials) ----
const wix = createClient({
  modules: { bookings },
  auth: OAuthStrategy({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
  }),
});

// ВАЖНО: задать сайт, чтобы Bookings знал, куда лезть
if (process.env.SITE_ID) {
  try {
    wix.setSite({ siteId: process.env.SITE_ID });
    console.log('Wix site set:', process.env.SITE_ID);
  } catch (e) {
    console.error('setSite error:', e);
  }
} else {
  console.warn('ENV SITE_ID is missing — services/availability may fail');
}

// ---- Telegram Bot ----
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
    const resp = await wix.bookings.services.queryServices().find();
    const items = resp?.items || [];
    if (!items.length) return ctx.reply('Послуг поки немає.');
    const rows = items.map(s => `• ${s.info?.name} — ${s._id}`).join('\n');
    ctx.reply(`Доступні послуги:\n${rows}\n\nНадішли /slots <SERVICE_ID> щоб побачити вільні слоти на сьогодні.`);
  } catch (e) {
    console.error('services error:', e?.response?.data || e);
    ctx.reply('Не вдалось отримати список послуг.');
  }
});

// слоты на сегодня: /slots <SERVICE_ID>
bot.command('slots', async (ctx) => {
  try {
    const [, serviceId] = ctx.message.text.split(' ').map(s => s.trim());
    if (!serviceId) return ctx.reply('Надішли: /slots <SERVICE_ID>');

    const from = new Date();
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const resp = await wix.bookings.availability.queryAvailability({
      query: { serviceId, from: from.toISOString(), to: to.toISOString() }
    });

    const slots = resp?.slots || [];
    if (!slots.length) return ctx.reply('Немає доступних слотів на обраний період.');

    const btns = slots.slice(0, 6).map(s => {
      const label = s.startTime.slice(11, 16) + ' → ' + s.endTime.slice(11, 16);
      return [Markup.button.callback(label, `pick:${serviceId}:${s.slot.id}`)];
    });
    ctx.reply('Оберіть слот:', Markup.inlineKeyboard(btns));
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    ctx.reply('Не вдалось отримати слоти.');
  }
});

// примитивные сессии в памяти процесса
const sessions = new Map();

bot.action(/pick:(.+):(.+)/, async (ctx) => {
  const [, serviceId, slotId] = ctx.match;
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { serviceId, slotId });
  return ctx.reply('Надішли свій номер телефону у форматі +380...');
});

bot.on('text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s?.slotId) return; // ждём телефон? если нет — выходим

  const phone = ctx.message.text.trim();
  if (!/^\+?\d{10,15}$/.test(phone)) return ctx.reply('Схоже, це не номер. Надішли номер у форматі +380...');

  try {
    const r = await wix.bookings.bookings.createBooking({
      booking: {
        slot: { slotId: s.slotId, serviceId: s.serviceId },
        contactDetails: { fullName: ctx.from.first_name || 'Guest', phone },
        participants: 1
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

// --- HTTP роуты ---
app.get('/', (_, res) => res.send('ok — bot webhook is /tg/<BOT_TOKEN>, health is /health'));
app.get('/health', (_, res) => res.send('ok'));
app.use(bot.webhookCallback(`/tg/${process.env.BOT_TOKEN}`));

// --- запуск и установка вебхука ---
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
