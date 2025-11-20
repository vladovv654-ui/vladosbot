// server.js — обновлённый бот Владоса

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ===============================
//     ТУТ ВСТАВЛЯЕШЬ ТОКЕН САМ
// ===============================
const BOT_TOKEN = "8214118277:AAG0BJyoEZ76LbB5bnN1zGfqZ5oivu4khxA";
const TELEGRAM_CHAT_ID = 619516861;
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Монеты
const COINS = ["SOL", "LTC", "XRP", "ADA", "TRX"];

// Биржи
const EXCHANGES = ["Binance US", "Kraken", "Crypto.com", "Coinbase", "Gemini", "Bitstamp"];

// Порог спреда
const MIN_SPREAD = 1.1;

// Интервалы
const CHECK_INTERVAL_MS = 30 * 1000;      // каждые 30 сек
const REPEAT_INTERVAL_MS = 5 * 60 * 1000; // повтор сигнала каждые 5 минут

// Запоминание сигналов
const lastSignal = {};

function nyTime() {
  return new Date().toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendMsg(text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

function coinIcon(c) {
  return {
    SOL: "🟣",
    LTC: "⚪️",
    XRP: "💎",
    ADA: "🔵",
    TRX: "🔺",
  }[c] || "🟡";
}

// ====== API ======

async function fetchBinanceUS(coin) {
  try {
    const url = `https://api.binance.us/api/v3/ticker/price?symbol=${coin}USD`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j = await r.json();
    return parseFloat(j.price);
  } catch { return null; }
}

async function fetchKraken(coin) {
  try {
    const url = `https://api.kraken.com/0/public/Ticker?pair=${coin}USD`;
    const r = await fetch(url);
    const j = await r.json();
    const key = Object.keys(j.result || {})[0];
    if (!key) return null;
    return parseFloat(j.result[key].c[0]);
  } catch { return null; }
}

async function fetchCrypto(coin) {
  try {
    const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${coin}_USD`;
    const r = await fetch(url);
    const j = await r.json();
    return parseFloat(j?.result?.data?.last_trade_price || null);
  } catch { return null; }
}

async function fetchCoinbase(coin) {
  try {
    const url = `https://api.exchange.coinbase.com/products/${coin}-USD/ticker`;
    const r = await fetch(url, { headers: { "User-Agent": "vlados" } });
    const j = await r.json();
    return parseFloat(j.price || null);
  } catch { return null; }
}

async function fetchGemini(coin) {
  try {
    const url = `https://api.gemini.com/v1/pubticker/${coin.toLowerCase()}usd`;
    const r = await fetch(url);
    const j = await r.json();
    return parseFloat(j.last || null);
  } catch { return null; }
}

async function fetchBitstamp(coin) {
  try {
    const url = `https://www.bitstamp.net/api/v2/ticker/${coin.toLowerCase()}usd`;
    const r = await fetch(url);
    const j = await r.json();
    return parseFloat(j.last || null);
  } catch { return null; }
}

// ====== Сбор цен ======

async function fetchPrices() {
  const p = {};

  for (const ex of EXCHANGES) p[ex] = {};

  for (const c of COINS) {
    p["Binance US"][c] = await fetchBinanceUS(c);
    p["Kraken"][c]     = await fetchKraken(c);
    p["Crypto.com"][c] = await fetchCrypto(c);
    p["Coinbase"][c]   = await fetchCoinbase(c);
    p["Gemini"][c]     = await fetchGemini(c);
    p["Bitstamp"][c]   = await fetchBitstamp(c);
  }

  return p;
}

// ====== Основной арбитраж ======

async function runArb() {
  const prices = await fetchPrices();
  const now = Date.now();
  const time = nyTime();

  for (const coin of COINS) {
    const arr = [];

    for (const ex of EXCHANGES) {
      const price = prices[ex][coin];
      if (price) arr.push({ ex, price });
    }

    for (let i = 0; i < arr.length; i++) {
      for (let j = 0; j < arr.length; j++) {
        if (i === j) continue;

        const buy = arr[i];
        const sell = arr[j];

        if (sell.price <= buy.price) continue;

        const spread = ((sell.price - buy.price) / buy.price) * 100;
        if (spread < MIN_SPREAD) continue;

        const key = `${coin}|${buy.ex}|${sell.ex}`;
        const last = lastSignal[key] || 0;

        if (now - last < REPEAT_INTERVAL_MS) continue;

        lastSignal[key] = now;

        await sendMsg(
          `${coinIcon(coin)} <b>${coin}</b>\n` +
          `Купить: <b>${buy.ex}</b> — $${buy.price.toFixed(4)}\n` +
          `Продать: <b>${sell.ex}</b> — $${sell.price.toFixed(4)}\n\n` +
          `Спред: <b>${spread.toFixed(2)}%</b>\n` +
          `Время (NY): ${time}`
        );
      }
    }
  }
}

app.get("/", (req, res) => res.send("Vlados Bot Running"));

app.listen(PORT, () => {
  console.log(`Server started on ${PORT}`);
  setInterval(runArb, CHECK_INTERVAL_MS);
});
