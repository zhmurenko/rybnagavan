// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN  = process.env.BOT_TOKEN;   // токен Telegram-бота
const CHAT   = process.env.CHAT_ID;     // ID чату/каналу
const TZ     = 'Europe/Kiev';

// Невелика утиліта для екранування Markdown V2 (щоб не ламались спецсимволи)
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
      parse_mode: 'MarkdownV2', // надійніше, якщо все екранувати
      disable_web_page_preview: true
    })
  });
}

// Проста «живу» перевірка
app.get('/', (_req, res) => res.send('OK'));

// Вебхук від Wix
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) {
      await send(`⚠️ Отримано неочікувані дані:\n\`\`\`\n${md(JSON.stringify(req.body, null, 2))}\n\`\`\``);
      return res.json({ ok: true });
    }

    // Поля з твого реального JSON
    const sector    = data.staff_member_name || data.staff_member_name_main_language || '';
    const start     = fmtDate(data.start_date_by_business_tz || data.start_date);
    const end       = fmtDate(data.end_date);
    const amount    = data.amount_due || (data.price?.value && data.price?.currency ? `${data.price.value} ${data.price.currency}` : '');
    const service   = data.service_name_main_language || data.service_name || '';
    const orderNo   = data.order_number || '';
    const bookingId = data.booking_id || '';
    const name      = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
    const phone     = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '';

    const lines = [
      `📢 *Нове бронювання*`,
      `━━━━━━━━━━━━━━`,
      service ? `🎣 Послуга: *${md(service)}*` : null,
      sector  ? `🏝 Сектор: *${md(sector)}*` : null,
      `📅 Початок: *${md(start)}*`,
      `🏁 Кінець: *${md(end)}*`,
      amount  ? `💰 Сума: *${md(amount)}*` : null,
      ``,
      name    ? `👤 Клієнт: *${md(name)}*` : null,
      phone   ? `📞 Телефон: ${md(phone)}` : null,
      orderNo ? `🧾 Замовлення: *${md(orderNo)}*` : null,
      bookingId ? `🔖 ID броні: \`${md(bookingId)}\`` : null
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
