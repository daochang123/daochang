/*
 * 实盘道场 / 期权演武场 —— 状态化推进脚本
 * 用法: node snapshot.js [ticks]
 *   - 首次运行：按 SEED 初始化 5 位 AI 主理人（各 1000U）
 *   - 之后每次运行：从 data/state.json 恢复，推进 1 小时（1 tick，可传参覆盖）
 *     旧版为 12 小时；现改每小时推送，默认 1 tick，传参 `node snapshot.js 12` 可一次推 12 小时
 *   - 产出:  data/state.json（可复现状态）、data/latest.json（看板实时快照）、
 *           data/latest_summary.json（推送摘要）、stdout（推送报告）
 * 说明: 引擎已将 PRNG 状态持久化，断点续推不会重播随机序列。
 */
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const PROFILES = require(path.join(DIR, "profiles.js"));
const ENGINE = require(path.join(DIR, "engine.js"));
ENGINE.attachProfiles(PROFILES);

const SEED = PROFILES.SEED || 20260913;
const START_EQUITY = PROFILES.START_EQUITY || 1000;
const TICK_PER_DAY = ENGINE.TICK_PER_DAY || 24;
const DATA_DIR = path.join(DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const LATEST_FILE = path.join(DATA_DIR, "latest.json");
const SUMMARY_FILE = path.join(DATA_DIR, "latest_summary.json");

const TICKS = parseInt(process.argv[2] || "1", 10); // 默认 1 tick = 1 小时（小时推送）

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

function loadOrInit() {
  if (fs.existsSync(STATE_FILE)) {
    let st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    // 兼容性补齐
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

function round(x) { return Math.round(x * 100) / 100; }
function pct(x) { return (x * 100).toFixed(1) + "%"; }

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
  // 近 lookbackTicks 内 BTC/ETH/SOL 价格变化
  const out = {};
  const ph = st.priceHistory;
  if (!ph || ph.length < 2) return out;
  const cur = ph[ph.length - 1];
  const start = Math.max(0, ph.length - 1 - lookbackTicks);
  const prev = ph[start] || ph[0];
  for (const s of ["BTC", "ETH", "SOL"]) {
    const c = cur[s], p = prev[s];
    out[s] = { price: round(c), chgPct: round((c / p - 1) * 100) };
  }
  return out;
}

function main() {
  ensureDir();
  const prevStateExists = fs.existsSync(STATE_FILE);
  const prevPrices = prevStateExists ? (function () {
    const ps = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const ph = ps.priceHistory || [];
    if (!ph.length) return null;
    const last = ph[ph.length - 1];
    return { BTC: last.BTC, ETH: last.ETH, SOL: last.SOL };
  })() : null;

  let st = loadOrInit();
  const startTick = st.tick;
  st = ENGINE.advance(st, TICKS);

  // 持久化
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
    managers: summary,
    market: mkt,
    startTick: startTick,
    advancedTicks: TICKS
  };
  fs.writeFileSync(LATEST_FILE, JSON.stringify(st));            // 完整状态 → 看板实时渲染
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(payload, null, 2));

  // ---------- 推送报告（stdout） ----------
  const lines = [];
  lines.push("===== AI 主理 · 实盘道场 / 期权演武场 =====");
  lines.push("推进 " + TICKS + " 小时 → 累计 " + day + " 天（tick " + st.tick + "）· 数据时间 " + new Date().toLocaleString("zh-CN", { hour12: false }));
  lines.push("");
  lines.push("— 市场（近" + TICKS + "小时）—");
  for (const s of ["BTC", "ETH", "SOL"]) {
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