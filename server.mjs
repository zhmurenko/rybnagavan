// server.mjs — Telegram бот бронирования c календарём дат (Admin API Key)

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, ApiKeyStrategy } from '@wix/sdk';
import { services as servicesApi, bookings as bookingsApi } from '@wix/bookings';

// ================== ENV sanity ==================
const REQ_ENV = ['BOT_TOKEN', 'ADMIN_API_KEY', 'SITE_ID', 'PUBLIC_URL'];
REQ_ENV.forEach(k => { if (!process.env[k]) console.error(`ENV ${k} is missing`); });

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const SITE_ID = process.env.SITE_ID;
const PUBLIC_URL = process.env.PUBLIC_URL;

const app = express();
app.use(express.json());

// ================== Wix client (Admin API Key) ==================
const wix = createClient({
  modules: { services: servicesApi, bookings: bookingsApi },
  auth: ApiKeyStrategy({ siteId: SITE_ID, apiKey: ADMIN_API_KEY }),
});

// ================== REST helpers (services/availability) ==================
const baseHeaders = {
  'Content-Type': 'application/json',
  Authorization: ADMIN_API_KEY,
  'wix-site-id': SITE_ID,
};

async function restQueryServices() {
  const r = await fetch('https://www.wixapis.com/bookings/v1/services/query', {
    method: 'POST', headers: baseHeaders, body: JSON.stringify({ query: {} }),
  });
  if (!r.ok) throw new Error(`services ${r.status}: ${await r.text()}`);
  return r.json(); // { services: [...] }
}

async function restQueryAvailability({ serviceId, from, to }) {
  const r = await fetch('https://www.wixapis.com/bookings/v1/availability/query', {
    method: 'POST', headers: baseHeaders,
    body: JSON.stringify({ query: { serviceId, from, to } }),
  });
  if (!r.ok) throw new Error(`availability ${r.status}: ${await r.text()}`);
  return r.json(); // { slots: [...] } (или availability.slots)
}

// объединённый геттер услуг (на будущее — если к SDK вернёмся)
async function getServices() {
  try {
    // попробуем SDK
    const resp = await wix.services.queryServices().find();
    return resp?.items ?? [];
  } catch (_) {
    // fallback REST
    const j = await restQueryServices();
    return j?.services ?? j?.items ?? [];
  }
}

// ================== ДАТЫ/ФОРМАТЫ ==================
const RU_DAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const UA_MONTHS_SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'сер', 'вер', 'жовт', 'лис', 'груд'];

function pad2(n) { return n.toString().padStart(2, '0'); }

function toYMD(d) {
  // YYYY-MM-DD
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function dayLabel(d, todayYMD) {
  const ymd = toYMD(d);
  if (ymd === todayYMD) return 'Сьогодні';
  const wd = RU_DAYS[d.getUTCDay()];
  const lab = `${wd} ${d.getUTCDate()} ${UA_MONTHS_SHORT[d.getUTCMonth()]}`;
  return lab;
}

function startOfUTC(ymd) { return new Date(`${ymd}T00:00:00.000Z`); }
function endOfUTC(ymd)   { return new Date(`${ymd}T23:59:59.999Z`); }

// ================== Telegram bot ==================
const bot = new Telegraf(BOT_TOKEN);

// простейшие "сессии" в памяти процесса
const sessions = new Map(); // key: userId => { serviceId, dateYMD, slotId, step, name, phone }

// /start
bot.start((ctx) =>
  ctx.reply('Привіт! Оберіть дію:', Markup.keyboard([['🗂 Послуги']]).resize())
);

// Послуги -> инлайн кнопки с услугами
bot.hears('🗂 Послуги', async (ctx) => {
  try {
    const services = await getServices();
    if (!services.length) return ctx.reply('Послуг поки немає.');

    const buttons = services.slice(0, 20).map(s => {
      const id = s._id || s.id;
      const name = s.info?.name || s.name || 'Без назви';
      return [Markup.button.callback(name, `svc:${id}`)];
    });
    await ctx.reply('Оберіть послугу:', Markup.inlineKeyboard(buttons));
  } catch (e) {
    console.error('services error:', e?.response?.data || e?.message || e);
    ctx.reply('Не вдалось отримати список послуг.');
  }
});

// При выборе услуги — показываем календарь на 7 дней
bot.action(/^svc:(.+)$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    await ctx.answerCbQuery();

    const today = new Date(); // UTC ок, т.к. к Wix шлём ISO
    const todayYMD = toYMD(today);

    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
      const ymd = toYMD(d);
      return { ymd, label: dayLabel(d, todayYMD) };
    });

    // делаем клавиатуру 2 колонки
    const rows = [];
    for (let i = 0; i < days.length; i += 2) {
      const row = [];
      for (let j = i; j < Math.min(i + 2, days.length); j++) {
        row.push(Markup.button.callback(days[j].label, `day:${serviceId}:${days[j].ymd}`));
      }
      rows.push(row);
    }
    rows.push([Markup.button.callback('↩️ Назад до послуг', 'back:services')]);

    await ctx.editMessageText('Оберіть день:', Markup.inlineKeyboard(rows));
  } catch (e) {
    console.error('svc action error:', e?.message || e);
    await ctx.reply('Сталася помилка. Спробуйте ще раз.');
  }
});

