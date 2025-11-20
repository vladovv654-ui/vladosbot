// server.js
// Новый бот: Binance US + Crypto.com + Kraken
// Монеты: SOL, LTC, XRP, ADA
// Спред >= 1.1%, цены из стакана (best bid / best ask)
// Сигнал по одной паре не чаще 1 раза в 5 минут

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ====== НАСТРОЙКИ БОТА ======

// ❗ ВАЖНО: В Railway в Variables создай переменную BOT_TOKEN и вставь туда свой токен.
// Тут мы его читаем:

const BOT_TOKEN = "8214118277:AAG0BJyoEZ76LbB5bnN1zGfqZ5oivu4khxA"; // твой бот-токен из BotFather
const TELEGRAM_CHAT_ID = 619516861; // твой ID
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// монеты
const COINS = ["SOL", "LTC", "XRP", "ADA"];

// биржи
const EXCHANGES = ["Binance US", "Crypto.com", "Kraken"];

// минимальный спред
const MIN_SPREAD = 1.1; // %

// как часто проверяем рынок
const CHECK_INTERVAL_MS = 30 * 1000; // каждые 30 сек

// как часто можно присылать сигнал по одной и той же паре бирж
const REPEAT_SIGNAL_MS = 5 * 60 * 1000; // 5 минут

// аналитика раз в 3 часа
const ANALYTICS_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 часа

// {coin|buy|sell: timestamp}
const lastSignalTime = {};

// для аналитики
const signalHistory = []; // {time, coin, buy, sell, spread}

// ====== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======
function nyTimeString(date = new Date()) {
  return date.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function sendTelegramMessage(text) {
  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is not set");
    return;
  }
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
    case "SOL":
      return "🟣";
    case "LTC":
      return "⚪️";
    case "XRP":
      return "💎";
    case "ADA":
      return "🔵";
    default:
      return "🟡";
  }
}

// ====== ПОЛУЧЕНИЕ ЦЕН ИЗ СТАКАНА (ORDER BOOK) ======
// Функции возвращают объект { bid, ask } или null, если монеты нет

// Binance US — пары вида SOLUSDT, LTCUSDT и т.д.
async function fetchBinanceUSOrderBook(coin) {
  try {
    const symbol = `${coin}USDT`;
    const url = `https://api.binance.us/api/v3/depth?symbol=${symbol}&limit=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.bids || !data.asks || !data.bids.length || !data.asks.length) {
      return null;
    }
    const bestBid = parseFloat(data.bids[0][0]); // лучшая цена, по которой Готовы КУПИТЬ
    const bestAsk = parseFloat(data.asks[0][0]); // лучшая цена, по которой Готовы ПРОДАТЬ
    return { bid: bestBid, ask: bestAsk };
  } catch (e) {
    return null;
  }
}

// Kraken — пары SOLUSD, LTCUSD, XRPUSD, ADAUSD
async function fetchKrakenOrderBook(coin) {
  try {
    const pair = `${coin}USD`;
    const url = `https://api.kraken.com/0/public/Depth?pair=${pair}&count=5`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const key = Object.keys(data.result || {})[0];
    if (!key) return null;
    const ob = data.result[key];
    if (!ob.bids || !ob.asks || !ob.bids.length || !ob.asks.length) {
      return null;
    }
    const bestBid = parseFloat(ob.bids[0][0]);
    const bestAsk = parseFloat(ob.asks[0][0]);
    return { bid: bestBid, ask: bestAsk };
  } catch (e) {
    return null;
  }
}

// Crypto.com Exchange — пары SOL_USDT, LTC_USDT, XRP_USDT, ADA_USDT
async function fetchCryptoComOrderBook(coin) {
  try {
    const instrument = `${coin}_USDT`;
    const url = `https://api.crypto.com/v2/public/get-book?instrument_name=${instrument}&depth=1`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.result || !data.result.data || !data.result.data.length) {
      return null;
    }
    const book = data.result.data[0];
    if (!book.bids || !book.asks || !book.bids.length || !book.asks.length) {
      return null;
    }
    const bestBid = parseFloat(book.bids[0][0]);
    const bestAsk = parseFloat(book.asks[0][0]);
    return { bid: bestBid, ask: bestAsk };
  } catch (e) {
    return null;
  }
}

// общая функция получения стаканов
// books = { "Binance US": {SOL: {bid,ask}, ...}, "Crypto.com": {...}, "Kraken": {...} }
async function fetchAllBooks() {
  const books = {};
  for (const ex of EXCHANGES) {
    books[ex] = {};
  }

  for (const coin of COINS) {
    books["Binance US"][coin] = await fetchBinanceUSOrderBook(coin);
    books["Crypto.com"][coin] = await fetchCryptoComOrderBook(coin);
    books["Kraken"][coin] = await fetchKrakenOrderBook(coin);
  }

  console.log("Order books snapshot:", JSON.stringify(books, null, 2));
  return books;
}

