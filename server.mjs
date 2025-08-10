import express from 'express';
import fetch from 'node-fetch';
import { Telegraf, Markup, session } from 'telegraf';

// ==== ENV ====
const {
  BOT_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  WIX_REFRESH_TOKEN,
  PUBLIC_URL,
  PORT = 3000,
} = process.env;

if (!BOT_TOKEN || !CLIENT_ID || !CLIENT_SECRET || !WIX_REFRESH_TOKEN || !PUBLIC_URL) {
  console.error('Missing required env vars. Need BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, WIX_REFRESH_TOKEN, PUBLIC_URL');
  process.exit(1);
}

// ==== TELEGRAM ====
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// Нижние кнопки
const mainMenu = Markup.keyboard([
  [Markup.button.text('📦 Послуги'), Markup.button.text('🗓️ Забронювати')],
]).resize();

// ==== Wix Admin OAuth (client-credentials via refresh token) ====
let _cachedAccessToken = null;
let _tokenExp = 0;

async function getAccessToken() {
  const now = Date.now();
  if (_cachedAccessToken && now < _tokenExp - 30_000) return _cachedAccessToken;

  const url = 'https://www.wixapis.com/oauth/access';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}` },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: WIX_REFRESH_TOKEN })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`OAuth ${res.status}: ${t}`);
  }
  const json = await res.json();
  _cachedAccessToken = json.access_token;
  _tokenExp = Date.now() + (json.expires_in * 1000);
  return _cachedAccessToken;
}

async function wixFetch(path, body) {
  const token = await getAccessToken();
  const res = await fetch(`https://www.wixapis.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token,
      'wix-site-id': '', // не обязателен для Admin API
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text}`);
  return json;
}

// ==== Bookings helpers ====
// Наши 2 услуги (название → id). Можешь поменять id на свои при желании.
const SERVICES = [
  { id: 'f34a76af-3072-44ca-b217-bb570e5cf297', title: 'Риболовля "Доба"' },      // Full day
  { id: '7fab746c-0926-4157-be80-5ec252f58b11', title: 'Риболовля "Пів доби"' }, // Half day
];

// Получить доступность (availability v2) для диапазона дат, опционально по сектору
async function queryAvailability({ serviceId, startISO, endISO, tz = 'Europe/Kiev', resourceIds = [] }) {
  const body = {
    query: {
      filter: {
        serviceId,
        timeZone: tz,
        startDate: startISO,
        endDate: endISO,
        capacity: { min: 1 }, // минимум 1 место
      }
    }
  };
  if (resourceIds.length) {
    body.query.filter.resource = { ids: resourceIds };
  }
  return wixFetch('/bookings/v1/availability/query', body);
}

// Собираем список «секторов» (resourceId → name) из ближайшей доступности на 30 дней
async function collectSectorsFromAvailability(serviceId) {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + 30);

  const tz = 'Europe/Kiev';
  const startISO = start.toISOString();
  const endISO = end.toISOString();

  const avail = await queryAvailability({ serviceId, startISO, endISO, tz });
  const map = new Map();
  const entries = avail.availabilityEntries || [];
  for (const e of entries) {
    const r = e.slot?.resource;
    if (r?.id && r?.name) map.set(r.id, r.name);
  }
  return Array.from(map, ([id, name]) => ({ id, name })).sort((a,b) => a.name.localeCompare(b.name, 'uk'));
}

// Получить все слоты для конкретного дня и сектора
async function daySlots({ serviceId, sectorId, dateStr, tz='Europe/Kiev' }) {
  const day = new Date(`${dateStr}T00:00:00`);
  const startISO = new Date(day.getTime() - day.getTimezoneOffset()*60000).toISOString(); // UTC начала дня
  const endISO = new Date(day.getTime() + (24*60*60*1000) - day.getTimezoneOffset()*60000).toISOString();

  const avail = await queryAvailability({ serviceId, startISO, endISO, tz, resourceIds: [sectorId] });
  const entries = avail.availabilityEntries || [];
  // Фильтруем на открытые слоты
  const open = entries.filter(e => e.bookable && (e.openSpots ?? 0) > 0);
  // Вернём времена старта (локальные)
  const times = open.map(e => {
    const startZ = e.slot?.startDate;
    const d = startZ ? new Date(startZ) : null;
    if (!d) return null;
    const hh = `${d.getHours()}`.padStart(2,'0');
    const mm = `${d.getMinutes()}`.padStart(2,'0');
    return `${hh}:${mm}`;
  }).filter(Boolean);

  // Уникальные и отсортированные
  return Array.from(new Set(times)).sort((a,b)=>a.localeCompare(b));
}

// ==== ТГ сценарий брони (простая FSM в session) ====
const FLOW = {
  IDLE: 'IDLE',
  PICK_SERVICE: 'PICK_SERVICE',
  PICK_SECTOR: 'PICK_SECTOR',
  PICK_DATE: 'PICK_DATE',
  SHOW_TIMES: 'SHOW_TIMES',
};

function resetFlow(ctx) {
  ctx.session.flow = {
    step: FLOW.IDLE,
    serviceId: null,
    serviceTitle: null,
    sectorId: null,
    sectorName: null,
    date: null,
  };
}

bot.start(async (ctx) => {
  resetFlow(ctx);
  await ctx.reply('Привіт! Оберіть дію:', mainMenu);
});

bot.hears('📦 Послуги', async (ctx) => {
  // Просто показать список услуг
  const list = SERVICES.map(s => `• ${s.title} — ${s.id}`).join('\n');
  await ctx.reply(`Доступні послуги:\n${list}\n\nНадішли /slots <SERVICE_ID> <YYYY-MM-DD> щоб побачити слоти на дату.`, mainMenu);
});

bot.hears('🗓️ Забронювати', async (ctx) => {
  resetFlow(ctx);
  ctx.session.flow.step = FLOW.PICK_SERVICE;

  await ctx.reply(
    'Оберіть тип послуги:',
    Markup.inlineKeyboard(
      SERVICES.map(s => [Markup.button.callback(s.title, `srv:${s.id}`)])
    )
  );
});

// Выбор услуги
bot.action(/srv:(.+)/, async (ctx) => {
  if (!ctx.session.flow || ctx.session.flow.step !== FLOW.PICK_SERVICE) return;
  const serviceId = ctx.match[1];
  const srv = SERVICES.find(s => s.id === serviceId);
  ctx.session.flow.serviceId = serviceId;
  ctx.session.flow.serviceTitle = srv?.title || 'Послуга';
  ctx.session.flow.step = FLOW.PICK_SECTOR;

  await ctx.answerCbQuery();
  await ctx.editMessageText(`Послуга: ${ctx.session.flow.serviceTitle}\nШукаю доступні сектори…`);

  try {
    const sectors = await collectSectorsFromAvailability(serviceId);
    if (!sectors.length) {
      await ctx.reply('На найближчі 30 днів вільних секторів не знайдено. Спробуйте іншу дату/послугу.', mainMenu);
      resetFlow(ctx);
      return;
    }
    // Показать кнопки по 3 в ряд
    const rows = [];
    for (let i = 0; i < sectors.length; i += 3) {
      rows.push(sectors.slice(i, i+3).map(s => Markup.button.callback(s.name, `sec:${s.id}:${encodeURIComponent(s.name)}`)));
    }
    await ctx.reply('Оберіть сектор:', Markup.inlineKeyboard(rows));
  } catch (e) {
    console.error('collectSectors error', e);
    await ctx.reply('Не вдалося отримати сектори. Спробуйте пізніше.', mainMenu);
    resetFlow(ctx);
  }
});

// Выбор сектора
bot.action(/sec:([^:]+):(.+)/, async (ctx) => {
  if (!ctx.session.flow || ctx.session.flow.step !== FLOW.PICK_SECTOR) return;
  const sectorId = ctx.match[1];
  const sectorName = decodeURIComponent(ctx.match[2]);

  ctx.session.flow.sectorId = sectorId;
  ctx.session.flow.sectorName = sectorName;
  ctx.session.flow.step = FLOW.PICK_DATE;

  await ctx.answerCbQuery();
  await ctx.reply(
    `Сектор: ${sectorName}\nВведіть дату у форматі YYYY-MM-DD або натисніть «До календаря».`,
    Markup.keyboard([[Markup.button.text('📅 До календаря')]]).oneTime().resize()
  );
});

// Поддержка «До календаря» — просто подсказка
bot.hears('📅 До календаря', async (ctx) => {
  if (!ctx.session.flow || ctx.session.flow.step !== FLOW.PICK_DATE) return;
  await ctx.reply('Надішліть дату, наприклад: 2025-08-15');
});

// Ввод даты текстом
bot.on('text', async (ctx) => {
  // Обрабатываем только, если мы в шаге ввода даты
  if (!ctx.session.flow || ctx.session.flow.step !== FLOW.PICK_DATE) {
    return; // игнорируем лишние сообщения
  }
  const txt = (ctx.message.text || '').trim();
  // Простой валидатор даты
  if (!/^\d{4}-\d{2}-\d{2}$/.test(txt)) {
    await ctx.reply('Введіть дату у форматі YYYY-MM-DD, наприклад: 2025-08-15');
    return;
  }

  ctx.session.flow.date = txt;
  ctx.session.flow.step = FLOW.SHOW_TIMES;

  const { serviceId, sectorId, sectorName } = ctx.session.flow;
  await ctx.reply(`Шукаю вільні часи старту для ${sectorName} на ${txt}…`);

  try {
    const times = await daySlots({ serviceId, sectorId, dateStr: txt });
    if (!times.length) {
      await ctx.reply('Немає доступних слотів на цю дату. Оберіть іншу дату або сектор.', mainMenu);
      resetFlow(ctx);
      return;
    }

    // Кнопки со временами (по 4 в ряд)
    const rows = [];
    for (let i = 0; i < times.length; i += 4) {
      rows.push(times.slice(i, i+4).map(t => Markup.button.callback(t, `tm:${t}`)));
    }
    await ctx.reply('Доступні часи початку:', Markup.inlineKeyboard(rows));
  } catch (e) {
    console.error('daySlots error', e);
    await ctx.reply('Не вдалося отримати слоти. Спробуйте пізніше.', mainMenu);
    resetFlow(ctx);
  }
});

// Клик по времени — пока просто подтверждаем выбор
bot.action(/tm:(.+)/, async (ctx) => {
  if (!ctx.session.flow || ctx.session.flow.step !== FLOW.SHOW_TIMES) return;
  const time = ctx.match[1];
  const { serviceTitle, sectorName, date } = ctx.session.flow;

  await ctx.answerCbQuery();
  // Здесь можно продолжить: запросить контакт/ім’я, створити booking через Admin API.
  await ctx.reply(
    `Обрано:\n• Послуга: ${serviceTitle}\n• Сектор: ${sectorName}\n• Дата: ${date}\n• Час старту: ${time}\n\n(Далі — оформлення бронювання, додамо за потреби)`,
    mainMenu
  );
  resetFlow(ctx);
});

// ==== Команда /slots (ручная проверка) ====
bot.command('slots', async (ctx) => {
  const parts = ctx.message.text.split(/\s+/);
  // /slots <serviceId> [yyyy-mm-dd]
  const serviceId = parts[1];
  const date = parts[2] || new Date().toISOString().slice(0,10);

  if (!serviceId) {
    await ctx.reply('Використання: /slots <SERVICE_ID> [YYYY-MM-DD]');
    return;
  }
  try {
    // соберём все секторы из ближайших 30 днів, і для вибраної дати покажемо, де є хоч один слот
    const sectors = await collectSectorsFromAvailability(serviceId);
    if (!sectors.length) {
      await ctx.reply('Немає доступних секторів в найближчі 30 днів.');
      return;
    }

    const findings = [];
    for (const s of sectors) {
      const times = await daySlots({ serviceId, sectorId: s.id, dateStr: date });
      if (times.length) findings.push(`• ${s.name}: ${times.slice(0,8).join(', ')}${times.length>8?'…':''}`);
    }
    if (!findings.length) {
      await ctx.reply(`Немає слотів на ${date}.`);
      return;
    }
    await ctx.reply(`Вільні на ${date}:\n${findings.join('\n')}`);
  } catch (e) {
    console.error('/slots error', e);
    await ctx.reply('Помилка при отриманні слотів.');
  }
});

// ==== EXPRESS + WEBHOOK ====
const app = express();
app.use(express.json());

// health
app.get('/', (_req, res) => res.send('OK'));

// debug endpoint: /debug/availability?serviceId=...&ymd=YYYY-MM-DD
app.get('/debug/availability', async (req, res) => {
  try {
    const { serviceId, ymd, tz = 'Europe/Kiev', resourceId } = req.query;
    if (!serviceId || !ymd) return res.json({ ok: false, error: 'need serviceId & ymd' });

    const startISO = new Date(`${ymd}T00:00:00Z`).toISOString();
    const endISO = new Date(`${ymd}T23:59:59Z`).toISOString();
    const resourceIds = resourceId ? [String(resourceId)] : [];

    const data = await queryAvailability({ serviceId, startISO, endISO, tz, resourceIds });
    res.json({ ok: true, timezone: tz, start: startISO, end: endISO, raw: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Telegram webhook
app.use(bot.webhookCallback('/tg/webhook'));
await bot.telegram.setWebhook(`${PUBLIC_URL}/tg/webhook`);

app.listen(PORT, () => {
  console.log('Server listening on', PORT);
  console.log('==> Your service is live 🎉');
  console.log(`==> Available at your primary URL ${PUBLIC_URL}`);
  console.log('==> ///////////////////////////////////////////////////////////////');
});
