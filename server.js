// server.js
// Vlados arbitrage bot: Binance US + Kraken + Crypto.com, spread 1.1%, повтор пары раз в 5 минут

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ====== НАСТРОЙКИ БОТА ======
const BOT_TOKEN = "8214118277:AAG0BJyoEZ76LbB5bnN1zGfqZ5oivu4khxA";
const TELEGRAM_CHAT_ID = 619516861;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ====== КОНФИГ АРБИТРАЖА ======

// монеты
const COINS = ["SOL", "LTC", "XRP", "ADA", "TRX"];

// биржи — только три
const EXCHANGES = ["Binance US", "Kraken", "Crypto.com"];

// минимальный спред
const MIN_SPREAD = 1.1; // %

// интервалы
const CHECK_INTERVAL_MS = 30 * 1000;          // проверка каждые 30 секунд
const REPEAT_INTERVAL_MS = 5 * 60 * 1000;     // ту же пару слать не чаще 1 раза в 5 минут
const ANALYTICS_INTERVAL_MS = 3 * 60 * 60 * 1000; // аналитика каждые 3 часа

// время последнего сигнала по паре: { "SOL|Binance US|Kraken": timestamp }
const lastSignalTime = {};

// история сигналов для аналитики
const signalHistory = []; // { time, coin, buy, sell, spread }

// ====== ВСПОМОГАТЕЛЬНЫЕ ======
function nyTimeString(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendTelegramMessage(text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("Error sending Telegram message:", err.message);
  }
}

async function logToTelegram(text) {
  await sendTelegramMessage(`📝 LOG:\n${text}`);
}

// эмодзи для монет
function coinEmoji(symbol) {
  switch (symbol) {
    case "SOL": return "🟣";
    case "LTC": return "⚪️";
    case "XRP": return "💎";
    case "ADA": return "🔵";
    case "TRX": return "🔺";
    default: return "🟡";
  }
}

// ====== ПОЛУЧЕНИЕ ЦЕН С БИРЖ ======

// Binance US — TRX полностью игнорируем
async function fetchBinanceUS(coin) {
  try {
    if (coin === "TRX") return null; // TRX на Binance US мусорный

    const symbol = `${coin}USD`;
    const url = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.price);
  } catch {
    return null;
  }
}

// Kraken
async function fetchKraken(coin) {
  try {
    const pair = `${coin}USD`;
    const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const key = Object.keys(data.result || {})[0];
    if (!key) return null;
    const last = data.result[key].c?.[0];
    return last ? parseFloat(last) : null;
  } catch {
    return null;
  }
}

// Crypto.com — ПРАВИЛЬНАЯ ВЕРСИЯ
async function fetchCryptoCom(coin) {
  try {
    const instrument = `${coin}_USD`;
    const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${instrument}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();

    const arr = data?.result?.data;
    if (!Array.isArray(arr) || arr.length === 0) return null;

    const obj = arr[0];
    const priceStr =
      obj.a ??
      obj.last_trade_price ??
      obj.c ??
      null;

    return priceStr ? parseFloat(priceStr) : null;
  } catch {
    return null;
  }
}

// общая функция получения цен
async function fetchAllPrices() {
  const prices = {}; // {exchange: {coin: price}}

  for (const ex of EXCHANGES) {
    prices[ex] = {};
  }

  for (const coin of COINS) {
    prices["Binance US"][coin] = await fetchBinanceUS(coin);
    prices["Kraken"][coin]     = await fetchKraken(coin);
    prices["Crypto.com"][coin] = await fetchCryptoCom(coin);
  }

  console.log("Prices snapshot:", JSON.stringify(prices, null, 2));
  return prices;
}

// ====== АРБИТРАЖНЫЙ ЦИКЛ ======
async function runArbitrage() {
  try {
    const prices = await fetchAllPrices();

    const now   = new Date();
    const nowMs = now.getTime();
    const timeStr = nyTimeString(now);

    for (const coin of COINS) {
      const coinPrices = [];

      for (const ex of EXCHANGES) {
        const p = prices[ex][coin];
        if (p && !isNaN(p)) coinPrices.push({ exchange: ex, price: p });
      }

      for (let i = 0; i < coinPrices.length; i++) {
        for (let j = 0; j < coinPrices.length; j++) {
          if (i === j) continue;

          const buyEx  = coinPrices[i];
          const sellEx = coinPrices[j];

          if (sellEx.price <= buyEx.price) continue;

          const spread =
            ((sellEx.price - buyEx.price) / buyEx.price) * 100;

          if (spread < MIN_SPREAD) continue;

          const key  = `${coin}|${buyEx.exchange}|${sellEx.exchange}`;
          const last = lastSignalTime[key] || 0;
          const diff = nowMs - last;

          // та же пара не чаще 1 раза в 5 минут
          if (diff < REPEAT_INTERVAL_MS) continue;

          lastSignalTime[key] = nowMs;

          signalHistory.push({
            time: nowMs,
            coin,
            buy: buyEx.exchange,
            sell: sellEx.exchange,
            spread,
          });

          const emoji = coinEmoji(coin);
          const text =
            `${emoji} ${coin}\n` +
            `Купить: <b>${buyEx.exchange}</b> — $${buyEx.price.toFixed(4)} 💵\n` +
            `Продать: <b>${sellEx.exchange}</b> — $${sellEx.price.toFixed(4)} 💵\n\n` +
            `Спред: <b>${spread.toFixed(2)}%</b>\n` +
            `Время (NY): ${timeStr}`;

          await sendTelegramMessage(text);
        }
      }
    }
  } catch (err) {
    console.error("Arbitrage loop error:", err.message);
    await logToTelegram(`Arbitrage error: ${err.message}`);
  }
}

