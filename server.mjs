// server.mjs
import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN       = process.env.BOT_TOKEN;
const CHAT_ID     = process.env.CHAT_ID;
const WIX_API_KEY = process.env.WIX_API_KEY;   // без "Bearer"
const WIX_SITE_ID = process.env.WIX_SITE_ID;   // metasiteId из вебхука
const SECRET_TOKEN= process.env.SECRET_TOKEN;

async function sendToTelegram(text, buttons = null) {
  const body = { chat_id: CHAT_ID, text, parse_mode: 'Markdown' };
  if (buttons) body.reply_markup = { inline_keyboard: buttons };

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return res.json(); // нужен message_id
}

async function editTelegramMessageMarkup(messageId, buttons) {
  await fetch(`https://api.telegram.org/bot${TOKEN}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId, reply_markup: { inline_keyboard: buttons } })
  });
}

function formatDate(d) {
  if (!d) return '-';
  return new Date(d).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
}

/* ------------------------ ВЕБХУК ОТ WIX ------------------------ */
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

    // отправляем сообщение с временными ссылками (переобновим msg_id)
    const sent = await sendToTelegram(msg, [[
      { text: '✅ Оплачено',           url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=PAID` },
      { text: '❌ Клиент не приехал',  url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=CANCELLED` }
    ]]);

    // обновляем ссылки c реальным message_id
    await editTelegramMessageMarkup(sent.result.message_id, [[
      { text: '✅ Оплачено',           url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sent.result.message_id}&status=PAID` },
      { text: '❌ Клиент не приехал',  url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sent.result.message_id}&status=CANCELLED` }
    ]]);

    res.json({ ok: true });
  } catch (e) {
    console.error('Ошибка /booking:', e);
    res.status(500).json({ ok:false, error:e.message });
  }
});

/* ------------------ СМЕНА СТАТУСА (КНОПКИ) ------------------ */
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

    let endpoint = '';
    let body     = {};
    let success  = '';

    if (status === 'PAID') {
      // подтверждение + отметка об оплате
      endpoint = `https://www.wixapis.com/bookings/v2/confirmation/${bookingId}:confirmOrDecline`;
      body     = { action: 'CONFIRM', paymentStatus: 'PAID' };
      success  = '💰 Оплата успешно подтверждена';
    } else if (status === 'CANCELLED') {
      // отмена брони (клиент не приехал)
      endpoint = `https://www.wixapis.com/bookings/v2/bookings/${bookingId}:cancel`;
      body     = {}; // тело не обязательно
      success  = '🚫 Бронь отменена (клиент не приехал)';
    } else {
      return res.status(400).send('<h2 style="color:red; font-family:sans-serif;">❌ Неизвестный статус</h2>');
    }

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: wixHeaders,
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const text = await r.text();
      return res.status(502).send(
        `<div style="font-family:sans-serif;padding:24px;background:#fff;border-radius:12px;max-width:780px;margin:40px auto;box-shadow:0 2px 8px rgba(0,0,0,.1)">
           <h2 style="color:#c00;margin:0 0 12px">❌ Ошибка при обновлении статуса в Wix</h2>
           <div style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;background:#f7f7f8;border:1px solid #eee;border-radius:8px;padding:12px;max-height:360px;overflow:auto">${text.replaceAll('<','&lt;')}</div>
           <p style="color:#666">Проверь: <b>WIX_API_KEY</b> (Bookings.ReadWrite), <b>WIX_SITE_ID</b>, корректность <b>bookingId</b> и URL.</p>
         </div>`
      );
    }

    // обновляем кнопки в исходном сообщении — оставляем только выбранный статус
    const newButtons = status === 'PAID'
      ? [[{ text: '✅ Оплачено' }]]
      : [[{ text: '❌ Не состоялась' }]];
    await editTelegramMessageMarkup(msg_id, newButtons);

    // аккуратная страница-ответ
    res.send(`
      <html><head><meta charset="utf-8"><title>Статус обновлён</title>
      <style>
        body{font-family:Arial,sans-serif;text-align:center;background:#f4f4f4;padding-top:50px}
        .card{display:inline-block;padding:20px 40px;background:#fff;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
        h1{color:${status === 'PAID' ? 'green' : 'red'}}
      </style></head>
      <body><div class="card"><h1>${success}</h1><p>Можно закрыть эту страницу.</p></div></body></html>
    `);
  } catch (e) {
    console.error('Ошибка /change-status:', e);
    res.status(500).send('<h2 style="color:red; font-family:sans-serif;">❌ Ошибка сервера</h2>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
