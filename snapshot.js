/*
 * 实盘道场 / 期权演武场 —— 状态化推进脚本（严格锚定真实行情版 · 墙钟自追平）
 * 用法: node snapshot.js [ticks]
 *   - 首次运行：按 SEED 初始化 6 位 AI 主理人（各 1000U），11 币基价锚定真实行情
 *   - 之后每次运行：先读线上 state.json（GitHub）与本地 state.json，取 lastUpdate 较新者，防止覆盖；
 *     再按「墙钟差额」自动追平——正常 1 小时推进 1 tick；漏跑 N 小时则用交易所历史小时K线
 *     补推 N tick（前 N-1 tick 用历史 K 线收盘价，最后 1 tick 用实时期价）；
 *     同一小时内重复运行幂等、不重复推进。
 *   - 拉价失败（全部源不可达/关键币缺失）→ 本 tick 不推进、写错误状态并退出非 0，
 *     杜绝回退合成行情污染交易数据（T0 事故修复）
 *   - 显式传入 [ticks] 时按手动推进（跳过墙钟追平，全部 tick 用实时期价）
 *   - 产出: data/state.json / data/latest.json / data/latest_summary.json / stdout
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DIR = __dirname;
const PROFILES = require(path.join(DIR, "profiles.js"));
const ENGINE = require(path.join(DIR, "engine.js"));
const MARKET = require(path.join(DIR, "marketdata.js"));
ENGINE.attachProfiles(PROFILES);

const SEED = PROFILES.SEED || 20260913;
const START_EQUITY = PROFILES.START_EQUITY || 1000;
const TICK_PER_DAY = ENGINE.TICK_PER_DAY || 24;
const DATA_DIR = path.join(DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const SUMMARY_FILE = path.join(DATA_DIR, "latest_summary.json");
const LIVE_PRICES_FILE = path.join(DATA_DIR, "live_prices.json");
const ERROR_FILE = path.join(DATA_DIR, "last_error.json");

const ONLINE_STATE_URL = "https://api.github.com/repos/daochang123/daochang/contents/data/state.json?ref=main";

// ---------- 价格格式化（对齐 engine.roundPx，防止 meme 币被抹成 0） ----------
const roundPx = ENGINE.roundPx || function (p) {
  if (p == null || !isFinite(p)) return p;
  const a = Math.abs(p);
  const dec = a >= 1000 ? 2 : (a >= 1 ? 2 : (a >= 0.01 ? 4 : (a >= 0.0001 ? 6 : 8)));
  return Number(p.toFixed(dec));
};
function round(x) { return Math.round(x * 100) / 100; }
function pct(x) { return (x * 100).toFixed(1) + "%"; }

// ---------- 状态管理 ----------
function loadLocalState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    let st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!st.managers) st.managers = {};
    if (!st.market) st = null;
    return st;
  } catch (e) {
    return null;
  }
}

// 读线上 state.json（公开仓库 Contents API，无需凭据；失败静默返回 null）
function loadOnlineState() {
  try {
    const out = execSync(`curl -sS -m 20 "${ONLINE_STATE_URL}"`, {
      encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"]
    });
    const j = JSON.parse(out);
    if (j && j.content) {
      const st = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
      if (st && st.managers && st.market) return st;
    }
  } catch (e) { /* 线上不可达：静默用本地 */ }
  return null;
}

// 取 lastUpdate 较新者，防止旧状态覆盖新状态
function pickNewer(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a.lastUpdate || "") || 0;
  const tb = Date.parse(b.lastUpdate || "") || 0;
  if (tb > ta) {
    console.log("[snapshot] 线上 state.json 较新（" + b.lastUpdate + "），采用线上基线");
    return b;
  }
  return a;
}

function initState() {
  let st = ENGINE.initState(SEED, START_EQUITY);
  for (let i = 0; i < PROFILES.KOLS.length; i++) {
    const p = PROFILES.KOLS[i];
    st.managers[p.id] = ENGINE.initManager(p.id, START_EQUITY);
  }
  return st;
}

