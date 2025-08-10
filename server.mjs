// server.mjs
// Rybna Gavan — прием вебхука от Wix + уведомление в Telegram (без OAuth)

// ============== ENV ==============
import express from 'express';
import { Telegraf } from 'telegraf';

const {
  PORT = 3000,
  TIMEZONE = 'Europe/Kiev',
  BOT_TOKEN,          // токен бота
  ADMIN_CHAT_ID,      // чат, куда слать уведомления
  WEBHOOK_SECRET,     // общий секрет для подписи (мы проверяем заголовок)
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!ADMIN_CHAT_ID) throw new Error('ADMIN_CHAT_ID is required');
if (!WEBHOOK_SECRET) console.warn('WEBHOOK_SECRET is not set (рекомендовано выставить)');

const app = express();
app.use(express.json({ limit: '1mb' }));

// ============== Telegram ==============
const bot = new Telegraf(BOT_TOKEN);

function fmtLocal(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('uk-UA', {
    timeZone: TIMEZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
}
const cleanPhone = (p='') => p.replace(/[^\d+]/g, '');

// Отправка уведомления админу
async function notifyAdmin(html) {
  await bot.telegram.sendMessage(ADMIN_CHAT_ID, html, {
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
}

// ============== Health/Root ==============
app.get('/', (_req, res) => {
  res.type('text').send('OK: webhook server (no OAuth)');
});
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    tz: TIMEZONE,
    has: { BOT_TOKEN: !!BOT_TOKEN, ADMIN_CHAT_ID: !!ADMIN_CHAT_ID, WEBHOOK_SECRET: !!WEBHOOK_SECRET },
    now: new Date().toISOString()
  });
});

// ============== Webhook от Wix ==============
// URL для Wix-автоматизации: POST https://<твой_домен>/hooks/booking-created
// В заголовке добавь: X-Webhook-Secret: <твой секрет из env WEBHOOK_SECRET>
// Тело (JSON) заполни полями из автоматизации (пример ниже в инструкции)
app.post('/hooks/booking-created', async (req, res) => {
  try {
    // Проверим секрет (если задан)
    if (WEBHOOK_SECRET) {
      const hdr = req.header('X-Webhook-Secret') || req.header('x-webhook-secret');
      if (hdr !== WEBHOOK_SECRET) {
        return res.status(401).json({ ok: false, error: 'bad signature' });
      }
    }

    const p = req.body || {};
    // ожидаемые поля (см. инструкцию по маппингу)
    const serviceName   = p.serviceName || 'Послуга';
    const sectorName    = p.sectorName  || (p.resourceName || 'Сектор');
    const startISO      = p.start       || p.startISO;
    const endISO        = p.end         || p.endISO;
    const amount        = p.amount ?? null;
    const currency      = p.currency || 'UAH';
    const customerName  = p.customerName || '—';
    const customerPhone = p.customerPhone || '—';
    const bookingId     = p.bookingId || p.id || '—';

    const priceTxt = amount != null
      ? `${new Intl.NumberFormat('uk-UA').format(amount)} ${currency}`
      : '—';

    const msg =
      `🆕 <b>Нова бронь</b>\n` +
      `• Послуга: <b>${serviceName}</b>\n` +
      `• Сектор: <b>${sectorName}</b>\n` +
      `• Дата/час: <b>${fmtLocal(startISO)}</b>${endISO ? ` → <b>${fmtLocal(endISO)}</b>` : ''}\n` +
      `• До оплати: <b>${priceTxt}</b>\n` +
      `• Клієнт: ${customerName}\n` +
      `• Телефон: <a href="tel:${cleanPhone(customerPhone)}">${customerPhone}</a>\n` +
      `• ID: <code>${bookingId}</code>`;

    await notifyAdmin(msg);
    return res.json({ ok: true });
  } catch (e) {
    console.error('webhook error', e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});

// Тестовый эндпойнт — можно руками дернуть POST из Postman
app.post('/hooks/test', async (req, res) => {
  try {
    const p = req.body || {};
    await notifyAdmin(`<b>Тест</b>\n${JSON.stringify(p, null, 2)}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// ============== Start ==============
app.listen(PORT, () => {
  console.log(`Webhook server on ${PORT} TZ=${TIMEZONE}`);
});
