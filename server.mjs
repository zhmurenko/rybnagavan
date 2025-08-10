// server.mjs — Telegram-бот бронирования (Wix Admin API Key) с поддержкой таймзоны Europe/Kiev и DST

import 'dotenv/config';
import express from 'express';
import { Telegraf, Markup } from 'telegraf';
import { createClient, ApiKeyStrategy } from '@wix/sdk';
import { services as servicesApi, bookings as bookingsApi } from '@wix/bookings';

// ------------ ENV ------------
const MUST = ['BOT_TOKEN', 'ADMIN_API_KEY', 'SITE_ID', 'PUBLIC_URL'];
MUST.forEach(k => { if (!process.env[k]) console.error(`ENV ${k} is missing`); });

const BOT_TOKEN     = process.env.BOT_TOKEN;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const SITE_ID       = process.env.SITE_ID;
const PUBLIC_URL    = process.env.PUBLIC_URL;
const PORT          = process.env.PORT || 3000;

// Таймзона аккаунта (для человека): Europe/Kiev (Wix понимает именно Kiev)
const TIMEZONE      = process.env.TIMEZONE || 'Europe/Kiev';

const app = express();
app.use(express.json());

// ------------ Wix SDK (Admin API Key) ------------
const wix = createClient({
  modules: { services: servicesApi, bookings: bookingsApi },
  auth: ApiKeyStrategy({ siteId: SITE_ID, apiKey: ADMIN_API_KEY }),
});

// ------------ REST helpers (services / availability) ------------
const baseHeaders = {
  'Content-Type': 'application/json',
  Authorization: ADMIN_API_KEY,
  'wix-site-id': SITE_ID,
};

async function restQueryServices() {
  const r = await fetch('https://www.wixapis.com/bookings/v1/services/query', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({ query: {} }),
  });
  if (!r.ok) throw new Error(`services ${r.status}: ${await r.text()}`);
  return r.json(); // { services: [...] }
}

/**
 * availability: filter.startDate/endDate — ISO с нужным смещением (+02:00 / +03:00).
 * Никакого timeZone в фильтре НЕ передаём.
 */
async function restQueryAvailability({ serviceId, startDate, endDate }) {
  const r = await fetch('https://www.wixapis.com/bookings/v1/availability/query', {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      query: { filter: { serviceId, startDate, endDate } },
    }),
  });
  if (!r.ok) throw new Error(`availability ${r.status}: ${await r.text()}`);
  return r.json(); // { slots: [...] } или { availability: { slots: [...] } }
}

// Унифицированный геттер услуг
async function getServices() {
  try {
    const resp = await wix.services.queryServices().find();
    return resp?.items ?? [];
  } catch {
    const j = await restQueryServices();
    return j?.services ?? j?.items ?? [];
  }
}

// ------------ утилиты дат ------------
const RU_DAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const UA_MONTHS_SHORT = ['січ', 'лют', 'бер', 'квіт', 'трав', 'черв', 'лип', 'сер', 'вер', 'жовт', 'лис', 'груд'];
const pad2 = n => String(n).padStart(2, '0');

function toYMD(d) {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function dayLabel(d, todayYMD) {
  const ymd = toYMD(d);
  if (ymd === todayYMD) return 'Сьогодні';
  return `${RU_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${UA_MONTHS_SHORT[d.getUTCMonth()]}`;
}

/**
 * DST для Europe/Kiev:
 *   Летнее время действует с последнего воскресенья марта 03:00 до последнего воскресенья октября 04:00.
 *   Зимой offset +02:00, летом +03:00.
 */
function lastSunday(year, monthIndex /* 0-based */) {
  // Возвращает дату последнего воскресенья указанного месяца (UTC)
  const d = new Date(Date.UTC(year, monthIndex + 1, 0)); // последний день месяца
  const dow = d.getUTCDay(); // 0..6 (вс..сб)
  const back = (dow + 7 - 0) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d; // UTC дата-воскресенье
}
function isKievSummerTime(ymd /* 'YYYY-MM-DD' */) {
  const [y, m, day] = ymd.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1, day, 12, 0, 0)); // середина дня, чтобы не попадать на край
  const marchLastSun = lastSunday(y, 2);   // март
  const octLastSun   = lastSunday(y, 9);   // октябрь

  // Летнее время: от 03:00 последнего воскресенья марта до 04:00 последнего воскресенья октября
  const start = new Date(Date.UTC(y, 2, marchLastSun.getUTCDate(), 0, 0, 0)); // сравниваем по дням
  const end   = new Date(Date.UTC(y, 9, octLastSun.getUTCDate(), 0, 0, 0));

  return d >= start && d < end; // в простом «по дням» сравнении достаточно
}
function offsetForKiev(ymd) {
  return isKievSummerTime(ymd) ? '+03:00' : '+02:00';
}
function dayBoundsWithOffset(ymd, tz = TIMEZONE) {
  // пока поддерживаем именно Europe/Kiev (или совместимые), при необходимости можно расширить
  const off = tz === 'Europe/Kiev' ? offsetForKiev(ymd) : '+00:00';
  return {
    start: `${ymd}T00:00:00${off}`,
    end:   `${ymd}T23:59:59${off}`,
  };
}