// ====== АНАЛИТИКА КАЖДЫЕ 3 ЧАСА ======
async function sendAnalytics() {
  try {
    const now      = Date.now();
    const fromTime = now - 3 * 60 * 60 * 1000;

    const recent = signalHistory.filter((s) => s.time >= fromTime);
    signalHistory.length = 0;
    signalHistory.push(...recent);

    if (recent.length === 0) {
      await logToTelegram("Аналитика за 3 часа: сигналов не было.");
      return;
    }

    const totalSignals = recent.length;
    const totalSpread  = recent.reduce((acc, s) => acc + s.spread, 0);
    const avgSpread    = totalSpread / totalSignals;

    const byCoin = {};
    const byPair = {};

    for (const s of recent) {
      if (!byCoin[s.coin]) {
        byCoin[s.coin] = { count: 0, sumSpread: 0 };
      }
      byCoin[s.coin].count += 1;
      byCoin[s.coin].sumSpread += s.spread;

      const pKey = `${s.buy} → ${s.sell}`;
      if (!byPair[pKey]) {
        byPair[pKey] = { count: 0, sumSpread: 0 };
      }
      byPair[pKey].count += 1;
      byPair[pKey].sumSpread += s.spread;
    }

    const topCoin = Object.entries(byCoin).sort(
      (a, b) => b[1].count - a[1].count
    )[0];

    const topPair = Object.entries(byPair).sort(
      (a, b) => b[1].count - a[1].count
    )[0];

    let coinLines = "";
    for (const [coin, st] of Object.entries(byCoin)) {
      const avg = st.sumSpread / st.count;
      coinLines += `${coin}: ${st.count} сигнал(ов), средний спред ${avg.toFixed(
        2
      )}%\n`;
    }

    let pairLines = "";
    for (const [pair, st] of Object.entries(byPair)) {
      const avg = st.sumSpread / st.count;
      pairLines += `${pair}: ${st.count} сигнал(ов), средний спред ${avg.toFixed(
        2
      )}%\n`;
    }

    const text =
      `📊 Аналитика арбитража за 3 часа (NY время):\n\n` +
      `Всего сигналов: <b>${totalSignals}</b>\n` +
      `Суммарный процент спредов: <b>${totalSpread.toFixed(2)}%</b>\n` +
      `Средний спред по всем сигналам: <b>${avgSpread.toFixed(2)}%</b>\n\n` +
      `<b>По монетам:</b>\n${coinLines || "—"}\n` +
      `<b>По парам бирж:</b>\n${pairLines || "—"}\n` +
      (topCoin
        ? `\nТоп монета: <b>${topCoin[0]}</b> (${topCoin[1].count} сигналов)`
        : "") +
      (topPair
        ? `\nТоп пара бирж: <b>${topPair[0]}</b> (${topPair[1].count} сигналов)`
        : "");

    await sendTelegramMessage(text);
  } catch (err) {
    console.error("Analytics error:", err.message);
    await logToTelegram(`Analytics error: ${err.message}`);
  }
}

// ====== TELEGRAM WEBHOOK ======
app.post("/webhook", async (req, res) => {
  const update = req.body;

  try {
    if (update.message) {
      const chatId = update.message.chat.id;
      const text   = update.message.text || "";

      console.log("Incoming message:", update.message);

      if (text === "/start") {
        await fetch(`${TELEGRAM_API}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: "Бот активирован ✅ Я в сети.",
          }),
        });
      }
    }
  } catch (err) {
    console.error("Webhook error:", err.message);
  }

  res.sendStatus(200);
});

// простой GET для проверки
app.get("/", async (_req, res) => {
  res.send("Vlados arbitrage bot is running");
});

// ====== ЗАПУСК СЕРВЕРА ======
app.listen(PORT, async () => {
  console.log("Starting Container");
  console.log(`Server started on port ${PORT}`);

  console.log("Starting arbitrage loop...");
  setInterval(runArbitrage, CHECK_INTERVAL_MS);
  setInterval(sendAnalytics, ANALYTICS_INTERVAL_MS);
});
