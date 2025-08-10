import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const WIX_API_KEY = process.env.WIX_API_KEY;
const SECRET_TOKEN = process.env.SECRET_TOKEN;

async function sendToTelegram(text, buttons = null) {
  const body = {
    chat_id: CHAT_ID,
    text,
    parse_mode: 'Markdown'
  };
  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }

  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  return res.json();
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

function formatDate(dateString) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
}

// 📩 Приём вебхука от Wix
app.post('/booking', async (req, res) => {
  try {
    const data = req.body.data;

    if (data) {
      const sector = data.staff_member_name || '-';
      const startDate = formatDate(data.start_date_by_business_tz);
      const endDate = formatDate(data.end_date);
      const amount = data.amount_due || (data.price?.value + ' ' + data.price?.currency) || '-';
      const name = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
      const phone = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '-';
      const bookingId = data.booking_id;

      const message = `
📢 *Новая бронь!*
━━━━━━━━━━━━━━
🏝 Сектор: *${sector}*
📅 Начало: *${startDate}*
🏁 Конец: *${endDate}*
💰 Сумма: *${amount} грн*

👤 Клиент: *${name}*
📞 Телефон: [${phone}](tel:${phone})
      `;

      const sentMessage = await sendToTelegram(message, [
        [
          { text: '✅ Оплачено', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=PAID` },
          { text: '❌ Клиент не приехал', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=TEMP&status=CANCELLED` }
        ]
      ]);

      // Обновляем ссылки с реальным msg_id
      await editTelegramMessageMarkup(sentMessage.result.message_id, [
        [
          { text: '✅ Оплачено', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sentMessage.result.message_id}&status=PAID` },
          { text: '❌ Клиент не приехал', url: `https://rybnagavan.onrender.com/change-status/${bookingId}?token=${SECRET_TOKEN}&msg_id=${sentMessage.result.message_id}&status=CANCELLED` }
        ]
      ]);
    } else {
      await sendToTelegram(`⚠️ Неожиданные данные:\n\`\`\`json\n${JSON.stringify(req.body, null, 2)}\n\`\`\``);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка при обработке вебхука:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ✅ Маршрут для изменения статуса с красивой HTML-страницей
app.get('/change-status/:bookingId', async (req, res) => {
  try {
    const { bookingId } = req.params;
    const { token, msg_id, status } = req.query;

    if (token !== SECRET_TOKEN) {
      return res.status(403).send('<h2 style="color:red;">❌ Доступ запрещён</h2>');
    }

    // Обновляем статус в Wix
    const wixRes = await fetch(`https://www.wixapis.com/bookings/v1/bookings/${bookingId}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': WIX_API_KEY
      },
      body: JSON.stringify({ paymentStatus: status })
    });

    if (!wixRes.ok) {
      const errorText = await wixRes.text();
      console.error('Ошибка Wix API:', errorText);
      return res.status(500).send('<h2 style="color:red;">❌ Ошибка при обновлении статуса в Wix</h2>');
    }

    // Меняем кнопки в исходном сообщении
    let newButtons;
    let pageMessage;
    if (status === 'PAID') {
      newButtons = [[{ text: '✅ Оплачено' }]];
      pageMessage = '💰 Оплата успешно подтверждена';
    } else if (status === 'CANCELLED') {
      newButtons = [[{ text: '❌ Не состоялась' }]];
      pageMessage = '🚫 Бронь отменена (клиент не приехал)';
    }
    await editTelegramMessageMarkup(msg_id, newButtons);

    // Красивый HTML ответ
    res.send(`
      <html>
      <head>
        <meta charset="utf-8">
        <title>Статус обновлён</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            text-align: center;
            background-color: #f4f4f4;
            padding-top: 50px;
          }
          .card {
            display: inline-block;
            padding: 20px 40px;
            background: white;
            border-radius: 12px;
            box-shadow: 0 2px 8px rgba(0,0,0,0.2);
          }
          h1 {
            color: ${status === 'PAID' ? 'green' : 'red'};
          }
          a {
            display: inline-block;
            margin-top: 20px;
            text-decoration: none;
            color: #007bff;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>${pageMessage}</h1>
          <p>Вы можете закрыть эту страницу.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Ошибка при изменении статуса:', err);
    res.status(500).send('<h2 style="color:red;">❌ Ошибка сервера</h2>');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
