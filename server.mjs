// server.mjs — Telegram бот для бронювання з календарем дат (Admin API Key)

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, ApiKeyStrategy } from '@wix/sdk';
import { services as servicesApi, bookings as bookingsApi } from '@wix/bookings';

// ================== ENV sanity ==================
const REQ_ENV = ['BOT_TOKEN', 'ADMIN_API_KEY', 'SITE_ID', 'PUBLIC_URL'];
REQ_ENV.forEach(k => { if (!process.env[k]) console.error(`ENV ${k} is missing`); });

const BOT_TOKEN    = process.env.BOT_TOKEN;
const ADMIN_API_KEY= process.env.ADMIN_API_KEY;
const SITE_ID      = process.env.SITE_ID;
const PUBLIC_URL   = process.env.PUBLIC_URL;
const TIMEZONE     = process.env.TIMEZONE || 'Europe/Kyiv';

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

// Services — SDK → REST fallback
async function restQueryServices() {
  const r = await fetch('https://www.wixapis.com/bookings/v1/services/query', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ query: {} }),
  });
  if (!r.ok) throw new Error(`services ${r.status}: ${await r.text()}`);
  return r.json(); // { services: [...] }
}

// !!! FIXED: startDate/endDate у filter
async function restQueryAvailability({ serviceId, startDate, endDate }) {
  const r = await fetch('https://www.wixapis.com/bookings/v1/availability/query', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      query: {
        filter: {
          serviceId,
          startDate,
          endDate,
          timeZone: TIMEZONE, // деякі інсталяції очікують у filter
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`availability ${r.status}: ${await r.text()}`);
  return r.json(); // { slots: [...] } (або availability.slots)
}

async function getServices() {
  try {
    const resp = await wix.services.queryServices().find();
    return resp?.items ?? [];
  } catch {
    const j = await restQueryServices();
    return j?.services ?? j?.items ?? [];
  }
}

// ================== ДАТИ/ФОРМАТИ ==================
const RU_DAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const UA_MONTHS_SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'сер', 'вер', 'жовт', 'лис', 'груд'];

function pad2(n) { return n.toString().padStart(2, '0'); }
function toYMD(d) { return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
function dayLabel(d, todayYMD) {
  const ymd = toYMD(d);
  if (ymd === todayYMD) return 'Сьогодні';
  const wd = RU_DAYS[d.getUTCDay()];
  return `${wd} ${d.getUTCDate()} ${UA_MONTHS_SHORT[d.getUTCMonth()]}`;
}
function startOfUTC(ymd) { return new Date(`${ymd}T00:00:00.000Z`); }
function endOfUTC(ymd)   { return new Date(`${ymd}T23:59:59.999Z`); }

// ================== Telegram bot ==================
const bot = new Telegraf(BOT_TOKEN);

// Прості “сесії” в памʼяті процеса
const sessions = new Map(); // userId => { serviceId, dateYMD, slotId, step, name, phone }

bot.start((ctx) =>
  ctx.reply('Привіт! Оберіть дію:', Markup.keyboard([['🗂 Послуги']]).resize())
);

// Послуги -> інлайн кнопки
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

// Обрали послугу — календар на 7 днів
bot.action(/^svc:(.+)$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    await ctx.answerCbQuery();

    const today = new Date();
    const todayYMD = toYMD(today);

    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
      const ymd = toYMD(d);
      return { ymd, label: dayLabel(d, todayYMD) };
    });

    const rows = [];
    for (let i = 0; i < days.length; i += 2) {
      rows.push(days.slice(i, i + 2).map(x => Markup.button.callback(x.label, `day:${serviceId}:${x.ymd}`)));
    }
    rows.push([Markup.button.callback('↩️ Назад до послуг', 'back:services')]);

    await ctx.editMessageText('Оберіть день:', Markup.inlineKeyboard(rows));
  } catch (e) {
    console.error('svc action error:', e?.message || e);
    await ctx.reply('Сталася помилка. Спробуйте ще раз.');
  }
});

bot.action('back:services', async (ctx) => {
  // повернення до списку послуг
  return bot.hears.handlers.get('🗂 Послуги')[0](ctx);
});

// Обрали день — тягнемо слоти
bot.action(/^day:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    const ymd = ctx.match[2];
    await ctx.answerCbQuery();

    const startDate = startOfUTC(ymd).toISOString();
    const endDate   = endOfUTC(ymd).toISOString();

    const j = await restQueryAvailability({ serviceId, startDate, endDate });
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

// Обрали слот — імʼя -> телефон -> бронь
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

// ================== HTTP (діагностика) ==================
app.get('/', (_, res) => res.send('ok — /health, /debug/services'));
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
