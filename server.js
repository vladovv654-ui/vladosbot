import express from "express";
import fetch from "node-fetch";

// 🔑 Настройки Telegram
const TELEGRAM_TOKEN = process.env.BOT_TOKEN; // берем токен из переменной Railway
const TELEGRAM_CHAT_ID = 619516861; // твой чат ID

// Домен Railway, куда Telegram шлет webhook
const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  "https://vladosbot-production.up.railway.app";

const app = express();
app.use(express.json());

// ================= TELEGRAM =================

async function sendTelegramMessage(text) {
  if (!TELEGRAM_TOKEN) {
    console.error("TELEGRAM_TOKEN is missing");
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;

  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    parse_mode: "Markdown",
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  console.log("sendMessage result:", data);
}

// Корневой маршрут — просто проверка, что сервер жив
app.get("/", (req, res) => {
  res.send("VST Arbitrage bot is running ✅");
});

// Тестовый маршрут — ручная проверка
app.get("/test", async (req, res) => {
  try {
    await sendTelegramMessage("Тест: бот жив, токен рабочий ✅");
    res.send("Test message sent to Telegram");
  } catch (e) {
    console.error("Ошибка при отправке теста:", e);
    res.status(500).send("Ошибка при отправке в Telegram");
  }
});

// Webhook от Telegram (обработка /start и др.)
app.post("/webhook", async (req, res) => {
  try {
    const msg = req.body.message;
    console.log("Incoming update:", JSON.stringify(msg));

    if (msg && msg.text === "/start") {
      await sendTelegramMessage("Бот активирован ✔️ Я в сети.");
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("Ошибка в webhook:", e);
    res.sendStatus(500);
  }
});

// Устанавливаем webhook при старте
async function registerWebhook() {
  try {
    if (!TELEGRAM_TOKEN) {
      console.error("TELEGRAM_TOKEN is missing, webhook not set");
      return;
    }

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

// ================ АРБИТРАЖ ================

// Монеты и соответствия тикеров на биржах
const COINS = [
  {
    symbol: "SOL",
    emoji: "🟠",
    binanceSymbol: "SOLUSDT",
    cryptoComInstrument: "SOL_USDT",
    krakenPair: "SOLUSD",
  },
  {
    symbol: "LTC",
    emoji: "⚪️",
    binanceSymbol: "LTCUSDT",
    cryptoComInstrument: "LTC_USDT",
    krakenPair: "LTCUSD",
  },
  {
    symbol: "XRP",
    emoji: "💎",
    binanceSymbol: "XRPUSDT",
    cryptoComInstrument: "XRP_USDT",
    krakenPair: "XRPUSD",
  },
  {
    symbol: "ADA",
    emoji: "🔵",
    binanceSymbol: "ADAUSDT",
    cryptoComInstrument: "ADA_USDT",
    krakenPair: "ADAUSD",
  },
];

const SPREAD_THRESHOLD = 1.3; // 1.3%
const CHECK_INTERVAL_MS = 60_000; // 60 секунд
const ANTI_SPAM_MINUTES = 10;

// чтобы не спамить одинаковыми сигналами
const lastSignals = {}; // ключ: "COIN-BUYEX-SELLEX" -> timestamp

// Получение цены с Binance US
async function getBinancePrice(symbol) {
  try {
    const url = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.price) return null;
    return parseFloat(data.price);
  } catch (e) {
    console.error("Binance US error:", e);
    return null;
  }
}

// Получение цены с Crypto.com
async function getCryptoComPrice(instrument) {
  try {
    const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${instrument}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.result || !data.result.data || !data.result.data.c) return null;
    // c — last traded price
    return parseFloat(data.result.data.c);
  } catch (e) {
    console.error("Crypto.com error:", e);
    return null;
  }
}

// Получение цены с Kraken
async function getKrakenPrice(pair) {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!data.result) return null;
    const key = Object.keys(data.result)[0];
    if (!key) return null;
    const ticker = data.result[key];
    if (!ticker || !ticker.c || !ticker.c[0]) return null;
    return parseFloat(ticker.c[0]);
  } catch (e) {
    console.error("Kraken error:", e);
    return null;
  }
}

// Получаем все цены по всем монетам
async function getAllPrices() {
  const prices = {}; // prices[exchange][symbol] = price

  for (const coin of COINS) {
    const { symbol, binanceSymbol, cryptoComInstrument, krakenPair } = coin;

    const [binancePrice, cryptoPrice, krakenPrice] = await Promise.all([
      getBinancePrice(binanceSymbol),
      getCryptoComPrice(cryptoComInstrument),
      getKrakenPrice(krakenPair),
    ]);

    prices["Binance US"] = prices["Binance US"] || {};
    prices["Crypto.com"] = prices["Crypto.com"] || {};
    prices["Kraken"] = prices["Kraken"] || {};

    prices["Binance US"][symbol] = binancePrice;
    prices["Crypto.com"][symbol] = cryptoPrice;
    prices["Kraken"][symbol] = krakenPrice;
  }

  console.log("Prices snapshot:", prices);
  return prices;
}

// Проверяем спреды и шлем сигналы
async function checkArbitrage() {
  try {
    const prices = await getAllPrices();
    const exchanges = ["Binance US", "Crypto.com", "Kraken"];

    for (const coin of COINS) {
      const { symbol, emoji } = coin;

      for (const buyEx of exchanges) {
        for (const sellEx of exchanges) {
          if (buyEx === sellEx) continue;

          const buyPrice = prices[buyEx]?.[symbol];
          const sellPrice = prices[sellEx]?.[symbol];

          if (!buyPrice || !sellPrice) continue;

          const spread = ((sellPrice - buyPrice) / buyPrice) * 100;

          if (spread >= SPREAD_THRESHOLD) {
            await maybeSendSignal(symbol, emoji, buyEx, sellEx, buyPrice, sellPrice, spread);
          }
        }
      }
    }
  } catch (e) {
    console.error("checkArbitrage error:", e);
  }
}

// Антиспам + отправка сигнала
async function maybeSendSignal(
  symbol,
  emoji,
  buyEx,
  sellEx,
  buyPrice,
  sellPrice,
  spread
) {
  const key = `${symbol}-${buyEx}-${sellEx}`;
  const now = Date.now();
  const last = lastSignals[key];

  if (last && now - last < ANTI_SPAM_MINUTES * 60_000) {
    // уже слали недавно — не спамим
    return;
  }

  lastSignals[key] = now;

  const time = new Date();
  const hh = String(time.getHours()).padStart(2, "0");
  const mm = String(time.getMinutes()).padStart(2, "0");
  const timeStr = `${hh}:${mm}`;

  const msg =
    `${symbol} ${emoji}\n` +
    `Buy: *${buyEx}* — $${buyPrice.toFixed(4)}\n` +
    `Sell: *${sellEx}* — $${sellPrice.toFixed(4)}\n` +
    `Spread: *${spread.toFixed(2)}%*\n` +
    `Time: ${timeStr}`;

  // пустая строка в конце для читабельности в Telegram
  await sendTelegramMessage(msg + "\n");
}

// Запускаем периодический арбитражный цикл
function startArbitrageLoop() {
  console.log("Starting arbitrage loop...");
  checkArbitrage(); // первый запуск сразу
  setInterval(checkArbitrage, CHECK_INTERVAL_MS);
}

// ================== START SERVER ==================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  registerWebhook();
  startArbitrageLoop();
});
