import express from "express";
import fetch from "node-fetch";

const TELEGRAM_TOKEN =
  process.env.BOT_TOKEN ||
  "8214118277:AAGcV-HgMPvuKX2R-0bSsdE3Mj8q_Z0Q9RM"; // твой токен
const TELEGRAM_CHAT_ID = 619516861; // твой чат ID

// Твой домен на Railway:
const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  "https://vladosbot-production.up.railway.app";

const app = express();
app.use(express.json());

// Функция отправки сообщения в Telegram
async function sendTelegramMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("sendMessage result:", data);
}

// Корневая страница — просто проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("VST Arbitrage bot is running ✅");
});

// ТЕСТОВЫЙ ЭНДПОИНТ:
// если зайти по адресу /test, бот пришлёт тебе сообщение в Telegram
app.get("/test", async (req, res) => {
  try {
    await sendTelegramMessage("Тест: бот жив, токен рабочий ✅");
    res.send("Test message sent to Telegram");
  } catch (e) {
    console.error("Ошибка при отправке теста:", e);
    res.status(500).send("Ошибка при отправке в Telegram");
  }
});

// WEBHOOK от Telegram — сюда будут прилетать сообщения боту
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    console.log("Incoming update:", JSON.stringify(msg));

    if (msg && msg.text === "/start") {
      await sendTelegramMessage("Бот активирован ✔️ Я в сети.");
    }

    // здесь потом можно добавить обработку других команд, если нужно

    res.sendStatus(200);
  } catch (e) {
    console.error("Ошибка в webhook:", e);
    res.sendStatus(500);
  }
});

// Регистрируем webhook при старте сервера (сделает запрос с Railway, не с телефона)
async function registerWebhook() {
  try {
    const webhookUrl = `${RAILWAY_URL}/webhook`;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook?url=${encodeURIComponent(
      webhookUrl
    )}`;

    const res = await fetch(url);
    const data = await res.json();
    console.log("setWebhook result:", data);
  } catch (e) {
    console.error("Ошибка при установке webhook:", e);
  }
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  // при запуске сразу пытаемся зарегистрировать webhook
  registerWebhook();
});
