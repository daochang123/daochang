/*
 * 实盘道场 / 期权演武场 —— 状态化推进脚本（严格锚定真实行情版）
 * 用法: node snapshot.js
 *   - 首次运行：按 SEED 初始化 6 位 AI 主理人（各 1000U），11 币基价锚定真实行情
 *   - 之后每次运行：从 data/state.json 恢复，按「墙钟差额」推进到当前小时
 *     · 正常运行 1 小时 → 推进 1 tick；断线/漏跑 N 小时 → 用交易所历史小时K线补推 N tick
 *     · 同一小时内重复运行 → 幂等，不重复推进（杜绝双推）
 *   - 防覆盖：推进前先读线上 state.json，取较新者为准，避免陈旧本地覆盖线上已推进历史
 *   - 每个 tick 从多源交易所拉取真实价格驱动模拟盘（Binance → Gate → Bybit → OKX 可选）
 *   - 拉价失败（全部源不可达/关键币缺失）→ 本 tick 不推进、写错误状态并退出非 0，
 *     杜绝回退合成行情污染交易数据（T0 事故修复）
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

// ---------- 防覆盖：读取线上 state.json（较新者优先），失败返回 null（不阻断本地推进） ----------
const GH_OWNER = "daochang123", GH_REPO = "daochang", GH_BRANCH = "main";
function fetchRemoteState() {
  try {
    const patFile = path.join(DATA_DIR, "github_pat.txt");
    if (!fs.existsSync(patFile)) return null;
    const token = fs.readFileSync(patFile, "utf8").trim().split(/\r?\n/).find((l) => l.trim());
    if (!token) return null;
    const out = execSync(
      'curl -sS -m 25 -H "Authorization: token ' + token + '" -H "Accept: application/vnd.github+json" ' +
      '-H "User-Agent: daochang-snapshot" ' +
      '"https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/data/state.json?ref=' + GH_BRANCH + '"',
      { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    );
    const j = JSON.parse(out);
    if (j && j.content) return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    return null;
  } catch (e) {
    console.log("[snapshot] （线上状态读取失败，忽略：" + String(e.message || e).slice(0, 80) + "）");
    return null;
  }
}

function main() {
  ensureDir();

  // 1. 稳健多源拉取真实价格；失败则跳过推进并告警退出（绝不回退合成行情）
  const fetched = MARKET.fetchPricesDetailed();
  if (!fetched) {
    const err = writeError("真实行情获取失败（Binance/Gate/Bybit 全部不可达或关键币缺失），本小时跳过推进");
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

  // 3. 恢复本地状态；再读线上状态，取较新者，防止陈旧本地覆盖线上已推进的历史
  let st = loadOrInit();
  const remote = fetchRemoteState();
  if (remote && (remote.tick || 0) > (st.tick || 0)) {
    console.log("[snapshot] 线上状态更新(tick=" + remote.tick + " > 本地 " + (st.tick || 0) + ")，采用线上防覆盖");
    st = remote;
    if (!st.managers) st.managers = {};
  }
  backfillDecisionPrices(st);

  // 4. 墙钟追平：按「距时间轴基准已过小时数」补推缺失 tick（断线自动补课，杜绝丢帧）
  const H = 3600 * 1000;
  const baseMs = st.timelineBase || Date.parse(st.startedAt) || Date.now();
  st.timelineBase = baseMs;
  const startTick = st.tick;
  const targetTick = Math.floor((Date.now() - baseMs) / H);
  let need = targetTick - st.tick;
  if (need > 1000) {
    console.log("[snapshot] ⚠ 缺失 " + need + " 小时，超过单次回填上限，本轮先补 1000 小时");
    need = 1000;
  }
  let backfilled = 0;
  if (need > 0) {
    const series = MARKET.fetchHourlySeries(baseMs + st.tick * H, Date.now(), realPrices);
    if (series && series.length) {
      for (let i = 0; i < need; i++) {
        const px = (i === need - 1) ? realPrices : (series[i] ? series[i].prices : realPrices);
        st = ENGINE.advance(st, 1, px);
        backfilled++;
      }
      if (need > 1) console.log("[snapshot] 追平墙钟：补推 " + backfilled + " 小时（tick " + startTick + " → " + st.tick + "，目标 " + targetTick + "）");
    } else {
      console.log("[snapshot] ⚠ 历史K线不可用，本轮仅推进当前 1 小时（绝不伪造多 tick 平推）");
      st = ENGINE.advance(st, 1, realPrices);
      backfilled = 1;
    }
  } else {
    console.log("[snapshot] 已追平墙钟(tick=" + st.tick + " ≥ 目标 " + targetTick + ")，本小时不重复推进（幂等）");
  }

  // 5. 持久化
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));

  const summary = summarize(st);
  const lookback = Math.max(1, Math.min(backfilled || 1, 24));
  const mkt = marketDelta(st, lookback);
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
    advancedTicks: backfilled,
    targetTick: targetTick,
    timelineBase: new Date(st.timelineBase).toISOString(),
    catchUp: backfilled > 1
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
  lines.push("推进 " + backfilled + " 小时 → 累计 " + day + " 天（tick " + st.tick + " / 墙钟目标 " + targetTick + "）· " + new Date().toLocaleString("zh-CN", { hour12: false }));
  lines.push("行情源: " + sourceName + " 实时 | " +
    mainCoins.map((c) => c + "=" + realPrices[c]).join(" ") +
    " | Meme: " + memeCoins.map((c) => c + "=" + realPrices[c]).join(" "));
  lines.push("");
  lines.push("— 市场（近" + lookback + "小时）—");
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