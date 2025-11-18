import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 ТВОЙ TELEGRAM (НЕ МЕНЯЮ)
const TELEGRAM_TOKEN =
  "7795199727:AAF3bS3T905-wDuVz0901qp8Wk2p41r3igk";
const TELEGRAM_CHAT_ID = 619516861;

// МОНЕТЫ И БИРЖИ
const COINS = ["SOL", "LTC", "XRP", "ADA"];
const THRESHOLD = 1.3; // порог спреда в %
const SPREAD_RESEND_STEP = 0.2; // на сколько % должен вырасти спред, чтобы снова слать сигнал
const MIN_RESEND_MINUTES = 3; // минимум минут между одинаковыми сигналами

// Пауза между циклами (от 5 до 10 секунд)
const CHECK_MIN_DELAY_MS = 5000;
const CHECK_MAX_DELAY_MS = 10000;

// Отчёт раз в 3 часа
const SUMMARY_INTERVAL_MS = 3 * 60 * 60 * 1000;

// Пары для Kraken
const KRAKEN_PAIRS = {
  SOL: "SOLUSD",
  LTC: "LTCUSD",
  XRP: "XRPUSD",
  ADA: "ADAUSD",
};

// --- внутреннее состояние ---

// Для антиспама: последний сигнал по (coin + buyEx + sellEx)
const lastSignals = {}; // key: "SOL-binance-crypto" -> { lastSpread, lastTime }

// Для отчёта: лучший спред за 3 часа по каждой монете
const stats = {};
let statsWindowStart = Date.now();

// ================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =================

function coinEmoji(coin) {
  switch (coin) {
    case "SOL":
      return "☀️";
    case "LTC":
      return "💠";
    case "XRP":
      return "💧";
    case "ADA":
      return "🔷";
    default:
      return "💰";
  }
}

function exName(code) {
  switch (code) {
    case "binance":
      return "Binance US";
    case "crypto":
      return "Crypto.com";
    case "kraken":
      return "Kraken";
    default:
      return code;
  }
}

function getNYDateObj(ms) {
  const date = ms ? new Date(ms) : new Date();
  const str = date.toLocaleString("ru-RU", {
    timeZone: "America/New_York",
    hour12: false,
  });
  // формат типа "18.11.2025, 12:15:32"
  const [datePart, timePart] = str.split(", ");
  const [day, month, year] = datePart.split(".");
  const [hour, minute] = timePart.split(":");
  return { day, month, year, hour, minute };
}

function getNYTimeString(ms) {
  const { day, month, year, hour, minute } = getNYDateObj(ms);
  return `${day}.${month}.${year} ${hour}:${minute}`;
}

function getPeriodString(startMs, endMs) {
  const s = getNYDateObj(startMs);
  const e = getNYDateObj(endMs);
  const startStr = `${s.day}.${s.month}.${s.year} ${s.hour}:${s.minute}`;
  const endStr = `${e.day}.${e.month}.${e.year} ${e.hour}:${e.minute}`;
  return `${startStr} – ${endStr}`;
}

// Отправка сообщения в Telegram
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram не настроен (нет токена или chat_id)");
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "Markdown",
      }),
    });

    const bodyText = await res.text();
    console.log("Ответ Telegram:", res.status, bodyText);
  } catch (e) {
    console.error("Ошибка отправки в Telegram:", e.message);
  }
}

// ================= ЗАПРОСЫ ЦЕН =================

async function fetchBinanceUS(coin) {
  const symbol = `${coin}USDT`;
  const url = `https://api.binance.us/api/v3/ticker/price?symbol=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`BinanceUS HTTP ${res.status}`);
  const data = await res.json();
  return parseFloat(data.price);
}

async function fetchCryptoCom(coin) {
  const symbol = `${coin}_USDT`;
  const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${symbol}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Crypto.com HTTP ${res.status}`);
  const data = await res.json();
  if (!data.result || !data.result.data || !data.result.data[0]) {
    throw new Error("Crypto.com пустой ответ");
  }
  // берём ask
  const price = parseFloat(data.result.data[0].a);
  return price;
}

async function fetchKraken(coin) {
  const pair = KRAKEN_PAIRS[coin];
  const url = `https://api.kraken.com/0/public/Ticker?pair=${pair}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kraken HTTP ${res.status}`);
  const data = await res.json();
  const result = data.result;
  const key = Object.keys(result)[0];
  const ticker = result[key];
  // берём last trade price
  const price = parseFloat(ticker.c[0]);
  return price;
}

// Получить цены с трёх бирж
async function getPrices(coin) {
  const out = {};
  const tasks = [
    ["binance", fetchBinanceUS],
    ["crypto", fetchCryptoCom],
    ["kraken", fetchKraken],
  ];

  for (const [name, fn] of tasks) {
    try {
      const p = await fn(coin);
      out[name] = p;
    } catch (e) {
      console.error(`Ошибка цены ${coin} на ${name}:`, e.message);
    }
  }
  return out;
}

// ================= ФОРМАТ СИГНАЛА =================

