/*
 * capture.js — 行情采集 worker（Node 端 · 数据采集平面）
 * ============================================================================
 * 重构目标：取代原先 session 级的临时守护进程（refresh_prices_daemon.js），
 *           把「抓取 → 归一化 → 落盘」做成可常驻、可一次性、可观测的采集 worker。
 *
 * 借鉴（组合）：
 *   - Superalgos：Sensor Bot / Data Mine 的「采集 → 产出数据集」范式。
 *   - StockSharp ：Hydra 行情落库 + 多实例自同步（这里以定时落盘 + 溯源字段体现）。
 *   - Hummingbot ：采集与执行分离（本文件只采集，不触碰交易状态）。
 *
 * 用法：
 *   node capture.js             # 常驻，默认每 5 秒采集一次
 *   node capture.js --once      # 采集一次即退出（供定时任务/CI 调用）
 *   node capture.js --interval 3000
 *
 * 产出：data/live_prices.json（统一 Ticker 模型，供浏览器 datafeed 兜底读取）
 * 铁律：仅在多源取价全部成功时落盘；一旦失败保留上一版快照，绝不写入脏数据。
 */
const fs = require("fs");
const path = require("path");
const MARKET = require(path.join(__dirname, "marketdata.js"));

const LIVE_FILE = path.join(__dirname, "data", "live_prices.json");

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalArg = args.indexOf("--interval");
const INTERVAL_MS = intervalArg >= 0 ? Math.max(1000, parseInt(args[intervalArg + 1], 10) || 5000) : 5000;

function log(msg) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  console.log("[capture " + t + "] " + msg);
}

// 采集一次：返回写出的 payload 或 null
function captureOnce() {
  const tickers = MARKET.fetchTickers();
  if (!tickers || !tickers.BTC) {
    log("⚠ 采集失败（全部源不可达或关键币缺失），保留上一版快照");
    return null;
  }

  // 归一化为统一 Ticker 模型（对齐 CCXT：last / percentage / timestamp / source）
  const prices = {};
  for (const sym in tickers) {
    const t = tickers[sym];
    prices[sym] = {
      last: t.price,
      percentage: t.chg,
      timestamp: t.ts || Date.now(),
      source: "binance-vision"
    };
  }

  const ts = Date.now();
  const payload = {
    generated_at: new Date(ts).toISOString(),
    ts: ts,
    source: "binance-vision",
    timezone: "Asia/Shanghai",
    prices: prices
  };

  fs.writeFileSync(LIVE_FILE, JSON.stringify(payload));
  return payload;
}

function main() {
  if (ONCE) {
    const p = captureOnce();
    if (!p) process.exit(1);
    log("✓ 已写入 data/live_prices.json（" + Object.keys(p.prices).length + " 币）");
    return;
  }

  log("常驻采集启动，间隔 " + INTERVAL_MS + "ms → " + LIVE_FILE);
  let n = 0;
  const loop = function () {
    const p = captureOnce();
    n++;
    if (n % 6 === 1 && p) log("✓ 第 " + n + " 次采集，BTC=" + p.prices.BTC.last);
  };
  loop();
  const timer = setInterval(loop, INTERVAL_MS);

  const stop = function () { clearInterval(timer); log("已停止采集"); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();