// ====== АРБИТРАЖНЫЙ ЦИКЛ ======
async function runArbitrage() {
  try {
    const books = await fetchAllBooks();

    const now = new Date();
    const timeStr = nyTimeString(now);

    for (const coin of COINS) {
      const coinMarkets = [];

      for (const ex of EXCHANGES) {
        const ob = books[ex][coin];
        if (ob && !isNaN(ob.bid) && !isNaN(ob.ask)) {
          coinMarkets.push({
            exchange: ex,
            bid: ob.bid,
            ask: ob.ask,
          });
        }
      }

      // перебираем все пары бирж
      for (let i = 0; i < coinMarkets.length; i++) {
        for (let j = 0; j < coinMarkets.length; j++) {
          if (i === j) continue;

          // Покупаем по аску на дешёвой бирже, продаём по биду на дорогой
          const buyEx = coinMarkets[i];
          const sellEx = coinMarkets[j];

          const buyPrice = buyEx.ask;
          const sellPrice = sellEx.bid;

          if (!buyPrice || !sellPrice) continue;
          if (sellPrice <= buyPrice) continue;

          const spread =
            ((sellPrice - buyPrice) / buyPrice) * 100;

          if (spread < MIN_SPREAD) continue;

          const key = `${coin}|${buyEx.exchange}|${sellEx.exchange}`;
          const last = lastSignalTime[key] || 0;
          const diff = now.getTime() - last;

          // тот самый "вариант 2": по этой паре сигнал не чаще, чем раз в 5 минут
          if (diff < REPEAT_SIGNAL_MS) {
            continue;
          }

          lastSignalTime[key] = now.getTime();

          // сохраняем в историю для аналитики
          signalHistory.push({
            time: now.getTime(),
            coin,
            buy: buyEx.exchange,
            sell: sellEx.exchange,
            spread,
          });

          const emoji = coinEmoji(coin);

          const text =
            `${coin} ${emoji}\n` +
            `Купить: <b>${buyEx.exchange}</b> — $${buyPrice.toFixed(4)} 💵 (ask)\n` +
            `Продать: <b>${sellEx.exchange}</b> — $${sellPrice.toFixed(4)} 💵 (bid)\n\n` +
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
    const now = Date.now();
    const fromTime = now - 3 * 60 * 60 * 1000;

    // чистим старую историю
    const recent = signalHistory.filter((s) => s.time >= fromTime);
    signalHistory.length = 0;
    signalHistory.push(...recent);

    if (recent.length === 0) {
      await logToTelegram("Аналитика за 3 часа: сигналов не было.");
      return;
    }

    const totalSignals = recent.length;
    const totalSpread = recent.reduce((acc, s) => acc + s.spread, 0);
    const avgSpread = totalSpread / totalSignals;

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
      `📊 Аналитика арбитража за 3 часа (NY):\n\n` +
      `Всего сигналов: <b>${totalSignals}</b>\n` +
      `Суммарный спред: <b>${totalSpread.toFixed(2)}%</b>\n` +
      `Средний спред: <b>${avgSpread.toFixed(2)}%</b>\n\n` +
      `<b>По монетам:</b>\n${coinLines}\n` +
      `<b>По парам бирж:</b>\n${pairLines}\n` +
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
      const text = update.message.text || "";

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
  res.send("Arbitrage bot is running");
});

// установка вебхука при старте
async function setupWebhook() {
  try {
    const domain =
      process.env.RAILWAY_PUBLIC_DOMAIN || process.env.WEBHOOK_URL;

    if (!domain) {
      console.log("Webhook domain is not set, skip setWebhook");
      return;
    }

    const url = domain.startsWith("http")
      ? `${domain}/webhook`
      : `https://${domain}/webhook`;

    const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const data = await res.json();
    console.log("setWebhook result:", data);
    await logToTelegram(`Webhook: ${data.ok ? "OK" : "FAIL"} (${url})`);
  } catch (err) {
    console.error("setWebhook error:", err.message);
  }
}

// ====== ЗАПУСК СЕРВЕРА ======
app.listen(PORT, async () => {
  console.log("Starting Container");
  console.log(`Server started on port ${PORT}`);

  await setupWebhook();

  console.log("Starting arbitrage loop...");
  setInterval(runArbitrage, CHECK_INTERVAL_MS);
  setInterval(sendAnalytics, ANALYTICS_INTERVAL_MS);
});
