// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;   // токен Telegram-бота
const CHAT  = process.env.CHAT_ID;     // ID чату/каналу
const TZ    = 'Europe/Kiev';           // часова зона для форматування дат

// Екранування MarkdownV2, щоб не ламались спецсимволи
function md(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('uk-UA', { timeZone: TZ });
}

async function sendToTelegram(text) {
  try {
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Помилка надсилання в Telegram:', e?.message || e);
  }
}

// Проста перевірка живості
app.get('/', (_req, res) => res.send('OK'));

/**
 * Вебхук від Wix.
 * Ігноруємо все, що не схоже на реальний payload Wix Bookings:
 * - має бути payload.data
 * - в data повинно бути щонайменше одне з: service_name / service_name_main_language
 */
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    const isWixBooking =
      data &&
      (data.service_name || data.service_name_main_language);

    if (!isWixBooking) {
      // Тихо ігноруємо будь-що не від Wix (щоб не засмічувати чат)
      return res.status(200).json({ ok: true });
    }

    // --------- Поля з реального Wix payload (приклад, який ти кидав) ---------
    const service   = data.service_name_main_language || data.service_name || '';
    const sector    = data.staff_member_name || data.staff_member_name_main_language || '';
    const start     = fmtDate(data.start_date_by_business_tz || data.start_date);
    const end       = fmtDate(data.end_date);

    // Загальна сума
    // джерело №1: price.value + currency
    // запасне: amount_due (рядок) + currency
    let totalVal = null;
    let currency = 'UAH';
    if (data?.price?.value) {
      totalVal = data.price.value;
      currency = data.price.currency || data.currency || 'UAH';
    } else if (data?.amount_due) {
      totalVal = data.amount_due;
      currency = data.currency || 'UAH';
    }
    const amountTotal = totalVal !== null ? `${totalVal} ${currency}` : '';

    // Залишок до оплати
    // якщо є remaining_amount_due.value — беремо його
    // інакше вважаємо 0 того ж currency
    let amountDue = `0 ${currency}`;
    if (data?.remaining_amount_due?.value !== undefined && data?.remaining_amount_due?.value !== null) {
      const remCur = data.remaining_amount_due.currency || currency;
      amountDue = `${data.remaining_amount_due.value} ${remCur}`;
    }

    const name    = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
    const phone   = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '';
    const orderNo = data.order_number || '';

    // --------- Повідомлення (українською) ---------
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
      name    ? `👤 Клієнт: *${md(name)}*` : null,
      phone   ? `📞 Телефон: ${md(phone)}` : null,
      orderNo ? `🧾 Номер замовлення: *${md(orderNo)}*` : null
    ].filter(Boolean).join('\n');

    await sendToTelegram(lines);
    res.json({ ok: true });
  } catch (e) {
    console.error('Помилка /booking:', e?.message || e);
    res.status(500).json({ ok: false, error: e?.message || 'unknown' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
