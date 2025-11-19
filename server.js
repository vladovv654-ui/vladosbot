import express from "express";
import fetch from "node-fetch";

// 🔑 Настройки Telegram
const TELEGRAM_TOKEN = process.env.BOT_TOKEN; // токен бота из переменной Railway
const TELEGRAM_CHAT_ID = 619516861; // твой Telegram ID (куда идут сигналы и логи)

// Домен Railway, куда Telegram шлет webhook
const RAILWAY_URL =
  process.env.RAILWAY_PUBLIC_DOMAIN ||
  "https://vladosbot-production.up.railway.app";

const app = express();
app.use(express.json());

// ================= ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =================

// Время Нью-Йорка HH:MM
function getNewYorkTimeString() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const hour = parts.find((p) => p.type === "hour").value;
  const minute = parts.find((p) => p.type === "minute").value;
  return `${hour}:${minute}`;
}

// Отправка сообщения в Telegram (основная)
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

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    console.log("sendMessage result:", data);
  } catch (e) {
    console.error("Ошибка при отправке в Telegram:", e);
  }
}

// Логирование в Telegram как админ-канал
async function logToTelegram(text) {
  await sendTelegramMessage(`📝 LOG:\n${text}`);
}

// ================= HTTP МАРШРУТЫ =================

app.get("/", (req, res) => {
  res.send("VST Arbitrage bot is running ✅");
});

app.get("/test", async (req, res) => {
  try {
    await sendTelegramMessage("Тест: бот жив, токен рабочий ✅");
    res.send("Test message sent to Telegram");
  } catch (e) {
    console.error("Ошибка при отправке теста:", e);
    res.status(500).send("Ошибка при отправке в Telegram");
  }
});

// Webhook от Telegram
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
    await logToTelegram(
      `Webhook установлен: ${data.ok ? "OK" : "ERROR"} (${webhookUrl})`
    );
  } catch (e) {
    console.error("Ошибка при установке webhook:", e);
    await logToTelegram(`❌ Ошибка при установке webhook: ${e.message}`);
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

// Порог спреда (1.3% и выше)
const SPREAD_THRESHOLD = 1.3;

// Интервал проверки (30 секунд)
const CHECK_INTERVAL_MS = 30_000;

// Антиспам: 5 минут на одну и ту же пару (монета + buyEx + sellEx)
const ANTI_SPAM_MINUTES = 5;

// Хранилище последних сигналов для антиспама и аналитики
const lastSignals = {}; // ключ: "COIN-BUYEX-SELLEX" -> timestamp
const signalsHistory = []; // массив { timestamp, symbol, buyEx, sellEx, spread }

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
    await logToTelegram(`❌ Binance US error: ${e.message}`);
    return null;
  }
}

// Получение цены с Crypto.com (ИСПРАВЛЕНО: без null)
async function getCryptoComPrice(instrument) {
  try {
    const url = `https://api.crypto.com/v2/public/get-ticker?instrument_name=${instrument}`;
    const res = await fetch(url);
    const data = await res.json();

    // Ожидаем структуру:
    // { result: { data: [ { c: "LAST_PRICE", ... } ] } }
    if (!data.result || !data.result.data || !data.result.data.length) {
      return null;
    }

    const ticker = data.result.data[0];
    if (!ticker.c) return null;

    return parseFloat(ticker.c); // last price
  } catch (e) {
    console.error("Crypto.com error:", e);
    await logToTelegram(`❌ Crypto.com error: ${e.message}`);
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
    await logToTelegram(`❌ Kraken error: ${e.message}`);
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

// Проверяем спреды и шлём сигналы
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
            await maybeSendSignal(
              symbol,
              emoji,
              buyEx,
              sellEx,
              buyPrice,
              sellPrice,
              spread
            );
          }
        }
      }
    }
  } catch (e) {
    console.error("checkArbitrage error:", e);
    await logToTelegram(`❌ checkArbitrage error: ${e.message}`);
  }
}

// Антиспам + отправка сигнала + запись в историю
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
    // Уже слали недавно — пропускаем
    return;
  }

  lastSignals[key] = now;

  const nyTimeStr = getNewYorkTimeString();

  const msg =
    `${symbol} ${emoji}\n` +
    `Купить: *${buyEx}* — $${buyPrice.toFixed(4)} 💵\n` +
    `Продать: *${sellEx}* — $${sellPrice.toFixed(4)} 💵\n\n` +
    `Спред: *${spread.toFixed(2)}%*\n` +
    `Время (NY): ${nyTimeStr}`;

  await sendTelegramMessage(msg + "\n");

  // сохраняем в историю для аналитики
  signalsHistory.push({
    timestamp: now,
    symbol,
    buyEx,
    sellEx,
    spread,
  });
}

