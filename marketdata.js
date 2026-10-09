/*
 * marketdata.js — 统一行情数据层（Node 端 · 提供者注册表）
 * ============================================================================
 * 重构目标：把过去「硬编码 try/catch 顺序」的取价逻辑，改为可配置的
 *           提供者注册表 + 健康度跟踪 + 优先级自动降级，并输出完整溯源信息。
 *
 * 借鉴（组合）：
 *   - OpenBB ：Provider 注册表 + 优先级降级（默认优先级列表逐个校验后选用）。
 *   - Jesse  ：CandleExchange(ABC) 的 backup_exchange 备用源 + 统一错误归一化。
 *   - CCXT   ：统一符号表（统一 symbol ↔ 交易所 id 映射）与 Ticker 字段命名。
 *
 * 对外契约（保持向后兼容）：
 *   TRADE_COINS / DISPLAY_COINS / fetchPrices() / fetchTickers()
 * 新增：
 *   fetchPricesDetailed() -> { prices, source, ts, latencyMs, attempts:[...] }
 *   providerStatus()      -> 各提供者健康度快照（供自检与可观测）
 *
 * 铁律：任一源失败自动切换下一条；全部失败返回 null，上层据此「跳过推进 + 告警」，
 *       绝不回退到合成行情污染交易数据。
 */
const { execSync } = require("child_process");

// ---------------------------------------------------------------------------
// 统一符号表（对齐 CCXT：统一 symbol ↔ 各交易所原生 id）
// ---------------------------------------------------------------------------
const TRADE_COINS = [
  ["BTC", "BTCUSDT"], ["ETH", "ETHUSDT"], ["SOL", "SOLUSDT"], ["BNB", "BNBUSDT"],
  ["DOGE", "DOGEUSDT"], ["PEPE", "PEPEUSDT"], ["SHIB", "SHIBUSDT"], ["WIF", "WIFUSDT"],
  ["BONK", "BONKUSDT"], ["FLOKI", "FLOKIUSDT"], ["MEME", "MEMEUSDT"]
];

const DISPLAY_COINS = [
  "BTCUSDT", "ETHUSDT", "XRPUSDT", "BNBUSDT", "SOLUSDT", "ADAUSDT",
  "TRXUSDT", "AVAXUSDT", "LINKUSDT", "SUIUSDT",
  "DOGEUSDT", "SHIBUSDT", "PEPEUSDT", "WIFUSDT", "BONKUSDT", "FLOKIUSDT"
];

// ---------------------------------------------------------------------------
// 底层 HTTP（沙箱内 curl 自动走 egress 代理）
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// 提供者实现：每个提供者只负责「返回 归一化后的 {coin: price} 映射」
// ---------------------------------------------------------------------------
function binanceLike(baseUrl) {
  return function () {
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
  };
}

