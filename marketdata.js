/*
 * 多源行情模块（snapshot.js / selfcheck.js 共用）
 * 目标：稳健获取真实交易所实时价格。任一条源失败自动切换下一条；
 * 只有全部源都失败（或关键币种缺失）才返回 null，上层据此「跳过推进 + 告警」，
 * 绝不回退到合成行情污染交易数据。
 *
 * 拉价源优先级：
 *   1. Binance 镜像 data-api.binance.vision（国内可直连）
 *   2. Binance 官方 api.binance.com
 *   3. Gate.io api.gateio.ws（国内可直连）
 *   4. Bybit api.bybit.com
 *
 * 注意：沙箱内 curl 自动走 egress 代理（HTTP_PROXY/HTTPS_PROXY）。
 */
const { execSync } = require("child_process");

// 主理人可交易的 11 个币 → 对应各交易所的 symbol
const TRADE_COINS = [
  ["BTC", "BTCUSDT"], ["ETH", "ETHUSDT"], ["SOL", "SOLUSDT"], ["BNB", "BNBUSDT"],
  ["DOGE", "DOGEUSDT"], ["PEPE", "PEPEUSDT"], ["SHIB", "SHIBUSDT"], ["WIF", "WIFUSDT"],
  ["BONK", "BONKUSDT"], ["FLOKI", "FLOKIUSDT"], ["MEME", "MEMEUSDT"]
];

// 看板展示用的 16 币行情快照（含 24h 涨跌幅）
const DISPLAY_COINS = [
  "BTCUSDT", "ETHUSDT", "XRPUSDT", "BNBUSDT", "SOLUSDT", "ADAUSDT",
  "TRXUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT",
  "DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "WIFUSDT", "BONKUSDT", "FLOKIUSDT"
];

function httpGet(url, timeoutSeconds) {
  const t = timeoutSeconds || 10;
  return execSync(`curl -sS -m ${t} "${url}"`, {
    encoding: "utf-8",
    timeout: (t + 5) * 1000,
    stdio: ["pipe", "pipe", "pipe"]
  }).trim();
}

function jsonFrom(url, timeoutSeconds) {
  const out = httpGet(url, timeoutSeconds);
  if (!out) throw new Error("empty response");
  return JSON.parse(out);
}

// Binance batch ticker/price（symbols= 批量）
function fromBinance(baseUrl) {
  const q = TRADE_COINS.map((c) => '"' + c[1] + '"').join(",");
  const arr = jsonFrom(baseUrl + "/api/v3/ticker/price?symbols=" + encodeURIComponent("[" + q + "]"), 12);
  if (!Array.isArray(arr) || !arr.length) throw new Error("binance batch parse fail");
  const prices = {};
  for (const it of arr) {
    const sym = String(it.symbol || "");
    const idx = sym.indexOf("USDT");
    const coin = idx > 0 ? sym.slice(0, idx) : sym;
    const px = parseFloat(it.price);
    if (coin && px > 0) prices[coin] = px;
  }
  return prices;
}

function fetchBinanceVision() { return fromBinance("https://data-api.binance.vision"); }
function fetchBinanceApi() { return fromBinance("https://api.binance.com"); }

function fetchGate() {
  const q = TRADE_COINS.map((c) => c[0] + "_USDT").join(",");
  const arr = jsonFrom("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=" + encodeURIComponent(q), 12);
  if (!Array.isArray(arr) || !arr.length) throw new Error("gate tickers parse fail");
  const prices = {};
  for (const it of arr) {
    const coin = String(it.currency_pair || "").split("_")[0];
    const px = parseFloat(it.last);
    if (coin && px > 0) prices[coin] = px;
  }
  return prices;
}

function fetchBybit() {
  const q = TRADE_COINS.map((c) => c[1]).join(",");
  const j = jsonFrom("https://api.bybit.com/v5/market/tickers?category=spot&symbol=" + encodeURIComponent(q), 12);
  const list = j && j.result && j.result.list;
  if (!Array.isArray(list) || !list.length) throw new Error("bybit tickers parse fail");
  const prices = {};
  for (const it of list) {
    const sym = String(it.symbol || "");
    const idx = sym.indexOf("USDT");
    const coin = idx > 0 ? sym.slice(0, idx) : sym;
    const px = parseFloat(it.lastPrice);
    if (coin && px > 0) prices[coin] = px;
  }
  return prices;
}

function validate(prices) {
  for (let i = 0; i < TRADE_COINS.length; i++) {
    const coin = TRADE_COINS[i][0];
    const px = prices && prices[coin];
    if (!px || px <= 0) return false;
  }
  return true;
}

// 返回 { prices, source } 或 null（全部源失败/关键币缺失）
function fetchPrices() {
  const sources = [
    ["binance-vision", fetchBinanceVision],
    ["binance-api", fetchBinanceApi],
    ["gate.io", fetchGate],
    ["bybit", fetchBybit]
  ];
  for (let i = 0; i < sources.length; i++) {
    const name = sources[i][0], fn = sources[i][1];
    try {
      const prices = fn();
      if (validate(prices)) return { prices: prices, source: name };
      // 未经验证则继续尝试下一条源（可能 partial）
    } catch (e) {
      // 尝试下一条源
    }
  }
  return null;
}

// 展示用 16 币 24h 快照（price + 涨跌幅），失败返回 null
function fetchTickers() {
  const q = DISPLAY_COINS.map((s) => '"' + s + '"').join(",");
  const sources = [
    function () {
      const arr = jsonFrom("https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent("[" + q + "]"), 15);
      return arr.map((it) => ({ sym: it.symbol.replace("USDT", ""), price: parseFloat(it.lastPrice) || 0, chg: parseFloat(it.priceChangePercent) || 0 }));
    },
    function () {
      const arr = jsonFrom("https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent("[" + q + "]"), 15);
      return arr.map((it) => ({ sym: it.symbol.replace("USDT", ""), price: parseFloat(it.lastPrice) || 0, chg: parseFloat(it.priceChangePercent) || 0 }));
    },
    function () {
      const pairs = DISPLAY_COINS.map((s) => s.replace("USDT", "") + "_USDT").join(",");
      const arr = jsonFrom("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=" + encodeURIComponent(pairs), 15);
      return arr.map((it) => ({ sym: it.currency_pair.split("_")[0], price: parseFloat(it.last) || 0, chg: parseFloat(it.change_percentage) || 0 }));
    }
  ];
  for (let i = 0; i < sources.length; i++) {
    try {
      const arr = sources[i]();
      if (!Array.isArray(arr) || !arr.length) continue;
      const map = {};
      for (const it of arr) if (it.sym && it.price > 0) map[it.sym] = { price: it.price, chg: it.chg };
      if (map.BTC) return map;
    } catch (e) { /* next source */ }
  }
  return null;
}

module.exports = { TRADE_COINS, DISPLAY_COINS, fetchPrices, fetchTickers };