/*
 * 实盘道场 / 期权演武场 —— 状态化推进脚本（锚定真实行情版）
 * 用法: node snapshot.js [ticks]
 *   - 首次运行：按 SEED 初始化 6 位 AI 主理人（各 1000U），BTC/ETH/SOL 基价锚定真实行情
 *   - 之后每次运行：从 data/state.json 恢复，推进 1 小时（1 tick）
 *   - BTC/ETH/SOL 每小时从 Binance 拉取真实价格驱动模拟盘
 *   - Meme 币保留合成行情（无真实行情源）
 *   - 产出: data/state.json / data/latest.json / data/latest_summary.json / stdout
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

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

const TICKS = parseInt(process.argv[2] || "1", 10);

function ensureDir() { fs.mkdirSync(DATA_DIR, { recursive: true }); }

// ---------- 锚定真实行情 ----------
function fetchRealPrices() {
  try {
    const symbols = [
      ["BTC", "BTCUSDT"], ["ETH", "ETHUSDT"], ["SOL", "SOLUSDT"], 
      ["BNB", "BNBUSDT"], ["DOGE", "DOGEUSDT"], ["PEPE", "PEPEUSDT"],
      ["SHIB", "SHIBUSDT"], ["WIF", "WIFUSDT"], ["BONK", "BONKUSDT"],
      ["FLOKI", "FLOKIUSDT"], ["MEME", "MEMEUSDT"]
    ];
    const prices = {};
    for (const [coin, sym] of symbols) {
      const out = execSync(
        `curl -sS -m 10 "https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}"`,
        { encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"] }
      ).trim();
      prices[coin] = parseFloat(JSON.parse(out).price);
    }
    if (!prices.BTC || !prices.ETH || !prices.SOL) throw new Error("价格解析失败");
    return prices;
  } catch (e) {
    console.error("[snapshot] 获取真实价格失败，回退合成行情: " + e.message);
    return null;
  }
}

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
  const out = {};
  const ph = st.priceHistory;
  if (!ph || ph.length < 2) return out;
  const cur = ph[ph.length - 1];
  const start = Math.max(0, ph.length - 1 - lookbackTicks);
  const prev = ph[start] || ph[0];
  for (const s of ["BTC", "ETH", "SOL", "BNB", "DOGE", "PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"]) {
    const c = cur[s], p = prev[s];
    if (c && p) out[s] = { price: round(c), chgPct: round((c / p - 1) * 100) };
  }
  return out;
}

function main() {
  ensureDir();

  // 锚定真实行情
  const realPrices = fetchRealPrices();
  if (realPrices) {
    const mainCoins = ["BTC", "ETH", "SOL", "BNB", "DOGE"];
    const memeCoins = ["PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"];
    let logMsg = "[snapshot] 锚定真实行情: ";
    mainCoins.forEach(c => { if (realPrices[c]) logMsg += c + "=" + realPrices[c] + " "; });
    logMsg += "| Meme: ";
    memeCoins.forEach(c => { if (realPrices[c]) logMsg += c + "=" + realPrices[c] + " "; });
    console.log(logMsg.trim());
  } else {
    console.log("[snapshot] ⚠ 真实行情获取失败，本 tick 使用合成行情");
  }

  // 如果旧状态是合成行情（BTC 远偏离真实价），重置为真实行情基价
  if (fs.existsSync(STATE_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      const oldBTC = old.market && old.market.BTC && old.market.BTC.price;
      if (oldBTC && realPrices && Math.abs(oldBTC - realPrices.BTC) / realPrices.BTC > 0.15) {
        const backup = STATE_FILE + ".bak." + Date.now();
        fs.renameSync(STATE_FILE, backup);
        console.log("[snapshot] 旧状态 BTC=" + round(oldBTC) + " 与真实价偏差>15%，已备份并重置");
      }
    } catch (e) { /* 忽略检测错误 */ }
  }

  let st = loadOrInit();
  const startTick = st.tick;
  st = ENGINE.advance(st, TICKS, realPrices);

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
    realPriceMode: !!realPrices,
    realPrices: realPrices,
    managers: summary,
    market: mkt,
    startTick: startTick,
    advancedTicks: TICKS
  };
  fs.writeFileSync(LATEST_FILE, JSON.stringify(st));
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(payload, null, 2));

  // ---------- 推送报告（stdout） ----------
  const lines = [];
  lines.push("===== AI 主理 · 实盘道场 / 期权演武场（锚定真实行情） =====");
  lines.push("推进 " + TICKS + " 小时 → 累计 " + day + " 天（tick " + st.tick + "）· " + new Date().toLocaleString("zh-CN", { hour12: false }));
  if (realPrices) {
    const mainCoins = ["BTC", "ETH", "SOL", "BNB", "DOGE"];
    let priceLine = "行情源: Binance 实时 | ";
    mainCoins.forEach(c => { if (realPrices[c]) priceLine += c + "=" + realPrices[c] + " "; });
    priceLine += "| Meme币: ";
    ["PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"].forEach(c => { if (realPrices[c]) priceLine += c + "=" + realPrices[c] + " "; });
    lines.push(priceLine.trim());
  } else {
    lines.push("行情源: 合成（Binance 不可达，回退）");
  }
  lines.push("");
  lines.push("— 市场（近" + TICKS + "小时）—");
  lines.push("— 主流币（近" + TICKS + "小时）—");
  for (const s of ["BTC", "ETH", "SOL", "BNB", "DOGE"]) {
    if (mkt[s]) lines.push("  " + s + " : " + mkt[s].price + " (" + (mkt[s].chgPct >= 0 ? "+" : "") + mkt[s].chgPct + "%)");
  }
  lines.push("— Meme币（近" + TICKS + "小时）—");
  for (const s of ["PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"]) {
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
