import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, OAuthStrategy } from '@wix/sdk';
import { bookings } from '@wix/bookings';

const app = express();
app.use(express.json());

// ---- Wix SDK (OAuth: client_credentials) ----
const wix = createClient({
  modules: { bookings },
  auth: OAuthStrategy({
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET, // обязателен для server-to-server
  }),
});

// ---- Telegram Bot ----
const bot = new Telegraf(process.env.BOT_TOKEN);

// /start
bot.start((ctx) =>
  ctx.reply(
    'Привіт! Оберіть дію:',
    Markup.keyboard([['🗂 Послуги', '🗓 Забронювати']]).resize()
  )
);

// список услуг
bot.hears('🗂 Послуги', async (ctx) => {
  try {
    const resp = await wix.bookings.services.queryServices().find();
    if (!resp.items.length) return ctx.reply('Послуг поки немає.');
    const rows = resp.items.map(s => `• ${s.info?.name} — ${s._id}`).join('\n');
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
    const to = new Date(Date.now() + 24*60*60*1000);
    const resp = await wix.bookings.availability.queryAvailability({
      query: { serviceId, from: from.toISOString(), to: to.toISOString() }
    });

    const slots = resp?.slots || [];
    if (!slots.length) return ctx.reply('Немає доступних слотів на обраний період.');

    // первые 6 слотов кнопками
    const btns = slots.slice(0, 6).map(s => {
      const label = s.startTime.slice(11,16) + ' → ' + s.endTime.slice(11,16);
      return [Markup.button.callback(label, `pick:${serviceId}:${s.slot.id}`)];
    });
    ctx.reply('Оберіть слот:', Markup.inlineKeyboard(btns));
  } catch (e) {
    console.error('availability error:', e?.response?.data || e);
    ctx.reply('Не вдалось отримати слоти.');
  }
});

// выбор слота -> просим телефон -> создаём бронь
const sessions = new Map(); // простая память процесса (для прод — лучше Redis)

bot.action(/pick:(.+):(.+)/, async (ctx) => {
  const [, serviceId, slotId] = ctx.match;
  await ctx.answerCbQuery();
  sessions.set(ctx.from.id, { serviceId, slotId });
  return ctx.reply('Надішли свій номер телефону у форматі +380...');
});

bot.on('text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s?.slotId) return; // не ждём телефон — игнор

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

// webhook (Render/Railway)
app.use(bot.webhookCallback(`/tg/${process.env.BOT_TOKEN}`));

// healthcheck
app.get('/health', (_, res) => res.send('ok'));

// graceful shutdown
function shutdown(sig) {
  console.log(`\n${sig} received, shutting down...`);
  process.exit(0);
}
['SIGINT','SIGTERM'].forEach(sig => process.on(sig, () => shutdown(sig)));

// запуск и установка вебхука
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    const url = `${process.env.PUBLIC_URL}/tg/${process.env.BOT_TOKEN}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook set to', url);
  } catch (e) {
    console.error('Webhook set error:', e);
  }
  console.log('Server listening on', PORT);
});
