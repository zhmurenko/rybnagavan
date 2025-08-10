import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Константы из .env
const TOKEN = process.env.BOT_TOKEN;   // токен бота
const CHAT_ID = process.env.CHAT_ID;   // chat_id группы или канала

// Прием данных брони
app.post('/booking', async (req, res) => {
  try {
    const { sector, date, time, amount, name, phone } = req.body;

    if (!sector || !date || !amount || !name) {
      return res.status(400).json({ ok: false, error: 'Не хватает данных' });
    }

    const message = `
📢 *Новая бронь!*
━━━━━━━━━━━━━━
🏝 Сектор: *${sector}*
📅 Дата: *${date}*
🕒 Время: *${time || '-'}*
💰 Сумма: *${amount} грн*

👤 Клиент: *${name}*
📞 Телефон: [${phone || '-'}](tel:${phone || ''})
    `;

    // Отправляем сообщение в Telegram
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown'
      })
    });

    res.json({ ok: true, message: 'Отправлено в Telegram' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