// ------------ Telegram bot ------------
const bot = new Telegraf(BOT_TOKEN);

// простейшая «сессия» в памяти процесса
const sessions = new Map(); // userId -> { serviceId, dateYMD, slotId, step, name, phone }

bot.start(ctx =>
  ctx.reply('Привіт! Оберіть дію:', Markup.keyboard([['🗂 Послуги']]).resize())
);

// список услуг
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

// выбор даты (7 дней)
bot.action(/^svc:(.+)$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    await ctx.answerCbQuery();

    const today = new Date();
    const todayYMD = toYMD(today);
    const days = [...Array(7)].map((_, i) => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + i));
      return { ymd: toYMD(d), label: dayLabel(d, todayYMD) };
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
  return bot.hears.handlers.get('🗂 Послуги')[0](ctx);
});

// загрузка слотов выбранного дня
bot.action(/^day:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
  try {
    const serviceId = ctx.match[1];
    const ymd = ctx.match[2];
    await ctx.answerCbQuery();

    const { start, end } = dayBoundsWithOffset(ymd, TIMEZONE);

    const j = await restQueryAvailability({ serviceId, startDate: start, endDate: end });
    const slots = j?.slots || j?.availability?.slots || [];

    if (!slots.length) {
      return ctx.editMessageText('Немає доступних слотів на цю дату.', Markup.inlineKeyboard([
        [Markup.button.callback('⬅️ До календаря', `svc:${serviceId}`)],
      ]));
    }

    const btns = slots.slice(0, 12).map(s => {
      const startT = (s.startTime || s.slot?.startTime || '').slice(11, 16);
      const endT   = (s.endTime   || s.slot?.endTime   || '').slice(11, 16);
      const slotId = s.slot?.id || s.id || s.slotId;
      return [Markup.button.callback(`${startT} → ${endT}`, `pick:${serviceId}:${ymd}:${slotId}`)];
    });

    btns.push([Markup.button.callback('⬅️ До календаря', `svc:${serviceId}`)]);
    await ctx.editMessageText(`Дата: ${ymd}\nОберіть час:`, Markup.inlineKeyboard(btns));
  } catch (e) {
    console.error('day action error:', e?.message || e);
    await ctx.reply('Не вдалось отримати слоти на обрану дату.');
  }
});

// выбор слота -> имя/телефон -> createBooking
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

// ------------ HTTP (health/debug) ------------
app.get('/',        (_, res) => res.send('ok — /health, /debug/services, /debug/availability'));
app.get('/health',  (_, res) => res.send('ok'));
app.get('/debug/services', async (_, res) => {
  try {
    const items = await getServices();
    res.json({ ok: true, count: items.length, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message || e });
  }
});

// /debug/availability?serviceId=<ID>&ymd=YYYY-MM-DD[&tz=Europe/Kiev]
app.get('/debug/availability', async (req, res) => {
  try {
    const { serviceId, ymd, tz } = req.query;
    if (!serviceId || !ymd) return res.status(400).json({ ok: false, error: 'serviceId and ymd are required' });
    const tzz = typeof tz === 'string' ? tz : TIMEZONE;
    const { start, end } = dayBoundsWithOffset(String(ymd), tzz);
    const j = await restQueryAvailability({ serviceId: String(serviceId), startDate: start, endDate: end });
    res.json({ ok: true, timezone: tzz, start, end, raw: j });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.response?.data || e?.message || e });
  }
});

// webhook для Telegram
app.use(bot.webhookCallback(`/tg/${BOT_TOKEN}`));

// ------------ START ------------
app.listen(PORT, async () => {
  try {
    const url = `${PUBLIC_URL}/tg/${BOT_TOKEN}`;
    await bot.telegram.setWebhook(url);
    console.log('Webhook set to', url);
  } catch (e) {
    console.error('Webhook set error:', e?.response?.data || e);
  }
  console.log('Server listening on', PORT, 'TIMEZONE =', TIMEZONE);
});
