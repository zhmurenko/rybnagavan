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

// Екранування під MarkdownV2
function md(text = '') {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('uk-UA', { timeZone: TZ });
}

async function send(text) {
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
}

// Проста перевірка живості
app.get('/', (_req, res) => res.send('OK'));

// Вебхук від Wix — шлемо сповіщення в Telegram
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) {
      await send(`⚠️ Отримано неочікувані дані:\n\`\`\`\n${md(JSON.stringify(req.body, null, 2))}\n\`\`\``);
      return res.json({ ok: true });
    }

    // Поля з реального JSON від Wix
    const service   = data.service_name_main_language || data.service_name || '';
    const sector    = data.staff_member_name || data.staff_member_name_main_language || '';
    const start     = fmtDate(data.start_date_by_business_tz || data.start_date);
    const end       = fmtDate(data.end_date);

    // Сума замовлення (загальна)
    const totalVal  = data.price?.value || data.amount_due || null;
    const currency  = data.price?.currency || data.remaining_amount_due?.currency || data.currency || 'UAH';
    const amountTotal = totalVal ? `${totalVal} ${currency}` : '';

    // Залишок до оплати: якщо є remaining_amount_due — використовуємо його, інакше 0
    const remainingVal = data.remaining_amount_due?.value;
    const remainingCur = data.remaining_amount_due?.currency || currency;
    const amountDue = (remainingVal !== undefined && remainingVal !== null)
      ? `${remainingVal} ${remainingCur}`
      : `0 ${currency}`;

    const name    = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
    const phone   = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '';
    const orderNo = data.order_number || '';

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

    await send(lines);
    res.json({ ok: true });
  } catch (e) {
    console.error('Помилка /booking:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server on ${PORT}`));
