// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(express.json());

// === ENV ===
const TOKEN = process.env.BOT_TOKEN;
const CHAT  = process.env.CHAT_ID;
const TZ    = 'Europe/Kyiv';

const SEND_STATUSES = (process.env.SEND_STATUSES || 'APPROVED,CONFIRMED')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

const EVENT_TTL_MS = Number(process.env.EVENT_TTL_MS || 15 * 60 * 1000);
const seen = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
}, Math.min(EVENT_TTL_MS, 60_000)).unref();

const handledMessages = new Set(); // `${chatId}:${messageId}`

// === Utils ===
function markSeen(key){ seen.set(key, Date.now() + EVENT_TTL_MS); }
function isDuplicate(key){ return seen.has(key); }

function md(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleString('uk-UA', { timeZone: TZ }); }
  catch { return String(d); }
}

function toNumber(v){ const n = Number(v); return Number.isFinite(n) ? n : 0; }

function fmtMoney(value, currency = 'UAH') {
  const num = toNumber(value);
  try { return new Intl.NumberFormat('uk-UA', { style: 'currency', currency }).format(num); }
  catch { return `${num} ${currency}`; }
}

async function tg(method, payload) {
  const url = `https://api.telegram.org/bot${TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) {
    throw new Error(`TG ${method} failed: ${res.status} ${json?.description || ''}`);
  }
  return json.result;
}

async function sendBookingMessage(text, orderNo) {
  if (!TOKEN || !CHAT) throw new Error('BOT_TOKEN/CHAT_ID not set');
  const chats = String(CHAT).split(',').map(s => s.trim()).filter(Boolean);
  const results = [];
  for (const chat_id of chats) {
    const r = await tg('sendMessage', {
      chat_id,
      text,
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Підтверджено', callback_data: `approve:${orderNo || ''}` },
          { text: '❌ Відхилено',   callback_data: `reject:${orderNo || ''}`  }
        ]]
      }
    });
    results.push({ chat_id, message_id: r.message_id });
  }
  return results;
}

function buildEventKey(req, data) {
  const hdrId = req.headers['x-wix-event-id'] || req.headers['wix-event-id'];
  if (hdrId) return `hdr:${hdrId}`;
  const base =
    data?.id ||
    data?.booking_id ||
    data?.order_number ||
    JSON.stringify({
      service: data?.service_name_main_language || data?.service_name,
      start: data?.start_date_by_business_tz || data?.start_date,
      end: data?.end_date,
      staff: data?.staff_member_name || data?.staff_member_name_main_language,
      price: data?.price?.value,
      remain: data?.remaining_amount_due?.value
    });
  return 'hash:' + crypto.createHash('sha256').update(String(base)).digest('hex').slice(0, 32);
}

function formatActor(from = {}) {
  const nameParts = [from.first_name, from.last_name].filter(Boolean).join(' ').trim();
  if (nameParts && from.username) return `${nameParts} @${from.username}`;
  if (nameParts) return nameParts;
  if (from.username) return `@${from.username}`;
  if (from.id) return `id:${from.id}`;
  return 'невідомо';
}

// === Health ===
app.get('/', (_req, res) => res.send('OK'));

// === Wix webhook: /booking ===
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!(data && (data.service_name || data.service_name_main_language))) {
      return res.status(200).json({ ok: true });
    }

    const key = buildEventKey(req, data);
    if (isDuplicate(key)) return res.status(200).json({ ok: true, dedup: true });
    markSeen(key);

    const status = (data?.status || data?.booking_status || '').toString().toUpperCase();
    if (SEND_STATUSES.length && status && !SEND_STATUSES.includes(status)) {
      return res.status(200).json({ ok: true, skippedStatus: status });
    }

    const service = data.service_name_main_language || data.service_name || '';
    const sector  = data.staff_member_name || data.staff_member_name_main_language || '';
    const start   = fmtDate(data.start_date_by_business_tz || data.start_date);
    const end     = fmtDate(data.end_date);

    const currency =
      data?.price?.currency ||
      data?.remaining_amount_due?.currency ||
      data?.currency ||
      'UAH';

    let totalVal = null;
    if (data?.price?.value != null) totalVal = toNumber(data.price.value);
    else if (data?.total_amount?.value != null) totalVal = toNumber(data.total_amount.value);
    else if (data?.amount_due != null) totalVal = toNumber(data.amount_due);

    const paidVal =
      data?.amount_paid?.value != null ? toNumber(data.amount_paid.value)
      : data?.paid_amount?.value != null ? toNumber(data.paid_amount.value)
      : 0;

    let remainingVal = 0;
    if (data?.remaining_amount_due?.value != null) {
      remainingVal = toNumber(data.remaining_amount_due.value);
    } else if (totalVal != null) {
      remainingVal = Math.max(toNumber(totalVal) - toNumber(paidVal), 0);
    }

    const amountTotal = totalVal != null ? fmtMoney(totalVal, currency) : '';
    const amountDue   = fmtMoney(remainingVal, currency);

    const name    = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
    const phone   = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '';
    const orderNo = data.order_number || '';

    const lines = [
      `📢 *Нове бронювання*`,
      `━━━━━━━━━━━━━━`,
      orderNo ? `🧾 Номер замовлення: *${md(orderNo)}*` : null,
      service ? `🎣 Послуга: *${md(service)}*` : null,
      sector  ? `🏝 Сектор: *${md(sector)}*` : null,
      `📅 Початок: *${md(start)}*`,
      `🏁 Кінець: *${md(end)}*`,
      amountTotal ? `💰 Сума замовлення: *${md(amountTotal)}*` : null,
      `💳 Залишок до оплати: *${md(amountDue)}*`,
      ``,
      name  ? `👤 Клієнт: *${md(name)}*` : null,
      phone ? `📞 Телефон: ${md(phone)}` : null
    ].filter(Boolean).join('\n');

    await sendBookingMessage(lines, orderNo);
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Помилка /booking:', e?.message || e);
    res.status(200).json({ ok: false, error: e?.message || 'unknown' });
  }
});

// === Telegram webhook: /telegram ===
app.post('/telegram', async (req, res) => {
  try {
    const update = req.body;
    if (!update?.callback_query) return res.sendStatus(200);

    const cq     = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const msgId  = cq.message?.message_id;
    const [action, orderNo] = (cq.data || '').split(':'); // approve:123

    if (!chatId || !msgId) return res.sendStatus(200);

    const key = `${chatId}:${msgId}`;
    if (handledMessages.has(key)) {
      await tg('answerCallbackQuery', { callback_query_id: cq.id });
      return res.sendStatus(200);
    }
    handledMessages.add(key);

    // убираем клавиатуру
    await tg('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: { inline_keyboard: [] }
    });

    // кто нажал
    const actor = formatActor(cq.from);
    const resultLine = (action === 'approve')
      ? `✅ Підтверджено (замовлення ${orderNo || '?'}, від ${actor})`
      : `❌ Відхилено (замовлення ${orderNo || '?'}, від ${actor})`;

    await tg('sendMessage', {
      chat_id: chatId,
      text: resultLine,
      reply_to_message_id: msgId,
      allow_sending_without_reply: true
    });

    await tg('answerCallbackQuery', { callback_query_id: cq.id });
    res.sendStatus(200);
  } catch (e) {
    console.error('Помилка /telegram:', e?.message || e);
    res.sendStatus(200);
  }
});

// === Start ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
