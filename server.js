// server.js
// Полная версия без Crypto.com

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

// ====== НАСТРОЙКИ БОТА ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_CHAT_ID = 619516861; // твой ID
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// монеты
const COINS = ["SOL", "LTC", "XRP", "ADA"];

// биржи
const EXCHANGES = ["Binance US", "Kraken", "Coinbase", "Gemini", "Bitstamp"];

// минимальный спред
const MIN_SPREAD = 1.3; // %

const CHECK_INTERVAL_MS = 30 * 1000; // каждые 30 сек
const ANTI_SPAM_MS = 5 * 60 * 1000; // 5 минут
const ANALYTICS_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 часа

// антиспам по сигналам: {coin|buy|sell: timestamp}
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

// ====== ПОЛУЧЕНИЕ ЦЕН С БИРЖ ======
async function fetchBinanceUS(coin) {
  try {
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

async function fetchCoinbase(coin) {
  try {
    const url = `https://api.exchange.coinbase.com/products/${coin}-USD/ticker`;
    const res = await fetch(url, {
      headers: { "User-Agent": "vlados-arb-bot" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.price ? parseFloat(data.price) : null;
  } catch {
    return null;
  }
}

async function fetchGemini(coin) {
  try {
    const symbol = `${coin.toLowerCase()}usd`;
    const url = `https://api.gemini.com/v1/pubticker/${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.last) return null;
    return parseFloat(data.last);
  } catch {
    return null;
  }
}

async function fetchBitstamp(coin) {
  try {
    const symbol = `${coin.toLowerCase()}usd`;
    const url = `https://www.bitstamp.net/api/v2/ticker/${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.last) return null;
    return parseFloat(data.last);
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
    // Binance US
    prices["Binance US"][coin] = await fetchBinanceUS(coin);

    // Kraken
    prices["Kraken"][coin] = await fetchKraken(coin);

    // Coinbase
    prices["Coinbase"][coin] = await fetchCoinbase(coin);

    // Gemini (если нет монеты — вернёт null)
    prices["Gemini"][coin] = await fetchGemini(coin);

    // Bitstamp (если нет монеты — null)
    prices["Bitstamp"][coin] = await fetchBitstamp(coin);
  }

  console.log("Prices snapshot:", JSON.stringify(prices, null, 2));
  return prices;
}

// ====== АРБИТРАЖНЫЙ ЦИКЛ ======
async function runArbitrage() {
  try {
    const prices = await fetchAllPrices();

    const now = new Date();
    const timeStr = nyTimeString(now);

    for (const coin of COINS) {
      const coinPrices = [];

      for (const ex of EXCHANGES) {
        const p = prices[ex][coin];
        if (p && !isNaN(p)) {
          coinPrices.push({ exchange: ex, price: p });
        }
      }

      // перебираем все пары бирж
      for (let i = 0; i < coinPrices.length; i++) {
        for (let j = 0; j < coinPrices.length; j++) {
          if (i === j) continue;

          const buyEx = coinPrices[i];
          const sellEx = coinPrices[j];

          if (sellEx.price <= buyEx.price) continue;

          const spread =
            ((sellEx.price - buyEx.price) / buyEx.price) * 100;

          if (spread < MIN_SPREAD) continue;

          const key = `${coin}|${buyEx.exchange}|${sellEx.exchange}`;
          const last = lastSignalTime[key] || 0;
          const diff = now.getTime() - last;

          if (diff < ANTI_SPAM_MS) {
            // антиспам: слишком часто по этой паре
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

          // формируем текст сигнала
          const emoji = coinEmoji(coin);
          const text =
            `${coin} ${emoji}\n` +
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
    const now = Date.now();
    const fromTime = now - 3 * 60 * 60 * 1000;

    // чистим старую историю
    const recent = signalHistory.filter((s) => s.time >= fromTime);
    // заменяем массив
    signalHistory.length = 0;
    signalHistory.push(...recent);

    if (recent.length === 0) {
      await logToTelegram(
        "Аналитика за 3 часа: сигналов не было."
      );
      return;
    }

    const totalSignals = recent.length;
    const totalSpread = recent.reduce(
      (acc, s) => acc + s.spread,
      0
    );
    const avgSpread = totalSpread / totalSignals;

    // статистика по монетам
    const byCoin = {};
    // статистика по парам бирж
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

    // топ монета
    const topCoin = Object.entries(byCoin).sort(
      (a, b) => b[1].count - a[1].count
    )[0];

    // топ пара бирж
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
      `Суммарный процент спредов: <b>${totalSpread.toFixed(
        2
      )}%</b>\n` +
      `Средний спред по всем сигналам: <b>${avgSpread.toFixed(
        2
      )}%</b>\n\n` +
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
  res.send("Test message sent to Telegram");
});

// установка вебхука при старте
async function setupWebhook() {
  try {
    const domain =
      process.env.RAILWAY_PUBLIC_DOMAIN ||
      process.env.WEBHOOK_URL; // можно задать вручную

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
  // арбитраж каждые 30 сек
  setInterval(runArbitrage, CHECK_INTERVAL_MS);
  // аналитика каждые 3 часа
  setInterval(sendAnalytics, ANALYTICS_INTERVAL_MS);
});