// ---------- 决策价格回填：补齐历史决策缺失的 price 字段（用 priceHistory 逐 tick 对齐） ----------
function backfillDecisionPrices(st) {
  const ph = st.priceHistory || [];
  const byTick = {};
  for (let i = 0; i < ph.length; i++) byTick[ph[i].t] = ph[i];
  let filled = 0;
  for (const id in st.managers) {
    const mgr = st.managers[id];
    const decisions = mgr.decisions || [];
    for (let j = 0; j < decisions.length; j++) {
      const d = decisions[j];
      if (d.price != null) continue;
      const row = byTick[d.tick];
      if (row && d.coin && row[d.coin] != null) { d.price = row[d.coin]; filled++; }
    }
  }
  if (filled > 0) console.log("[snapshot] 决策价格回填 " + filled + " 条历史记录");
  return st;
}

function summarize(st) {
  return ENGINE.summary(st).map(function (r) {
    const m = st.managers[r.id];
    let ironBlocks = 0;
    for (let i = 0; i < m.decisions.length; i++) if (m.decisions[i].type === "iron_block") ironBlocks++;
    return {
      id: r.id, name: r.name, arena: r.arena,
      equity: r.equity, cash: r.cash, pnl: r.pnl, pnlPct: r.pnlPct,
      realized: r.realized, trades: r.trades, winRate: r.winRate,
      maxDrawdown: r.maxDrawdown, open: r.open,
      decisions: m.decisions.length, evolution: m.evolution.length, ironBlocks: ironBlocks
    };
  });
}

function marketDelta(st, lookbackTicks) {
  const out = {};
  const ph = st.priceHistory;
  if (!ph || ph.length < 2) return out;
  const cur = ph[ph.length - 1];
  const start = Math.max(0, ph.length - 1 - lookbackTicks);
  const prev = ph[start] || ph[0];
  for (const s of ["BTC", "ETH", "SOL", "BNB", "DOGE", "PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"]) {
    const c = cur[s], p = prev[s];
    if (c !== undefined && c !== null && p) out[s] = { price: roundPx(c), chgPct: round((c / p - 1) * 100) };
  }
  return out;
}

function writeError(msg) {
  const err = { time: new Date().toISOString(), message: msg, action: "skip advance (no synthetic fallback)" };
  try { fs.writeFileSync(ERROR_FILE, JSON.stringify(err, null, 2)); } catch (e) {}
  return err;
}

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ---------- 实时行情快照（展示用，幂等时亦刷新） ----------
function writeLivePrices(sourceName) {
  const tickerPx = MARKET.fetchTickers();
  const snapTs = Date.now();
  const snapPrices = {};
  if (tickerPx) {
    for (const sym in tickerPx) {
      snapPrices[sym] = {
        last: tickerPx[sym].price,
        percentage: tickerPx[sym].chg,
        timestamp: tickerPx[sym].ts || snapTs,
        source: sourceName
      };
    }
  }
  fs.writeFileSync(LIVE_PRICES_FILE, JSON.stringify({
    generated_at: new Date(snapTs).toISOString(),
    ts: snapTs,
    source: tickerPx ? sourceName : "unavailable",
    timezone: "Asia/Shanghai",
    prices: snapPrices
  }));
}

