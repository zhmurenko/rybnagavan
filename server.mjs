// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN        = process.env.BOT_TOKEN;      // токен Telegram-бота
const CHAT_ID      = process.env.CHAT_ID;        // ID чата/канала
const WIX_API_KEY  = process.env.WIX_API_KEY;    // API Key Wix (БЕЗ "Bearer")
const WIX_SITE_ID  = process.env.WIX_SITE_ID;    // metasiteId из вебхука Wix
const SECRET_TOKEN = process.env.SECRET_TOKEN;   // секрет для ссылок

/* ----------------- helpers ----------------- */
async function sendToTelegram(text, buttons = null) {
  const body = { chat_id: CHAT_ID, text, parse_mode: 'Markdown' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json(); // нужен message_id
}

async function editTelegramMessageMarkup(messageId, buttons) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      message_id: messageId,
      reply_markup: { inline_keyboard: buttons }
    })
  });
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
}

function renderErrorCard(text) {
  const safe = (text || '').replaceAll('<','&lt;');
  return `
  <div style="font-family:sans-serif;padding:24px;background:#fff;border-radius:12px;max-width:780px;margin:40px auto;box-shadow:0 2px 8px rgba(0,0,0,.1)">
    <h2 style="color:#c00;margin:0 0 12px">❌ Ошибка при обновлении статуса в Wix</h2>
    <div style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;background:#f7f7f8;border:1px solid #eee;border-radius:8px;padding:12px;max-height:360px;overflow:auto">${safe || '(empty body)'}</div>
    <p style="color:#666">Проверь: <b>WIX_API_KEY</b> (Bookings.ReadWrite), <b>WIX_SITE_ID</b>, корректность <b>bookingId</b> и URL.</p>
  </div>`;
}

function renderOkCard(message, isPaid) {
  return `
  <html><head><meta charset="utf-8"><title>Статус обновлён</title>
  <style>
    body{font-family:Arial,sans-serif;text-align:center;background:#f4f4f4;padding-top:50px}
    .card{display:inline-block;padding:20px 40px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    h1{color:${isPaid ? 'green' : 'red'}}
  </style></head>
  <body><div class="card"><h1>${message}</h1><p>Можно закрыть эту страницу.</p></div></body></html>`;
}

/* --------- ВЕБХУК ОТ WIX → сообщение в Telegram --------- */
app.post('/booking', async (req, res) => {
  try {
    const data = req.body?.data;
    if (!data) {
      await sendToTelegram(`⚠️ Неожиданные данные:\n\`\`\`json\n${JSON.stringify(req.body, null, 2)}\n\`\`\``);
      return res.json({ ok: true });
    }

    const sector    = data.staff_member_name || data.staff_member_name_main_language || '-';
    const startDate = formatDate(data.start_date_by_business_tz);
    const endDate   = formatDate(data.end_date);
    const amount    = data.amount_due || (data.price?.value && data.price?.currency ? `${data.price.value} ${data.price.currency}` : '-');
    const name      = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim() || '-';
    const phone     = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '-';
    const bookingId = data.booking_id;

    const msg = `
📢 *Новая бронь!*
━━━━━━━━━━━━━━
🏝 Сектор: *${sector}*
📅 Начало: *${startDate}*
🏁 Конец: *${endDate}*
💰 Сумма: *${amount} грн*

👤 Клиент: *${name}*
📞 Телефон: [${phone}](tel:${phone})
    `.trim();

    // сначала отправляем с временным msg_id
    const sent = await sendToTelegram(msg, [[
      { text: '✅ Оплачено',          url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=PAID` },
      { text: '❌ Клиент не приехал', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=CANCELLED` }
    ]]);

    // затем обновляем кнопки, подставляя реальный message_id
    await editTelegramMessageMarkup(sent.result.message_id, [[
      { text: '✅ Оплачено',          url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sent.result.message_id}&status=PAID` },
      { text: '❌ Клиент не приехал', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sent.result.message_id}&status=CANCELLED` }
    ]]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка /booking:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* --------- КНОПКИ: оплачено / не приехал (с диагностикой) --------- */
app.get('/change-status/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { token, msg_id, status } = req.query;

    if (token !== SECRET_TOKEN) {
      return res.status(403).send('<h2 style="color:red; font-family:sans-serif;">❌ Доступ запрещён</h2>');
    }

    const wixHeaders = {
      'Content-Type': 'application/json',
      'Authorization': WIX_API_KEY,  // ВАЖНО: без "Bearer"
      'wix-site-id' : WIX_SITE_ID
    };

    // универсальный POST к Wix с логом статуса и тела
    async function wixFetch(url, bodyObj = {}) {
      const r = await fetch(url, {
        method: 'POST',
        headers: wixHeaders,
        body: JSON.stringify(bodyObj) // всегда отправляем JSON (даже пустой {})
      });
      const text = await r.text();    // читаем заранее, чтобы не терять тело
      return { ok: r.ok, status: r.status, text };
    }

    if (status === 'PAID') {
      const result = await wixFetch(
        `https://www.wixapis.com/bookings/v2/bookings/${bookingId}:markAsPaid`,
        {}
      );
      if (!result.ok) {
        return res.status(502).send(renderErrorCard(`HTTP ${result.status}\n${result.text}`));
      }
      await editTelegramMessageMarkup(msg_id, [[{ text: '✅ Оплачено' }]]);
      return res.send(renderOkCard('💰 Оплата успешно подтверждена', true));
    }

    if (status === 'CANCELLED') {
      const result = await wixFetch(
        `https://www.wixapis.com/bookings/v2/bookings/${bookingId}:cancel`,
        { cancellationReason: 'NO_SHOW' }
      );
      if (!result.ok) {
        return res.status(502).send(renderErrorCard(`HTTP ${result.status}\n${result.text}`));
      }
      await editTelegramMessageMarkup(msg_id, [[{ text: '❌ Не состоялась' }]]);
      return res.send(renderOkCard('🚫 Бронь отменена (клиент не приехал)', false));
    }

    return res.status(400).send('<h2 style="color:red; font-family:sans-serif;">❌ Неизвестный статус</h2>');
  } catch (e) {
    console.error('Ошибка /change-status:', e);
    res.status(500).send('<h2 style="color:red; font-family:sans-serif;">❌ Ошибка сервера</h2>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
