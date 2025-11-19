// server.js
// Arbitrage bot: Binance US + Kraken + Coinbase + Gemini + Bitstamp

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// === НАСТРОЙКИ TELEGRAM ===

// Токен бота берём из переменной Railway: BOT_TOKEN
const TELEGRAM_TOKEN = process.env.BOT_TOKEN;

// Твой Telegram ID (куда бот шлёт сигналы и логи)
const TELEGRAM_CHAT_ID = 619516861;
const ADMIN_CHAT_ID = TELEGRAM_CHAT_ID;

// Порт для Railway
const PORT = process.env.PORT || 3000;

// Адрес сервера (домен Railway, можно захардкодить, если что)
const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  "https://vladosbot-production.up.railway.app";

if (!TELEGRAM_TOKEN) {
  console.error("❌ Нет TELEGRAM_TOKEN в переменных окружения!");
}

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// === ПАРАМЕТРЫ БОТА ===

// 4 монеты
const COINS = ["SOL", "LTC", "XRP", "ADA"];

// Эмодзи монет
const COIN_EMOJI = {
  SOL: "🔥",
  LTC: "⚪️",
  XRP: "💎",
  ADA: "🔵",
};

// Эмодзи валюты
const USD_EMOJI = "💵";

// Минимальный спред в %
const MIN_SPREAD = 1.3;

// Антиспам 5 минут
const ANTISPAM_MINUTES = 5;

// Проверка каждые 30 секунд
const CHECK_INTERVAL_MS = 30 * 1000;

// Аналитика раз в 3 часа
const ANALYTICS_INTERVAL_MS = 3 * 60 * 60 * 1000;

// История сигналов (для аналитики)
let signalsHistory = [];

// Последнее время сигнала по ключу "COIN-BUY-SELL"
const lastSignalTime = new Map();

// === БИРЖИ ===
//
// Все 5 бирж участвуют в сигналах и аналитике.
// name: { async getPrice(symbol) }

const EXCHANGES = {
  "Binance US": {
    async getPrice(symbol) {
      const pair = symbol + "USDT"; // SOLUSDT, LTCUSDT, ...
      const url = `https://api.binance.us/api/v3/ticker/price?symbol=${pair}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Binance US response not ok");
      const data = await res.json();
      return parseFloat(data.price);
    },
  },

  Kraken: {
    async getPrice(symbol) {
      // SOLUSD, LTCUSD, XRPUSD, ADAUSD
      const pair = symbol + "USD";
      const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Kraken response not ok");
      const data = await res.json();
      const resultKey = Object.keys(data.result || {})[0];
      if (!resultKey) throw new Error("Kraken no result key");
      const ticker = data.result[resultKey];
      return parseFloat(ticker.c[0]); // last trade price
    },
  },

  Coinbase: {
    async getPrice(symbol) {
      // SOL-USD, LTC-USD, XRP-USD, ADA-USD
      const pair = symbol + "-USD";
      const url = `https://api.exchange.coinbase.com/products/${pair}/ticker`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Coinbase response not ok");
      const data = await res.json();
      return parseFloat(data.price || data.last);
    },
  },

  Gemini: {
    async getPrice(symbol) {
      // solusd, ltcusd, xrpusd, adausd
      const pair = (symbol + "usd").toLowerCase();
      const url = `https://api.gemini.com/v1/pubticker/${pair}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Gemini response not ok");
      const data = await res.json();
      return parseFloat(data.last);
    },
  },

  Bitstamp: {
    async getPrice(symbol) {
      // solusd, ltcusd, xrpusd, adausd
      const pair = (symbol + "usd").toLowerCase();
      const url = `https://www.bitstamp.net/api/v2/ticker/${pair}/`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("Bitstamp response not ok");
      const data = await res.json();
      return parseFloat(data.last);
    },
  },
};

// === ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===