// Запускаем периодический арбитражный цикл
function startArbitrageLoop() {
  console.log("Starting arbitrage loop...");
  logToTelegram(
    `🚀 Старт арбитража\nПорог: ${SPREAD_THRESHOLD}%\nИнтервал: ${
      CHECK_INTERVAL_MS / 1000
    } сек\nАнтиспам: ${ANTI_SPAM_MINUTES} мин`
  );
  checkArbitrage(); // первый запуск сразу
  setInterval(checkArbitrage, CHECK_INTERVAL_MS);
}

// ================ АНАЛИТИКА КАЖДЫЕ 3 ЧАСА ================

const ANALYTICS_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 часа

async function sendAnalyticsReport() {
  const now = Date.now();
  const threeHoursAgo = now - 3 * 60 * 60 * 1000;

  // Берём только последние 3 часа
  const recent = signalsHistory.filter((s) => s.timestamp >= threeHoursAgo);

  // Очищаем историю от более старых записей
  const freshHistory = signalsHistory.filter((s) => s.timestamp >= threeHoursAgo);
  signalsHistory.length = 0;
  signalsHistory.push(...freshHistory);

  const nyTimeStr = getNewYorkTimeString();

  if (recent.length === 0) {
    await sendTelegramMessage(
      `📊 Аналитика арбитража за 3 часа (NY)\nВремя отчёта: ${nyTimeStr}\n\nСигналов не было.`
    );
    return;
  }

  const totalSignals = recent.length;
  const totalSpread = recent.reduce((sum, s) => sum + s.spread, 0);
  const avgSpread = totalSpread / totalSignals;

  // Статистика по монетам
  const coinStats = {};
  for (const s of recent) {
    if (!coinStats[s.symbol]) {
      coinStats[s.symbol] = { count: 0, totalSpread: 0 };
    }
    coinStats[s.symbol].count += 1;
    coinStats[s.symbol].totalSpread += s.spread;
  }

  // Статистика по парам бирж
  const pairStats = {};
  for (const s of recent) {
    const pairKey = `${s.buyEx} → ${s.sellEx}`;
    if (!pairStats[pairKey]) {
      pairStats[pairKey] = { count: 0, totalSpread: 0 };
    }
    pairStats[pairKey].count += 1;
    pairStats[pairKey].totalSpread += s.spread;
  }

  // Топ монета
  let topCoin = null;
  let topCoinData = null;
  for (const [symbol, stat] of Object.entries(coinStats)) {
    if (!topCoin || stat.count > topCoinData.count) {
      topCoin = symbol;
      topCoinData = stat;
    }
  }

  // Топ пара бирж
  let topPair = null;
  let topPairData = null;
  for (const [pair, stat] of Object.entries(pairStats)) {
    if (!topPair || stat.count > topPairData.count) {
      topPair = pair;
      topPairData = stat;
    }
  }

  let text = `📊 Аналитика арбитража за 3 часа (NY)\n`;
  text += `Время отчёта: ${nyTimeStr}\n\n`;
  text += `Всего сигналов: *${totalSignals}*\n`;
  text += `Средний спред по всем: *${avgSpread.toFixed(2)}%*\n`;
  text += `Суммарный процент всех спредов: *${totalSpread.toFixed(2)}%*\n\n`;

  text += `По монетам:\n`;
  for (const [symbol, stat] of Object.entries(coinStats)) {
    const avg = stat.totalSpread / stat.count;
    text += `• ${symbol}: сигналов ${stat.count}, средний спред ${avg
      .toFixed(2)
      .toString()}%\n`;
  }

  if (topCoin && topCoinData) {
    const avgTop = topCoinData.totalSpread / topCoinData.count;
    text += `\nТоп монета: *${topCoin}* — сигналов ${topCoinData.count}, средний спред ${avgTop
      .toFixed(2)
      .toString()}%\n`;
  }

  if (topPair && topPairData) {
    const avgPair = topPairData.totalSpread / topPairData.count;
    text += `Топ пара бирж: *${topPair}* — сигналов ${topPairData.count}, средний спред ${avgPair
      .toFixed(2)
      .toString()}%\n`;
  }

  await sendTelegramMessage(text);
}

// Запускаем цикл аналитики
function startAnalyticsLoop() {
  console.log("Starting analytics loop (3h)...");
  setInterval(sendAnalyticsReport, ANALYTICS_INTERVAL_MS);
}

// ================== START SERVER ==================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  registerWebhook();
  startArbitrageLoop();
  startAnalyticsLoop();
});
