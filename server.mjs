// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import crypto from 'node:crypto';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;                 // Telegram bot token
const CHAT  = process.env.CHAT_ID;                   // Один или несколько chat_id через запятую
const TZ    = 'Europe/Kiev';                         // корректная IANA TZ

// Опциональный фильтр статусов: "APPROVED,CONFIRMED"
// Пусто => не фильтруем
const SEND_STATUSES = (process.env.SEND_STATUSES || 'APPROVED,CONFIRMED')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);

// Идемпотентность: TTL (по умолчанию 15 мин)
const EVENT_TTL_MS = Number(process.env.EVENT_TTL_MS || 15 * 60 * 1000);
const seen = new Map(); // key -> expiresAt
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of seen) if (exp <= now) seen.delete(k);
}, Math.min(EVENT_TTL_MS, 60_000)).unref();

function markSeen(key){ seen.set(key, Date.now() + EVENT_TTL_MS); }
function isDuplicate(key){ return seen.has(key); }

// MarkdownV2 escaping
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

async function sendToTelegram(text) {
  if (!TOKEN || !CHAT) {
    console.error('❌ Укажи BOT_TOKEN и CHAT_ID в .env');
    return;
  }
  const chats = String(CHAT).split(',').map(s => s.trim()).filter(Boolean);
  for (const chatId of chats) {
    try {
      await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.error(`Помилка надсилання в Telegram (chat ${chatId}):`, e?.message || e);
    }
  }
}

// Строим ключ идемпотентности для webhook
function buildEventKey(req, data) {
  const hdrId = req.headers['x-wix-event-id'] || req.headers['wix-event-id'];
  if (hdrId) return `hdr:${hdrId}`;

  // Стабильные кандидаты из payload
  const base =
    data?.id ||
    data?.booking_id ||
    data?.bookingId ||
    data?.order_number ||
    data?.orderNumber ||
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

// Healthcheck
app.get('/', (_req, res) => res.send('OK'));

/**
 * Вебхук от Wix Bookings
 */
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    const isWixBooking = data && (data.service_name || data.service_name_main_language);
    if (!isWixBooking) return res.status(200).json({ ok: true });

    // ---- ИДЕМПОТЕНТНОСТЬ ----
    const key = buildEventKey(req, data);
    if (isDuplicate(key)) {
      return res.status(200).json({ ok: true, dedup: true });
    }
    markSeen(key);

    // ---- ФИЛЬТР СТАТУСОВ (если задан) ----
    const status = (data?.status || data?.booking_status || '').toString().toUpperCase();
    if (SEND_STATUSES.length && status && !SEND_STATUSES.includes(status)) {
      return res.status(200).json({ ok: true, skippedStatus: status });
    }

    // --------- Поля ---------
    const service = data.service_name_main_language || data.service_name || '';
    const sector  = data.staff_member_name || data.staff_member_name_main_language || '';
    const start   = fmtDate(data.start_date_by_business_tz || data.start_date);
    const end     = fmtDate(data.end_date);

    const currency =
      data?.price?.currency ||
      data?.remaining_amount_due?.currency ||
      data?.currency ||
      'UAH';

    // Total
    let totalVal = null;
    if (data?.price?.value != null) totalVal = toNumber(data.price.value);
    else if (data?.total_amount?.value != null) totalVal = toNumber(data.total_amount.value);
    else if (data?.amount_due != null) totalVal = toNumber(data.amount_due); // fallback

    // Paid
    const paidVal =
      data?.amount_paid?.value != null ? toNumber(data.amount_paid.value)
      : data?.paid_amount?.value != null ? toNumber(data.paid_amount.value)
      : 0;

    // Remaining
    let remainingVal = 0;
    if (data?.remaining_amount_due?.value != null) {
      remainingVal = toNumber(data.remaining_amount_due.value);
    } else if (totalVal != null) {
      remainingVal = Math.max(toNumber(totalVal) - toNumber(paidVal), 0);
    }

    const amountTotal = totalVal != null ? fmtMoney(totalVal, currency) : '';
    const amountDue   = fmtMoney(remainingVal, currency);

    const name  = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
    const phone = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '';

    // --------- Сообщение (укр., без ID/номеров) ---------
    const lines = [
      `📢 *Нове бронювання*`,
      `━━━━━━━━━━━━━━`,
      service ? `🎣 Послуга: *${md(service)}*` : null,
      sector  ? `🏝 Сектор: *${md(sector)}*` : null,
      `📅 Початок: *${md(start)}*`,
      `🏁 Кінець: *${md(end)}*`,
      amountTotal ? `💰 Сума замовлення: *${md(amountTotal)}*` : null,
      `💳 Залишок до оплати: *${md(amountDue)}*`,
      ``,
      name  ? `👤 Клієнт: *${md(name)}*` : null,
      phone ? `📞 Телефон: ${md(phone)}` : null
      // ЖОДНИХ ID/номерів у повідомленні
    ].filter(Boolean).join('\n');

    await sendToTelegram(lines);
    // Быстрый 200 — чтобы Wix не ретраил
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Помилка /booking:', e?.message || e);
    // Чтобы не спровоцировать ретраи Wix, лучше тоже 200
    res.status(200).json({ ok: false, error: e?.message || 'unknown' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