bot.action('back:services', async (ctx) => {
  // заменим сообщение на список услуг
  return bot.hears.handlers.get('🗂 Послуги')[0](ctx);
});

// Выбрали день — грузим слоты и показываем
bot.action(/^day:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    const ymd = ctx.match[2];
    await ctx.answerCbQuery();

    const from = startOfUTC(ymd).toISOString();
    const to = endOfUTC(ymd).toISOString();

    const j = await restQueryAvailability({ serviceId, from, to });
    const slots = j?.slots || j?.availability?.slots || [];

    if (!slots.length) {
      return ctx.editMessageText('Немає доступних слотів на цю дату.', Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ До календаря', `svc:${serviceId}`)],
      ]));
    }

    const btns = slots.slice(0, 12).map(s => {
      const start = (s.startTime || s.slot?.startTime || '').slice(11, 16);
      const end   = (s.endTime   || s.slot?.endTime   || '').slice(11, 16);
      const slotId = s.slot?.id || s.id || s.slotId;
      return [Markup.button.callback(`${start} → ${end}`, `pick:${serviceId}:${ymd}:${slotId}`)];
    });

    btns.push([Markup.button.callback('⬅️ До календаря', `svc:${serviceId}`)]);
    await ctx.editMessageText(`Дата: ${ymd}\nОберіть час:`, Markup.inlineKeyboard(btns));
  } catch (e) {
    console.error('day action error:', e?.message || e);
    await ctx.reply('Не вдалось отримати слоти на обрану дату.');
  }
});

// Выбрали слот — просим имя, потом телефон, потом создаём бронь
bot.action(/^pick:(.+):(\d{4}-\d{2}-\d{2}):(.+)$/, async (ctx) => {
  try {
    const [_, serviceId, ymd, slotId] = ctx.match;
    await ctx.answerCbQuery();
    sessions.set(ctx.from.id, { serviceId, dateYMD: ymd, slotId, step: 'name' });
    await ctx.reply('Введіть ваше імʼя:');
  } catch (e) {
    console.error('pick action error:', e);
    await ctx.reply('Помилка вибору слоту.');
  }
});

bot.on('text', async (ctx) => {
  const s = sessions.get(ctx.from.id);
  if (!s?.step) return;

  try {
    if (s.step === 'name') {
      s.name = ctx.message.text.trim();
      s.step = 'phone';
      return ctx.reply('Введіть ваш номер телефону у форматі +380...');
    }

    if (s.step === 'phone') {
      const phone = ctx.message.text.trim();
      if (!/^\+?\d{10,15}$/.test(phone)) {
        return ctx.reply('Телефон має бути у форматі +380XXXXXXXXX (10–15 цифр).');
      }
      s.phone = phone;

      // создаём бронь (SDK)
      const r = await wix.bookings.createBooking({
        booking: {
          slot: { slotId: s.slotId, serviceId: s.serviceId },
          contactDetails: { fullName: s.name || ctx.from.first_name || 'Guest', phone: s.phone },
          participants: 1,
        },
      });

      const id = r?.booking?._id || r?.booking?.id || '—';
      sessions.delete(ctx.from.id);
      return ctx.reply(`✅ Бронювання створено!\nID: ${id}\nДата: ${s.dateYMD}`);
    }
  } catch (e) {
    console.error('booking error:', e?.response?.data || e);
    sessions.delete(ctx.from.id);
    return ctx.reply('Не вдалось створити бронь. Спробуйте інший слот.');
  }
});

// ================== HTTP (диагностика) ==================
app.get('/', (_, res) => res.send('ok — /health, /debug/services, використовуйте бота у Telegram'));
app.get('/health', (_, res) => res.send('ok'));
app.get('/debug/services', async (_, res) => {
  try {
    const items = await getServices();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message || e });
  }
});

app.use(bot.webhookCallback(`/tg/${BOT_TOKEN}`));

// ================== START ==================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  try {
    const url = `${PUBLIC_URL}/tg/${BOT_TOKEN}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook set to', url);
  } catch (e) {
    console.error('Webhook set error:', e?.response?.data || e);
  }
  console.log('Server listening on', PORT);
});
