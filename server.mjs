import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

// Константы из .env
const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Приём данных от Wix
app.post('/booking', async (req, res) => {
  try {
    console.log('📩 Получены данные от Wix:', JSON.stringify(req.body, null, 2));

    const rawData = JSON.stringify(req.body, null, 2);

    // Отправляем сырые данные в Telegram
    await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: `📢 *Новая бронь (сырые данные)*\n\`\`\`json\n${rawData}\n\`\`\``,
        parse_mode: 'Markdown'
      })
    });

    // Отвечаем Wix, что запрос получен
    res.json({ ok: true, received: req.body });
  } catch (err) {
    console.error('❌ Ошибка при обработке вебхука:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