// Время Нью-Йорка HH:MM
function nyTimeString(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Отправка сообщения в Telegram
async function sendTelegramMessage(chatId, text) {
  if (!TELEGRAM_TOKEN) {
    console.error("Нет TELEGRAM_TOKEN, не могу отправить сообщение");
    return;
  }

  try {
    const url = `${TELEGRAM_API}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      }),
    });

    const data = await res.json();
    if (!data.ok) {
      console.error("Ошибка отправки в Telegram:", data);
    }
  } catch (err) {
    console.error("Сетевая ошибка отправки в Telegram:", err.message);
  }
}

// Логи в Telegram
async function logToTelegram(text) {
  await sendTelegramMessage(ADMIN_CHAT_ID, `📝 LOG:\n${text}`);
}

// Получить все цены по всем биржам и монетам
async function fetchAllPrices() {
  const snapshot = {};

  for (const [name, ex] of Object.entries(EXCHANGES)) {
    snapshot[name] = {};
    for (const symbol of COINS) {
      try {
        const price = await ex.getPrice(symbol);
        if (!isFinite(price) || price <= 0) {
          snapshot[name][symbol] = null;
        } else {
          snapshot[name][symbol] = price;
        }
      } catch (err) {
        console.error(`Ошибка цены ${name} ${symbol}:`, err.message);
        snapshot[name][symbol] = null;
      }
    }
  }

  console.log("Prices snapshot:", JSON.stringify(snapshot, null, 2));
  return snapshot;
}

// Проверка антиспама для пары (symbol, buyEx, sellEx)
function shouldSendSignal(key) {
  const now = Date.now();
  const last = lastSignalTime.get(key) || 0;
  if (now - last < ANTISPAM_MINUTES * 60 * 1000) {
    return false;
  }
  lastSignalTime.set(key, now);
  return true;
}

// === ОСНОВНОЙ АРБИТРАЖ ===

async function runArbitrage() {
  try {
    const prices = await fetchAllPrices();
    const exchangeNames = Object.keys(EXCHANGES);

    for (const symbol of COINS) {
      for (let i = 0; i < exchangeNames.length; i++) {
        const buyName = exchangeNames[i];
        const buyPrice = prices[buyName][symbol];
        if (!buyPrice) continue;

        for (let j = 0; j < exchangeNames.length; j++) {
          if (i === j) continue;

          const sellName = exchangeNames[j];
          const sellPrice = prices[sellName][symbol];
          if (!sellPrice) continue;

          const spread = ((sellPrice - buyPrice) / buyPrice) * 100;

          if (spread >= MIN_SPREAD) {
            const key = `${symbol}-${buyName}-${sellName}`;
            if (!shouldSendSignal(key)) {
              continue;
            }

            const now = new Date();
            const timeNY = nyTimeString(now);
            const emoji = COIN_EMOJI[symbol] || "";
            const coinLine = `${symbol} ${emoji}`; // ПРОБЕЛ после монеты

            const text =
              `${coinLine}\n` +
              `Купить: <b>${buyName}</b> — $${buyPrice.toFixed(4)} ${USD_EMOJI}\n` +
              `Продать: <b>${sellName}</b> — $${sellPrice.toFixed(4)} ${USD_EMOJI}\n` +
              `Спред: <b>${spread.toFixed(2)}%</b>\n` +
              `Время (NY): ${timeNY}`;

            await sendTelegramMessage(TELEGRAM_CHAT_ID, text);

            // Записываем сигнал в историю
            signalsHistory.push({
              ts: now.getTime(),
              symbol,
              buy: buyName,
              sell: sellName,
              spread,
            });
          }
        }
      }
    }

    // чистим историю старше 6 часов
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    signalsHistory = signalsHistory.filter((s) => s.ts >= cutoff);
  } catch (err) {
    console.error("Ошибка в runArbitrage:", err.message);
  }
}

// === АНАЛИТИКА КАЖДЫЕ 3 ЧАСА ===

async function sendAnalytics() {
  const now = Date.now();
  const fromTs = now - 3 * 60 * 60 * 1000;

  const recent = signalsHistory.filter((s) => s.ts >= fromTs);

  if (recent.length === 0) {
    await sendTelegramMessage(
      ADMIN_CHAT_ID,
      `📊 Аналитика за 3 часа (NY):\n\nСигналов не было.`
    );
    return;
  }

  const totalSignals = recent.length;
  const totalSpread = recent.reduce((sum, s) => sum + s.spread, 0);
  const avgSpread = totalSpread / totalSignals;

  // По монетам
  const byCoin = {};
  for (const s of recent) {
    if (!byCoin[s.symbol]) {
      byCoin[s.symbol] = { count: 0, sumSpread: 0 };
    }
    byCoin[s.symbol].count += 1;
    byCoin[s.symbol].sumSpread += s.spread;
  }

  // Топ монета
  let bestCoin = null;
  let bestCoinAvg = 0;

  for (const [symbol, stat] of Object.entries(byCoin)) {
    const avg = stat.sumSpread / stat.count;
    if (!bestCoin || avg > bestCoinAvg) {
      bestCoin = symbol;
      bestCoinAvg = avg;
    }
  }

  // Пары "монета | buy → sell"
  const byPair = {};
  for (const s of recent) {
    const key = `${s.symbol} | ${s.buy} → ${s.sell}`;
    if (!byPair[key]) {
      byPair[key] = { count: 0, sumSpread: 0 };
    }
    byPair[key].count += 1;
    byPair[key].sumSpread += s.spread;
  }

  let bestPair = null;
  let bestPairAvg = 0;
  for (const [pair, stat] of Object.entries(byPair)) {
    const avg = stat.sumSpread / stat.count;
    if (!bestPair || avg > bestPairAvg) {
      bestPair = pair;
      bestPairAvg = avg;
    }
  }

  let text = `📊 Аналитика арбитража за последние 3 часа (NY):\n\n`;
  text += `Всего сигналов: <b>${totalSignals}</b>\n`;
  text += `Средний спред: <b>${avgSpread.toFixed(2)}%</b>\n`;
  text += `Суммарный спред: <b>${totalSpread.toFixed(2)}%</b>\n\n`;

  text += `По монетам:\n`;
  for (const [symbol, stat] of Object.entries(byCoin)) {
    const avg = stat.sumSpread / stat.count;
    text += `• ${symbol}: ${stat.count} сигналов, средний спред ${avg.toFixed(
      2
    )}%\n`;
  }

  text += `\nТоп монета: <b>${bestCoin}</b> (ср. спред ${bestCoinAvg.toFixed(
    2
  )}%)\n`;
  text += `Топ пара: <b>${bestPair}</b> (ср. спред ${bestPairAvg.toFixed(
    2
  )}%)`;

  await sendTelegramMessage(ADMIN_CHAT_ID, text);
}

// === TELEGRAM WEBHOOK ===

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const update = req.body;
  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || "";

      if (text.startsWith("/start")) {
        await sendTelegramMessage(chatId, "Бот активирован ✅ Я в сети.");
      }
    }
  } catch (err) {
    console.error("Ошибка обработки апдейта:", err.message);
  }
});

// Корневая страница
app.get("/", (req, res) => {
  res.send("Arbitrage bot is running ✅");
});

// Установка webhook
async function setWebhook() {
  if (!TELEGRAM_TOKEN) return;
  const base = RAILWAY_URL.replace(/\/+$/, "");
  const webhookUrl = `${base}/webhook`;
  const url = `${TELEGRAM_API}/setWebhook`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    console.log("setWebhook result:", data);
    await logToTelegram(
      `Webhook: ${data.ok ? "OK" : "ERROR"} (${webhookUrl})`
    );
  } catch (err) {
    console.error("Ошибка setWebhook:", err.message);
  }
}

// === ЗАПУСК СЕРВЕРА ===

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  setWebhook();
  // арбитраж
  runArbitrage();
  setInterval(runArbitrage, CHECK_INTERVAL_MS);
  // аналитика
  setInterval(sendAnalytics, ANALYTICS_INTERVAL_MS);
});
