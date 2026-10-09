/*
 * 实盘道场 / 期权演武场 —— 状态化推进脚本（严格锚定真实行情版）
 * 用法: node snapshot.js [ticks]
 *   - 首次运行：按 SEED 初始化 6 位 AI 主理人（各 1000U），11 币基价锚定真实行情
 *   - 之后每次运行：从 data/state.json 恢复，推进 1 小时（1 tick）
 *   - 每个 tick 从多源交易所拉取真实价格驱动模拟盘（Binance → Gate → Bybit）
 *   - 拉价失败（全部源不可达/关键币缺失）→ 本 tick 不推进、写错误状态并退出非 0，
 *     杜绝回退合成行情污染交易数据（T0 事故修复）
 *   - 产出: data/state.json / data/latest.json / data/latest_summary.json / stdout
 */
const fs = require("fs");
const path = require("path");

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

const TICKS = parseInt(process.argv[2] || "1", 10);

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// 价格精度格式化（对齐 engine.roundPx，防止 meme 币被抹成 0）
const roundPx = ENGINE.roundPx || function (p) {
  if (p == null || !isFinite(p)) return p;
  const a = Math.abs(p);
  const dec = a >= 1000 ? 2 : (a >= 1 ? 2 : (a >= 0.01 ? 4 : (a >= 0.0001 ? 6 : 8)));
  return Number(p.toFixed(dec));
};
function round(x) { return Math.round(x * 100) / 100; }
function pct(x) { return (x * 100).toFixed(1) + "%"; }

// ---------- 状态管理 ----------
function loadOrInit() {
  if (fs.existsSync(STATE_FILE)) {
    let st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (!st.managers) st.managers = {};
    if (!st.market) { st = ENGINE.initState(st.seed || SEED, st.startEquity || START_EQUITY); }
    return st;
  }
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

function main() {
  ensureDir();

  // 1. 稳健多源拉取真实价格；失败则跳过推进并告警退出（绝不回退合成行情）
  const fetched = MARKET.fetchPricesDetailed();
  if (!fetched) {
    const err = writeError("真实行情获取失败（Binance/Gate/Bybit 全部不可达或关键币缺失），本 tick 跳过推进");
    console.error("[snapshot] ❌ " + err.message);
    console.error(JSON.stringify(err));
    process.exit(1);
  }
  const realPrices = fetched.prices;
  const sourceName = fetched.source;

  const mainCoins = ["BTC", "ETH", "SOL", "BNB", "DOGE"];
  const memeCoins = ["PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"];
  let logMsg = "[snapshot] 锚定真实行情(" + sourceName + "): ";
  mainCoins.forEach((c) => { logMsg += c + "=" + realPrices[c] + " "; });
  logMsg += "| Meme: ";
  memeCoins.forEach((c) => { logMsg += c + "=" + realPrices[c] + " "; });
  console.log(logMsg.trim());

  // 2. 旧状态若严重偏离真实价（历史合成污染），备份并重置为干净基线
  if (fs.existsSync(STATE_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const oldBTC = old.market && old.market.BTC && old.market.BTC.price;
      if (oldBTC && Math.abs(oldBTC - realPrices.BTC) / realPrices.BTC > 0.05) {
        const backup = STATE_FILE + ".bak." + Date.now();
        fs.renameSync(STATE_FILE, backup);
        console.log("[snapshot] 旧状态 BTC=" + round(oldBTC) + " 与真实价偏差>5%，已备份并重置");
      }
    } catch (e) { /* 忽略检测错误 */ }
  }

  // 3. 恢复/初始化状态，补齐历史决策价格，再推进
  let st = loadOrInit();
  backfillDecisionPrices(st);
  const startTick = st.tick;
  st = ENGINE.advance(st, TICKS, realPrices);

  // 4. 持久化
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));

  const summary = summarize(st);
  const mkt = marketDelta(st, TICKS);
  const day = (st.tick / TICK_PER_DAY).toFixed(1);

  const payload = {
    generated_at: new Date().toISOString(),
    timezone: "Asia/Shanghai",
    seed: st.seed || SEED,
    startEquity: START_EQUITY,
    tick: st.tick,
    day: parseFloat(day),
    realPriceMode: true,
    priceSource: sourceName,
    priceLatencyMs: fetched.latencyMs,
    priceAttempts: fetched.attempts,
    providers: MARKET.providerStatus(),
    realPrices: realPrices,
    managers: summary,
    market: mkt,
    startTick: startTick,
    advancedTicks: TICKS
  };
  fs.writeFileSync(LATEST_FILE, JSON.stringify(st));
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(payload, null, 2));
  // 清除历史错误标记（本次成功）
  if (fs.existsSync(ERROR_FILE)) try { fs.unlinkSync(ERROR_FILE); } catch (e) {}

  // 5. 展示用实时行情快照（统一 Ticker 模型，供浏览器 datafeed 兜底读取）
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

  // ---------- 推送报告（stdout） ----------
  const lines = [];
  lines.push("===== AI 主理 · 实盘道场 / 期权演武场（严格锚定真实行情） =====");
  lines.push("推进 " + TICKS + " 小时 → 累计 " + day + " 天（tick " + st.tick + "）· " + new Date().toLocaleString("zh-CN", { hour12: false }));
  lines.push("行情源: " + sourceName + " 实时 | " +
    mainCoins.map((c) => c + "=" + realPrices[c]).join(" ") +
    " | Meme: " + memeCoins.map((c) => c + "=" + realPrices[c]).join(" "));
  lines.push("");
  lines.push("— 市场（近" + TICKS + "小时）—");
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