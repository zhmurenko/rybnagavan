import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

async function sendToTelegram(text) {
  return fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'Markdown'
    })
  });
}

function formatDate(dateString) {
  if (!dateString) return '-';
  return new Date(dateString).toLocaleString('uk-UA', { timeZone: 'Europe/Kiev' });
}

app.post('/booking', async (req, res) => {
  try {
    console.log('📩 Получены данные от Wix');

    const data = req.body.data;

    if (data) {
      const sector = data.staff_member_name || '-';
      const startDate = formatDate(data.start_date_by_business_tz);
      const endDate = formatDate(data.end_date);
      const amount = data.amount_due || (data.price?.value + ' ' + data.price?.currency) || '-';
      const name = `${data.contact?.name?.first || ''} ${data.contact?.name?.last || ''}`.trim();
      const phone = data.contact?.phones?.[0]?.e164Phone || data.booking_contact_phone || '-';

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

      await sendToTelegram(message);
    } else {
      await sendToTelegram(`⚠️ Пришли неожиданные данные:\n\`\`\`json\n${JSON.stringify(req.body, null, 2)}\n\`\`\``);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Ошибка при обработке вебхука:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