function gateSpot() {
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

function bybitSpot() {
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

function okxSpot() {
  const j = jsonFrom("https://www.okx.com/api/v5/market/tickers?instType=SPOT", 12);
  const list = j && j.data;
  if (!Array.isArray(list) || !list.length) throw new Error("okx tickers parse fail");
  const prices = {};
  for (const it of list) {
    const inst = String(it.instId || "");      // e.g. BTC-USDT
    const idx = inst.indexOf("-USDT");
    if (idx <= 0) continue;
    const coin = inst.slice(0, idx);
    const px = parseFloat(it.last);
    if (coin && px > 0) prices[coin] = px;
  }
  return prices;
}

// ---------------------------------------------------------------------------
// 提供者注册表（按 priority 升序即为降级顺序；可运行时调整/禁用）
// ---------------------------------------------------------------------------
const PROVIDERS = [
  { name: "binance-vision", priority: 1, enabled: true, fn: binanceLike("https://data-api.binance.vision") },
  { name: "binance-api", priority: 2, enabled: true, fn: binanceLike("https://api.binance.com") },
  { name: "gate.io", priority: 3, enabled: true, fn: gateSpot },
  { name: "bybit", priority: 4, enabled: true, fn: bybitSpot },
  // 欧易 OKX：默认关闭——当前沙箱 egress 代理拦截 okx.com（SSL unexpected eof）。
  // 在可直连/可代理 OKX 的环境用 DAOCHANG_OKX=1 启用即可，无需改代码。
  { name: "okx", priority: 5, enabled: process.env.DAOCHANG_OKX === "1", fn: okxSpot },
];

// 健康度跟踪（进程内；供自检与可观测）
const HEALTH = {};
for (const p of PROVIDERS) {
  HEALTH[p.name] = { ok: 0, fail: 0, lastOkAt: 0, lastErrAt: 0, lastErr: "", lastLatencyMs: null };
}

function validate(prices) {
  for (const [coin] of TRADE_COINS) {
    const px = prices && prices[coin];
    if (!px || px <= 0) return false;
  }
  return true;
}

function pickProviders() {
  return PROVIDERS.filter((p) => p.enabled).slice().sort((a, b) => a.priority - b.priority);
}

// ---------------------------------------------------------------------------
// 取价（详细版）：返回 { prices, source, ts, latencyMs, attempts }
// ---------------------------------------------------------------------------
function fetchPricesDetailed() {
  const attempts = [];
  const startedAt = Date.now();
  for (const p of pickProviders()) {
    const t0 = Date.now();
    try {
      const prices = p.fn();
      const ms = Date.now() - t0;
      if (validate(prices)) {
        const h = HEALTH[p.name];
        h.ok++; h.lastOkAt = Date.now(); h.fail = 0; h.lastLatencyMs = ms; h.lastErr = "";
        attempts.push({ source: p.name, ok: true, ms: ms });
        return { prices: prices, source: p.name, ts: Date.now(), latencyMs: Date.now() - startedAt, attempts: attempts };
      }
      const h = HEALTH[p.name];
      h.fail++; h.lastErrAt = Date.now(); h.lastErr = "关键币种缺失(partial)"; h.lastLatencyMs = ms;
      attempts.push({ source: p.name, ok: false, ms: ms, err: "关键币种缺失(partial)" });
    } catch (e) {
      const ms = Date.now() - t0;
      const h = HEALTH[p.name];
      h.fail++; h.lastErrAt = Date.now(); h.lastErr = String(e.message || e).slice(0, 160); h.lastLatencyMs = ms;
      attempts.push({ source: p.name, ok: false, ms: ms, err: h.lastErr });
    }
  }
  return null;
}

// 兼容旧签名：返回 { prices, source } 或 null
function fetchPrices() {
  const d = fetchPricesDetailed();
  return d ? { prices: d.prices, source: d.source } : null;
}

// ---------------------------------------------------------------------------
// 展示用 16 币 24h 快照（price + 涨跌幅），失败返回 null
// ---------------------------------------------------------------------------
function fetchTickers() {
  const q = DISPLAY_COINS.map((s) => '"' + s + '"').join(",");
  const sources = [
    function () {
      const arr = jsonFrom("https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent("[" + q + "]"), 15);
      return arr.map((it) => ({ sym: it.symbol.replace("USDT", ""), price: parseFloat(it.lastPrice) || 0, chg: parseFloat(it.priceChangePercent) || 0, ts: it.closeTime }));
    },
    function () {
      const arr = jsonFrom("https://api.binance.com/api/v3/ticker/24hr?symbols=" + encodeURIComponent("[" + q + "]"), 15);
      return arr.map((it) => ({ sym: it.symbol.replace("USDT", ""), price: parseFloat(it.lastPrice) || 0, chg: parseFloat(it.priceChangePercent) || 0, ts: it.closeTime }));
    },
    function () {
      const pairs = DISPLAY_COINS.map((s) => s.replace("USDT", "") + "_USDT").join(",");
      const arr = jsonFrom("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=" + encodeURIComponent(pairs), 15);
      return arr.map((it) => ({ sym: it.currency_pair.split("_")[0], price: parseFloat(it.last) || 0, chg: parseFloat(it.change_percentage) || 0, ts: Date.now() }));
    }
  ];
  for (const fn of sources) {
    try {
      const arr = fn();
      if (!Array.isArray(arr) || !arr.length) continue;
      const map = {};
      for (const it of arr) if (it.sym && it.price > 0) map[it.sym] = { price: it.price, chg: it.chg, ts: it.ts || Date.now() };
      if (map.BTC) return map;
    } catch (e) { /* next source */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 可观测：提供者健康度快照
// ---------------------------------------------------------------------------
function providerStatus() {
  return pickProviders().map((p) => Object.assign({ name: p.name, priority: p.priority }, HEALTH[p.name]));
}

// ---------------------------------------------------------------------------
// 历史小时 K 线（供「追平墙钟」回放缺失的 tick）
//   - Binance vision → Binance api → Gate.io candles 逐级降级
//   - 返回原始 Binance 风格数组：[[openTimeMs, open, high, low, close, ...], ...]
// ---------------------------------------------------------------------------
function binanceKlines(baseUrl, symbol, startMs, endMs) {
  const url = baseUrl + "/api/v3/klines?symbol=" + symbol +
    "&interval=1h&startTime=" + startMs + "&endTime=" + endMs + "&limit=1000";
  const arr = jsonFrom(url, 20);
  if (!Array.isArray(arr)) throw new Error("klines parse fail");
  return arr;
}
function gateKlines(symbol, startMs, endMs) {
  const pair = symbol.replace("USDT", "_USDT");
  const from = Math.floor(startMs / 1000), to = Math.floor(endMs / 1000);
  const arr = jsonFrom("https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=" +
    pair + "&interval=1h&from=" + from + "&to=" + to, 20);
  if (!Array.isArray(arr)) throw new Error("gate candles parse fail");
  // Gate: [tsSec, quoteVol, close, high, low, open, baseVol, windowClosed] → 归一化为 Binance 风格
  return arr.map((r) => [parseInt(r[0], 10) * 1000, r[5], r[3], r[4], r[2]]);
}
function fetchKlines(symbol, startMs, endMs) {
  const tries = [
    () => binanceKlines("https://data-api.binance.vision", symbol, startMs, endMs),
    () => binanceKlines("https://api.binance.com", symbol, startMs, endMs),
    () => gateKlines(symbol, startMs, endMs),
  ];
  for (const fn of tries) { try { const a = fn(); if (a && a.length) return a; } catch (e) { /* next */ } }
  return [];
}

// 小时序列：返回 [{ ts, prices:{coin:px} }]，自 fromMs 起逐小时（含首尾），失败返回 null。
//   fallbackPrices：某币种完全无 K 线时用实时价做常量兜底（仍缺失则该币进 missing → 返回 null）。
function fetchHourlySeries(fromMs, toMs, fallbackPrices) {
  const H = 3600 * 1000;
  const startH = Math.floor(fromMs / H) * H;
  const endH = Math.floor(toMs / H) * H;
  const n = Math.round((endH - startH) / H) + 1;
  if (n <= 0) return [];
  if (n > 1000) return null;      // 超出单次拉取上限 → 交由上层降级为「仅推进当前 tick」

  const perCoin = {};
  const missing = [];
  for (const pair of TRADE_COINS) {
    const coin = pair[0], sym = pair[1];
    const rows = fetchKlines(sym, startH, endH + H);
    const m = {};
    for (const r of rows) {
      const ot = Number(r[0]);
      const close = parseFloat(r[4]);
      if (isFinite(ot) && close > 0) m[ot] = close;
    }
    if (!Object.keys(m).length) {
      if (fallbackPrices && fallbackPrices[coin] > 0) {
        const px = fallbackPrices[coin];
        for (let i = 0; i < n; i++) m[startH + i * H] = px;   // 常量兜底
      } else {
        missing.push(coin); continue;
      }
    }
    perCoin[coin] = m;
  }
  if (missing.length) return null;

  const series = [];
  const last = {};
  for (let i = 0; i < n; i++) {
    const ot = startH + i * H;
    const prices = {};
    for (const pair of TRADE_COINS) {
      const coin = pair[0];
      let px = perCoin[coin][ot];
      if (!px) px = last[coin];                                  // 前向填充
      if (!px) px = perCoin[coin][Object.keys(perCoin[coin])[0]]; // 兜底取最近一根
      prices[coin] = px;
      last[coin] = px;
    }
    series.push({ ts: ot, prices: prices });
  }
  return series;
}

module.exports = { TRADE_COINS, DISPLAY_COINS, fetchPrices, fetchPricesDetailed, fetchTickers, providerStatus, PROVIDERS, fetchKlines, fetchHourlySeries };