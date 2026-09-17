/*
 * 道场数据自检程序 —— 每日自动运行
 * 用法: node selfcheck.js
 *
 * 校验项（任一 FAIL 即整体 FAIL，并推送告警 + 退出非 0）：
 *   1. 数据新鲜度：latest_summary.json 的 generated_at 距今不超过阈值（默认 2 小时）
 *   2. 真实行情模式：realPriceMode 必须为 true（杜绝合成行情回退）
 *   3. 价格一致性：state.market[coin].price 必须与当次快照拉取的真实价一致（应完全相等）
 *   4. 决策价格一致性：每位主理人每一步开/平/加仓的 price 必须与对应 tick 的币种行情一致
 *   5. Meme 价格健全：极小 meme 币价格不得为 0（曾被 r2 抹成 0 的 T0 事故复查）
 *
 * 产出: data/selfcheck_report.json + stdout；失败时通过 ServerChan 推送告警。
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DIR = __dirname;
const ENGINE = require(path.join(DIR, "engine.js"));
const MARKET = require(path.join(DIR, "marketdata.js"));

const DATA_DIR = path.join(DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SUMMARY_FILE = path.join(DATA_DIR, "latest_summary.json");
const REPORT_FILE = path.join(DATA_DIR, "selfcheck_report.json");
const ERROR_FILE = path.join(DATA_DIR, "last_error.json");
const SENDKEY_FILE = path.join(DATA_DIR, "serverchan_sendkey.txt");

const MAX_STALE_HOURS = parseFloat(process.env.SELFCHECK_STALE_HOURS || "2");
const PRICE_SYNC_TOLERANCE = parseFloat(process.env.SELFCHECK_PRICE_TOL || "0.005"); // 0.5%
const DECISION_TOLERANCE = parseFloat(process.env.SELFCHECK_DECISION_TOL || "0.02"); // 2%（含四舍五入容差）

const COINS = MARKET.TRADE_COINS.map(function (c) { return c[0]; });

function readJson(f) {
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return null; }
}

function round(x, d) { const m = Math.pow(10, d || 2); return Math.round(x * m) / m; }

function sendServerChan(title, desp) {
  try {
    const key = fs.readFileSync(SENDKEY_FILE, "utf8").trim().split(/\r?\n/).find(function (l) { return l.trim(); });
    if (!key) return false;
    execSync(
      `curl -sS -m 15 --data-urlencode "title=${title}" --data-urlencode "desp=${desp}" "https://sctapi.ftqq.com/${key}.send"`,
      { stdio: "pipe", encoding: "utf8" }
    );
    return true;
  } catch (e) { return false; }
}

function main() {
  const results = { checks: {}, failures: [] };
  const summary = readJson(SUMMARY_FILE);
  const state = STATE_FILE === SUMMARY_FILE ? summary : readJson(STATE_FILE);

  function fail(key, msg) { results.checks[key] = { pass: false, message: msg }; results.failures.push(key + ": " + msg); }
  function pass(key, extra) { results.checks[key] = Object.assign({ pass: true }, extra || {}); }

  // ---- 1. 数据新鲜度 ----
  if (!summary) {
    fail("data_freshness", "latest_summary.json 不存在（快照任务可能已停摆）");
  } else {
    const ageH = (Date.now() - new Date(summary.generated_at).getTime()) / 3600000;
    if (!(ageH >= 0) || ageH > MAX_STALE_HOURS) {
      fail("data_freshness", "快照数据过期 " + round(ageH, 2) + " 小时（阈值 " + MAX_STALE_HOURS + "h），定时推进任务可能未运行");
    } else {
      pass("data_freshness", { age_hours: round(ageH, 2), tick: summary.tick, generated_at: summary.generated_at });
    }
  }

  // ---- 2. 真实行情模式 ----
  if (!summary || summary.realPriceMode !== true) {
    fail("real_price_mode", "realPriceMode 不为 true，存在合成行情回退风险");
  } else {
    pass("real_price_mode", { price_source: summary.priceSource || "(unknown)" });
  }

  // ---- 3. 价格一致性（应用价 vs 当次快照拉取价，应完全一致） ----
  if (summary && summary.realPrices && state && state.market) {
    const mismatches = [];
    let checked = 0;
    COINS.forEach(function (coin) {
      const real = summary.realPrices[coin];
      const applied = state.market[coin] && state.market[coin].price;
      if (real == null) return;
      checked++;
      const dev = Math.abs(applied - real) / real;
      if (applied == null || dev > PRICE_SYNC_TOLERANCE) {
        mismatches.push({ coin: coin, applied: applied, fetched: real, deviation: round(dev, 6) });
      }
    });
    if (mismatches.length) fail("price_sync", "应用价与拉取价不一致 " + mismatches.length + " 项：" + JSON.stringify(mismatches));
    else pass("price_sync", { checked: checked });
  } else {
    fail("price_sync", "缺少 realPrices 或 market 数据，无法核对");
  }

  // ---- 4. 决策价格一致性 + 缺失价格回填核查 + 5. meme 价格健全 ----
  const byTick = {};
  if (state && Array.isArray(state.priceHistory)) {
    state.priceHistory.forEach(function (row) { byTick[row.t] = row; });
  }
  let decisionChecked = 0, decisionMismatch = 0, missingPrice = 0;
  const mismatchSamples = [], missingSamples = [];
  let memeZero = [];

  if (state && state.market) {
    COINS.forEach(function (coin) {
      const c = state.market[coin];
      if (c && c.isMeme && (!c.price || c.price <= 0)) memeZero.push(coin);
    });
  }

  if (state && state.managers) {
    for (const id in state.managers) {
      const mgr = state.managers[id];
      const decisions = mgr.decisions || [];
      for (let j = 0; j < decisions.length; j++) {
        const d = decisions[j];
        if (!d || !d.coin) continue;
        if (d.type !== "open" && d.type !== "close" && d.type !== "add") continue;
        const row = byTick[d.tick];
        const markPrice = (d.type === "close" || d.type === "open" || d.type === "add") ? d.price : null;
        if (markPrice == null) {
          // 老数据可能缺失 price，尝试用 priceHistory 反查判断是否还能自洽
          if (!row || row[d.coin] == null) {
            missingPrice++;
            if (missingSamples.length < 20) missingSamples.push({ manager: mgr.id, tick: d.tick, coin: d.coin, type: d.type });
          }
          continue;
        }
        if (!row || row[d.coin] == null) continue;
        decisionChecked++;
        const dev = Math.abs(markPrice - row[d.coin]) / row[d.coin];
        if (dev > DECISION_TOLERANCE) {
          decisionMismatch++;
          if (mismatchSamples.length < 20) mismatchSamples.push({ manager: mgr.id, tick: d.tick, coin: d.coin, type: d.type, decision_price: markPrice, market_price: row[d.coin], deviation: round(dev, 6) });
        }
      }
    }
  }

  if (decisionMismatch > 0) {
    fail("decision_price_consistency", decisionMismatch + " 条决策价格与对应 tick 行情不一致：" + JSON.stringify(mismatchSamples));
  } else if (missingPrice > 0) {
    fail("decision_price_consistency", missingPrice + " 条决策缺少 price 字段且无法从 priceHistory 自洽回填：" + JSON.stringify(missingSamples));
  } else {
    pass("decision_price_consistency", { checked: decisionChecked });
  }

  if (memeZero.length) {
    fail("meme_price_sanity", "meme 币价格为 0（精度事故）：" + memeZero.join(","));
  } else {
    pass("meme_price_sanity", { meme_coins: COINS.filter(function (c) { return state && state.market && state.market[c] && state.market[c].isMeme; }).length });
  }

  // ---- 汇总 ----
  const ok = results.failures.length === 0;
  results.status = ok ? "pass" : "fail";
  results.generated_at = new Date().toISOString();
  results.price_snapshot = null;

  // 附带「实时行情 vs 快照行情」的信息性对比（不判定失败，仅记录漂移量）
  try {
    const now = MARKET.fetchPrices();
    if (now && summary && summary.realPrices) {
      const drifts = {};
      ["BTC", "ETH", "SOL", "BNB", "DOGE", "PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"].forEach(function (coin) {
        const r = now.prices[coin], s = summary.realPrices[coin];
        if (r && s) drifts[coin] = round((r / s - 1) * 100, 3);
      });
      results.live_vs_snapshot = { source: now.source, drift_pct: drifts };
    }
  } catch (e) { /* 信息性，忽略 */ }

  fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2));

  // ---- 输出 ----
  const lines = [];
  lines.push("===== 道场数据自检 =====");
  lines.push("状态: " + (ok ? "✅ 通过" : "❌ 未通过"));
  lines.push("时间: " + results.generated_at);
  for (const k in results.checks) {
    const c = results.checks[k];
    lines.push("  [" + (c.pass ? "PASS" : "FAIL") + "] " + k + (c.message ? " → " + c.message : ""));
  }
  if (results.live_vs_snapshot) {
    lines.push("  快照 vs 当前实盘漂移(%): " + JSON.stringify(results.live_vs_snapshot.drift_pct));
  }
  console.log(lines.join("\n"));

  if (!ok) {
    const desp = lines.join("\n");
    const sent = sendServerChan("道场数据自检未通过", desp);
    console.log(sent ? "[selfcheck] 已通过 ServerChan 推送告警" : "[selfcheck] ServerChan 推送未配置或失败");
    process.exit(1);
  } else {
    if (fs.existsSync(ERROR_FILE)) { try { fs.unlinkSync(ERROR_FILE); } catch (e) {} }
    process.exit(0);
  }
}

main();