function formatSignal(coin, buyEx, sellEx, buyPrice, sellPrice, diffPercent) {
  const emoji = coinEmoji(coin);
  const oneProfit = sellPrice - buyPrice;
  const timeStr = getNYTimeString();

  const lines = [
    `${emoji} *${coin}*`,
    `📊 Разница: *${diffPercent.toFixed(2)}%*`,
    "",
    `🟢 Покупать: *${exName(buyEx)}* по *$${buyPrice.toFixed(4)} 💵*`,
    `🔴 Продавать: *${exName(sellEx)}* по *$${sellPrice.toFixed(4)} 💵*`,
    "",
    `💰 Спред на 1 ${coin}: *$${oneProfit.toFixed(4)} 💵*`,
    "",
    `⏰ Время: *${timeStr} (New York)*`,
  ];

  return lines.join("\n");
}

// ================= ОСНОВНОЙ ЦИКЛ ПРОВЕРКИ =================

async function checkOnce() {
  const now = Date.now();
  console.log("Проверяю арбитраж...", new Date().toISOString());

  for (const coin of COINS) {
    try {
      const prices = await getPrices(coin);
      const entries = Object.entries(prices);

      if (entries.length < 2) continue;

      // сортируем по цене
      entries.sort((a, b) => a[1] - b[1]);
      const [buyEx, buyPrice] = entries[0]; // самый дешёвый
      const [sellEx, sellPrice] = entries[entries.length - 1]; // самый дорогой

      const diffPercent = ((sellPrice - buyPrice) / buyPrice) * 100;

      if (diffPercent < THRESHOLD) {
        updateStats(coin, buyEx, sellEx, buyPrice, sellPrice, diffPercent);
        continue;
      }

      const key = `${coin}-${buyEx}-${sellEx}`;
      const prev = lastSignals[key];
      let shouldSend = false;

      if (!prev) {
        shouldSend = true;
      } else {
        const minutesPassed = (now - prev.lastTime) / 60000;
        if (
          minutesPassed >= MIN_RESEND_MINUTES ||
          diffPercent >= prev.lastSpread + SPREAD_RESEND_STEP
        ) {
          shouldSend = true;
        }
      }

      updateStats(coin, buyEx, sellEx, buyPrice, sellPrice, diffPercent);

      if (!shouldSend) continue;

      lastSignals[key] = {
        lastSpread: diffPercent,
        lastTime: now,
      };

      const msg = formatSignal(
        coin,
        buyEx,
        sellEx,
        buyPrice,
        sellPrice,
        diffPercent
      );
      await sendTelegram(msg);
    } catch (e) {
      console.error(`Ошибка в checkOnce для ${coin}:`, e.message);
    }
  }

  // 🔧 тут у тебя была ошибка: CHECK_MAX_DELAY_MS - CHECK_MAX_DELAY_MS (всегда 0)
  const delay =
    CHECK_MIN_DELAY_MS +
    Math.floor(Math.random() * (CHECK_MAX_DELAY_MS - CHECK_MIN_DELAY_MS));

  console.log(`Следующая проверка через ${delay} мс`);
  setTimeout(checkOnce, delay);
}

// Обновляем статистику для отчёта
function updateStats(coin, buyEx, sellEx, buyPrice, sellPrice, diffPercent) {
  const prev = stats[coin] || { maxDiff: 0 };
  if (diffPercent > prev.maxDiff) {
    stats[coin] = {
      maxDiff: diffPercent,
      buyEx,
      sellEx,
      buyPrice,
      sellPrice,
    };
  }
}

// ================= ОТЧЁТ РАЗ В 3 ЧАСА =================

async function sendSummary() {
  const now = Date.now();
  const period = getPeriodString(statsWindowStart, now);
  let text = "📊 *Арбитражный отчёт (последние 3 часа)*\n\n";

  for (const coin of COINS) {
    const emoji = coinEmoji(coin);
    const st = stats[coin];

    if (!st || st.maxDiff < THRESHOLD) {
      text += `${emoji} *${coin}*\n`;
      text += `– Возможностей ≥ ${THRESHOLD}% не было\n\n`;
    } else {
      text += `${emoji} *${coin}*\n`;
      text += `– Максимальная разница: *${st.maxDiff.toFixed(2)}%*\n`;
      text += `– Лучший вариант: *покупать ${exName(
        st.buyEx
      )} → продавать ${exName(st.sellEx)}*\n`;
      text += `– Покупка: *$${st.buyPrice.toFixed(
        4
      )} 💵*, продажа: *$${st.sellPrice.toFixed(4)} 💵*\n\n`;
    }
  }

  text += `⏰ Период: *${period} (New York)*`;

  await sendTelegram(text);

  for (const coin of COINS) {
    stats[coin] = { maxDiff: 0 };
  }
  statsWindowStart = now;
}

function startSummaryTimer() {
  setInterval(sendSummary, SUMMARY_INTERVAL_MS);
}

// ================= ЗАПУСК =================

app.get("/", (req, res) => {
  res.send("Vlados arbitrage bot is running");
});

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);

  // 🔔 СТАРТОВОЕ СООБЩЕНИЕ В TELEGRAM ПРИ ЗАПУСКЕ
  sendTelegram("🚀 Vlados arbitrage bot запущен, начинаю мониторинг спреда.");

  // старт цикла и отчётов
  checkOnce();
  startSummaryTimer();
});
