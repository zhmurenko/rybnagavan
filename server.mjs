import express from 'express';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Приём данных от Wix
app.post('/booking', async (req, res) => {
  console.log('📩 Получены данные от Wix:', JSON.stringify(req.body, null, 2));

  // Отправляем весь JSON в Telegram как есть
  const rawData = JSON.stringify(req.body, null, 2);

  await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: `📢 *Новая бронь (сырые данные)*\n\`\`\`json\n${rawData}\n\`\`\``,
      parse_mode: 'Markdown'
    })
  });

  // Сообщаем Wix, что всё ок
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server запущен на порту ${PORT}`);
});