function main() {
  ensureDir();

  // ---------- 1. 基线：线上/本地 state.json 取 lastUpdate 较新者 ----------
  const localSt = loadLocalState();
  const onlineSt = loadOnlineState();
  let st = pickNewer(localSt, onlineSt);
  if (!st) st = initState();

  // ---------- 2. 墙钟差额：计算待补推小时数 ----------
  const nowMs = Date.now();
  const hourOf = (t) => Math.floor(t / 3600000);
  const lastMs = Date.parse(st.lastUpdate || "");
  let N;
  if (process.argv[2]) {
    N = parseInt(process.argv[2], 10) || 1;
    console.log("[snapshot] 手动指定推进 " + N + " tick（跳过墙钟追平）");
  } else if (!lastMs || isNaN(lastMs)) {
    N = 1; // 首次运行（无 lastUpdate）：推进 1 tick
  } else {
    // lastUpdate 所在小时 = 上次已覆盖的「下一小时边界」；N = 已完成的、尚未推进的小时数
    N = hourOf(nowMs) - hourOf(lastMs);
    if (N <= 0) {
      console.log("[snapshot] 幂等：自 " + st.lastUpdate + " 以来未跨新小时，本轮不推进（累计 " + (st.tick / TICK_PER_DAY).toFixed(1) + " 天，tick " + st.tick + "）");
      writeLivePrices(onlineSt ? "online-baseline" : "local-baseline");
      return;
    }
  }

  // ---------- 3. 拉取真实行情（补推用历史 K 线 + 实时期价） ----------
  let klinesRes = null;
  if (N > 1 && !process.argv[2]) {
    const baseHourMs = hourOf(lastMs) * 3600000;
    klinesRes = MARKET.fetchHistoryKlines(baseHourMs, N - 1);
    if (!klinesRes) {
      const err = writeError("历史小时K线获取失败（binance-vision/binance-api/gate.io 全部不可达），补推 " + (N - 1) + " 小时无法完成，本 tick 跳过推进");
      console.error("[snapshot] ❌ " + err.message);
      console.error(JSON.stringify(err));
      process.exit(1);
    }
    console.log("[snapshot] 追平墙钟：lastUpdate=" + st.lastUpdate + " → 补推 " + N + " 小时（前 " + (N - 1) + " tick 用 " + klinesRes.source + " 历史K线，耗时 " + klinesRes.ms + "ms）");
  }

  const fetched = MARKET.fetchPricesDetailed();
  if (!fetched) {
    // N>1 且已有 K 线兜底：最后 1 tick 用末根 K 线收盘价（真实行情），不视为失败
    if (!klinesRes) {
      const err = writeError("真实行情获取失败（Binance/Gate/Bybit 全部不可达或关键币缺失），本 tick 跳过推进");
      console.error("[snapshot] ❌ " + err.message);
      console.error(JSON.stringify(err));
      process.exit(1);
    }
  }

  const mainCoins = ["BTC", "ETH", "SOL", "BNB", "DOGE"];
  const memeCoins = ["PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"];

  function livePriceLine() {
    if (!fetched) return "实时期价不可用(降级末根K线)";
    let s = fetched.prices;
    let logMsg = mainCoins.map((c) => c + "=" + s[c]).join(" ") + " | Meme: ";
    logMsg += memeCoins.map((c) => c + "=" + s[c]).join(" ");
    return logMsg;
  }

  console.log("[snapshot] 锚定真实行情(" + (fetched ? fetched.source : "kline-fallback") + "): " + livePriceLine());

  // 4. 旧状态若严重偏离真实价（历史合成污染），备份并重置为干净基线
  if (fs.existsSync(STATE_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const oldBTC = old.market && old.market.BTC && old.market.BTC.price;
      const refBTC = fetched ? fetched.prices.BTC : null;
      if (refBTC && oldBTC && Math.abs(oldBTC - refBTC) / refBTC > 0.05) {
        const backup = STATE_FILE + ".bak." + Date.now();
        fs.renameSync(STATE_FILE, backup);
        console.log("[snapshot] 旧状态 BTC=" + round(oldBTC) + " 与真实价偏差>5%，已备份并重置");
      }
    } catch (e) { /* 忽略检测错误 */ }
  }

  backfillDecisionPrices(st);
  const startTick = st.tick;
  const lastUpdateBefore = st.lastUpdate; // 在推进前捕获，供报告与摘要使用

  // ---------- 5. 逐 tick 推进：前 N-1 tick 用历史 K 线收盘价，最后 1 tick 用实时期价 ----------
  const tickPrices = [];
  for (let i = 0; i < N; i++) {
    if (i < N - 1 && klinesRes) {
      const p = {};
      for (const coin of mainCoins.concat(memeCoins)) {
        p[coin] = klinesRes.closes[coin][i];
      }
      tickPrices.push(p);
    } else if (fetched) {
      tickPrices.push(fetched.prices);
    } else {
      // 实时期价不可用且无 K 线兜位（N==1 手动场景已在上面拦截）：用末根 K 线
      const p = {};
      for (const coin of mainCoins.concat(memeCoins)) {
        p[coin] = klinesRes.closes[coin][klinesRes.closes[coin].length - 1];
      }
      tickPrices.push(p);
    }
  }
  for (let i = 0; i < N; i++) {
    st = ENGINE.advance(st, 1, tickPrices[i]);
  }

  // 6. 持久化
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
  const prevSummary = (() => {
    try { return JSON.parse(fs.readFileSync(SUMMARY_FILE, "utf8")); } catch (e) { return null; }
  })();

  const summary = summarize(st);
  const mkt = marketDelta(st, N);
  const day = (st.tick / TICK_PER_DAY).toFixed(1);

  const payload = {
    generated_at: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    seed: st.seed || SEED,
    startEquity: START_EQUITY,
    tick: st.tick,
    day: parseFloat(day),
    realPriceMode: true,
    priceSource: fetched ? fetched.source : "kline-fallback",
    priceLatencyMs: fetched ? fetched.latencyMs : null,
    priceAttempts: fetched ? fetched.attempts : [],
    providers: MARKET.providerStatus(),
    realPrices: fetched ? fetched.prices : tickPrices[tickPrices.length - 1],
    managers: summary,
    market: mkt,
    startTick: startTick,
    advancedTicks: N,
    catchup: {
      mode: process.argv[2] ? "manual" : (N > 1 ? "kline-catchup" : "normal"),
      lastUpdateBefore: lastUpdateBefore || (prevSummary && prevSummary.generated_at ? prevSummary.generated_at : null),
      now: new Date(nowMs).toISOString(),
      baseHourMs: N > 1 && klinesRes ? hourOf(lastMs) * 3600000 : null,
      klineSource: klinesRes ? klinesRes.source : null,
      klineMs: klinesRes ? klinesRes.ms : null,
      baseline: onlineSt && (!localSt || Date.parse(onlineSt.lastUpdate || "") > Date.parse(localSt.lastUpdate || "")) ? "online" : "local",
      idempotentSkip: false
    },
    prev: prevSummary ? { tick: prevSummary.tick, managers: prevSummary.managers, market: prevSummary.market } : null
  };
  fs.writeFileSync(LATEST_FILE, JSON.stringify(st));
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(payload, null, 2));
  // 清除历史错误标记（本次成功）
  if (fs.existsSync(ERROR_FILE)) try { fs.unlinkSync(ERROR_FILE); } catch (e) {}

  // 7. 展示用实时行情快照
  writeLivePrices(fetched ? fetched.source : "kline-fallback");

  // ---------- 8. 推送报告（stdout） ----------
  const lines = [];
  lines.push("===== AI 主理 · 实盘道场 / 期权演武场（严格锚定真实行情） =====");
  lines.push("推进 " + N + " 小时 → 累计 " + day + " 天（tick " + st.tick + "）· " + new Date().toLocaleString("zh-CN", { hour12: false }));
  if (N > 1) lines.push("⚡ 墙钟追平：lastUpdate=" + lastUpdateBefore + " 补推 " + N + " 小时（前 " + (N - 1) + " tick 用 " + (klinesRes ? klinesRes.source : "kline") + " 历史K线）");
  lines.push("行情源: " + (fetched ? fetched.source : "kline-fallback") + " | " + livePriceLine());
  lines.push("");
  lines.push("— 市场（近" + N + "小时）—");
  for (const s of mainCoins.concat(memeCoins)) {
    if (mkt[s]) lines.push("  " + s + " : " + mkt[s].price + " (" + (mkt[s].chgPct >= 0 ? "+" : "") + mkt[s].chgPct + "%)");
  }
  lines.push("");
  lines.push("— 主理人（起始 1000U）—");
  for (const m of summary) {
    lines.push("  " + m.name + " [" + m.arena + "] 权益=" + round(m.equity) + "U (" + (m.pnlPct >= 0 ? "+" : "") + pct(m.pnlPct) + ") 胜率=" + pct(m.winRate) + " 回撤=-" + pct(m.maxDrawdown) + " 持仓=" + m.open + " 决策=" + m.decisions + " 进化=" + m.evolution + " 铁律拦截=" + m.ironBlocks);
  }
  lines.push("");
  lines.push("已写 data/latest.json（看板实时快照）与 data/latest_summary.json（摘要）。");
  console.log(lines.join("\n"));

  return payload;
}

main();
