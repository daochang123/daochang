/*
 * datafeed.js — 统一实时行情数据层（浏览器端 · 单一数据入口）
 * ============================================================================
 * 重构目标：把过去「前端各自 fetch + 1.5s 轮询 + 静态文件兜底」的散乱实现，
 *           收敛为一个「推送优先、提供者注册表、健康降级、单一入口」的数据层。
 *
 * 借鉴（组合）：
 *   - CCXT            ：统一 Ticker 模型（symbol/last/percentage/timestamp/datetime）
 *                       与 watch* 推送语义（订阅后事件驱动回传，而非轮询）。
 *   - OpenBB          ：Provider 注册表 + 优先级 + 自动降级（get_provider fallback）。
 *   - Jesse           ：CandleExchange(ABC) 的 backup_exchange 备用源思路。
 *   - Hummingbot      ：MarketDataProvider 作为「访问市场数据的单一入口」。
 *
 * 设计要点：
 *   1) 推送优先：浏览器 WebSocket 直连交易所合并流（WebSocket 不受 CORS 预检约束），
 *      事件驱动、无轮询，这是真正意义上的「秒级回传」。
 *   2) 统一模型：所有数据源归一化为 CCXT 兼容 Ticker 对象，带 source / ts / lagMs。
 *   3) 提供者注册表 + 健康度 + 自动降级（按 priority 由高到低）：
 *        binance-ws-vision → binance-ws → gate-ws → binance-rest → gate-rest → file-snapshot
 *   4) 单一入口：看板行情展示统一调用 MarketDataFeed，不再各自 fetch。
 *   5) 平面隔离：本层只管「实时行情平面」，不参与每小时结算（结算另走 state.json）。
 *
 * 用法：
 *   MarketDataFeed.init({
 *     symbols: ["BTC","ETH",...],
 *     onTick: function (sym, ticker) { ... },     // 每个标的更新时回调
 *     onStatus: function (status) { ... }         // 数据源/健康度变化时回调
 *   });
 *   MarketDataFeed.snapshot();  // -> { BTC: ticker, ... }
 *   MarketDataFeed.status();    // -> 健康度/数据源/延迟
 */
(function (global) {
  "use strict";

  var POLL_REST_MS = 3000;       // REST 兜底轮询间隔（仅在 WS 不可用时使用）
  var WS_STALE_MS = 15000;       // WS 超过该时长无推送 → 判为不健康
  var SUPERVISE_MS = 2000;       // 监督器巡检间隔
  var RETRY_COOLDOWN_MS = 30000; // 失败源冷却期
  var UPGRADE_MS = 45000;        // 定期尝试升级回更高优先级源
  var WS_OPEN_TIMEOUT_MS = 8000; // WS 握手超时

  var IS_HTTP = /^https?:$/.test((global.location && global.location.protocol) || "");

  // ---------------------------------------------------------------------------
  // 统一 Ticker 模型（对齐 CCXT Ticker 字段命名）
  // ---------------------------------------------------------------------------
  function mkTicker(symbol, last, percentage, exchangeTs, source, recvAt) {
    var ts = exchangeTs || recvAt;
    return {
      symbol: symbol,
      last: last,
      percentage: (percentage == null || isNaN(percentage)) ? 0 : percentage,
      timestamp: ts,
      datetime: new Date(ts).toISOString(),
      source: source,
      recvAt: recvAt,
      lagMs: Math.max(0, recvAt - ts)
    };
  }

  var FEED = {
    _st: null,
    init: init,
    subscribe: subscribe,
    snapshot: snapshot,
    status: status,
    destroy: destroy
  };
  global.MarketDataFeed = FEED;

  function now() { return Date.now(); }

  // ---------------------------------------------------------------------------
  // 提供者注册表：每个提供者形如
  //   { name, kind:'ws'|'rest'|'file', priority, enabled, start(ctx)->handle, _h }
  // ---------------------------------------------------------------------------
  function buildProviders(ctx) {
    var list = [
      { name: "binance-ws-vision", kind: "ws", priority: 1, start: function (d) { return wsBinance(ctx, "wss://data-stream.binance.vision", d); } },
      { name: "binance-ws", kind: "ws", priority: 2, start: function (d) { return wsBinance(ctx, "wss://stream.binance.com:9443", d); } },
      { name: "gate-ws", kind: "ws", priority: 3, start: function () { return wsGate(ctx); } },
      { name: "binance-rest", kind: "rest", priority: 4, enabled: IS_HTTP, start: function () { return restBinance(ctx); } },
      { name: "gate-rest", kind: "rest", priority: 5, enabled: IS_HTTP, start: function () { return restGate(ctx); } },
      { name: "file-snapshot", kind: "file", priority: 6, start: function () { return fileSnapshot(ctx); } }
    ];
    for (var i = 0; i < list.length; i++) {
      list[i].health = { ok: 0, fail: 0, lastOkAt: 0, lastErrAt: 0, blockedUntil: 0, lastErr: "" };
      list[i]._h = null;
    }
    return list;
  }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------
  function init(opts) {
    opts = opts || {};
    if (FEED._st) destroy();

    var st = {
      symbols: (opts.symbols || []).slice(),
      tickers: {},
      current: null,
      source: "连接中",
      kind: "none",
      connected: false,
      lastTickAt: 0,
      startedAt: now(),
      lastUpgradeAt: 0,
      onTick: opts.onTick || null,
      onStatus: opts.onStatus || null,
      timer: null,
      upgradeTimer: null,
      statusDirty: false
    };
    FEED._st = st;

    var ctx = {
      symbols: st.symbols,
      emit: function (sym, last, pct, exchangeTs) {
        if (!(last > 0)) return;
        var t = mkTicker(sym, last, pct, exchangeTs, st.source, now());
        st.tickers[sym] = t;
        st.lastTickAt = now();
        if (st.current && !st.connected) { st.connected = true; }
        if (st.onTick) { try { st.onTick(sym, t); } catch (e) {} }
      },
      emitMany: function (rows) {
        for (var i = 0; i < rows.length; i++) ctx.emit(rows[i][0], rows[i][1], rows[i][2], rows[i][3]);
      },
      getSym: function () { return st.symbols; }
    };
    st.providers = buildProviders(ctx);
    st.ctx = ctx;

    st.timer = setInterval(supervise, SUPERVISE_MS);
    st.upgradeTimer = setInterval(function () { tryUpgrade(); }, UPGRADE_MS);
    supervise();
    return FEED;
  }

  function destroy() {
    var st = FEED._st;
    if (!st) return;
    if (st.timer) clearInterval(st.timer);
    if (st.upgradeTimer) clearInterval(st.upgradeTimer);
    if (st.current && st.current._h && st.current._h.stop) { try { st.current._h.stop(); } catch (e) {} }
    for (var i = 0; i < st.providers.length; i++) {
      var p = st.providers[i];
      if (p._h && p._h.stop) { try { p._h.stop(); } catch (e) {} }
      p._h = null;
    }
    FEED._st = null;
  }

  function subscribe(symbols) {
    var st = FEED._st; if (!st) return FEED;
    st.symbols = (symbols || []).slice();
    st.ctx.symbols = st.symbols;
    // 重新激活当前源以应用新订阅
    if (st.current) { var c = st.current; deactivate(c); activate(c); }
    return FEED;
  }

  function snapshot() { return FEED._st ? FEED._st.tickers : {}; }

  function status() {
    var st = FEED._st; if (!st) return null;
    var prov = [];
    for (var i = 0; i < st.providers.length; i++) {
      var p = st.providers[i];
      prov.push({
        name: p.name, kind: p.kind, priority: p.priority,
        enabled: p.enabled !== false,
        active: st.current === p,
        blocked: p.health.blockedUntil > now(),
        ok: p.health.ok, fail: p.health.fail, lastErr: p.health.lastErr
      });
    }
    return {
      source: st.source, kind: st.kind, connected: st.connected,
      lastTickAt: st.lastTickAt, ageMs: st.lastTickAt ? now() - st.lastTickAt : null,
      symbols: st.symbols.length, tickers: Object.keys(st.tickers).length,
      providers: prov
    };
  }

  // ---------------------------------------------------------------------------
  // 监督器：健康判定 + 优先级降级 + 升级回切
  // ---------------------------------------------------------------------------
  function isHealthy(p) {
    var st = FEED._st;
    if (!p || !p._h) return false;
    var h = p.health;
    if (p.kind === "ws") return p._h.connected && st.lastTickAt && (now() - st.lastTickAt) < WS_STALE_MS;
    if (p.kind === "rest") return h.lastOkAt && (now() - h.lastOkAt) < POLL_REST_MS * 3;
    if (p.kind === "file") return h.lastOkAt && (now() - h.lastOkAt) < 60000;
    return false;
  }

  function isBlocked(p) { return p.health.blockedUntil > now(); }

  function markFail(p, msg) {
    p.health.fail++;
    p.health.lastErr = msg || "fail";
    p.health.lastErrAt = now();
    if (p.health.fail >= 2) { p.health.blockedUntil = now() + RETRY_COOLDOWN_MS; }
    deactivate(p);
    notifyStatus();
  }

  function activate(p) {
    var st = FEED._st;
    if (!st) return;
    if (st.current && st.current !== p) deactivate(st.current);
    st.current = p;
    st.source = p.name;
    st.kind = p.kind;
    st.connected = false;
    st.lastTickAt = 0;
    try { p._h = p.start(function (msg) { markFail(p, msg); }) || null; }
    catch (e) { p._h = null; markFail(p, String(e && e.message || e)); }
    notifyStatus();
  }

  function deactivate(p) {
    if (p && p._h && p._h.stop) { try { p._h.stop(); } catch (e) {} }
    if (p) p._h = null;
  }

  function supervise() {
    var st = FEED._st; if (!st) return;
    var cur = st.current;
    if (cur && isHealthy(cur)) { notifyStatus(); return; }
    if (cur) { cur.health.fail++; cur.health.lastErr = cur.health.lastErr || "stale"; cur.health.blockedUntil = now() + RETRY_COOLDOWN_MS; deactivate(cur); }
    // 选优先级最高（priority 最小）且未冷却的可用源
    var cand = null;
    for (var i = 0; i < st.providers.length; i++) {
      var p = st.providers[i];
      if (p.enabled === false) continue;
      if (isBlocked(p)) continue;
      if (!cand || p.priority < cand.priority) cand = p;
    }
    if (cand && cand !== cur) activate(cand);
    notifyStatus();
  }

  function tryUpgrade() {
    var st = FEED._st; if (!st || !st.current) return;
    var cur = st.current;
    for (var i = 0; i < st.providers.length; i++) {
      var p = st.providers[i];
      if (p.enabled === false || isBlocked(p)) continue;
      if (p.priority < cur.priority) { activate(p); return; }
    }
    // 无更高优先级可用则维持现状
  }

  function notifyStatus() {
    var st = FEED._st; if (!st || !st.onStatus) return;
    try { st.onStatus(status()); } catch (e) {}
  }

  function ok(p) { p.health.ok++; p.health.lastOkAt = now(); p.health.fail = 0; p.health.blockedUntil = 0; }

  // ---------------------------------------------------------------------------
  // 提供者 1/2：Binance 合并流 WebSocket（镜像 data-stream.binance.vision / 主站）
  //   流名：<symbol>@ticker ；字段：c=最新价 P=24h涨跌幅 E=事件时间
  // ---------------------------------------------------------------------------
  function wsBinance(ctx, base, onFail) {
    var p = FEED._st.current;
    var streams = ctx.symbols.map(function (s) { return s.toLowerCase() + "usdt@ticker"; }).join("/");
    var url = base + "/stream?streams=" + streams;
    var ws = null, closed = false, openTimer = null;
    var handle = { connected: false, stop: function () { closed = true; if (openTimer) clearTimeout(openTimer); try { ws && ws.close(); } catch (e) {} } };
    try { ws = new WebSocket(url); } catch (e) { onFail("ws construct: " + e.message); return handle; }

    openTimer = setTimeout(function () {
      if (!handle.connected && !closed) { onFail("ws open timeout"); try { ws.close(); } catch (e) {} }
    }, WS_OPEN_TIMEOUT_MS);

    ws.onopen = function () {
      handle.connected = true;
      if (openTimer) clearTimeout(openTimer);
      ok(p);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var d = msg && msg.data ? msg.data : msg;
      if (!d || !d.s) return;
      var sym = String(d.s).replace("USDT", "");
      ok(p);
      ctx.emit(sym, parseFloat(d.c), parseFloat(d.P), d.E);
    };
    ws.onerror = function () { if (!closed) onFail("ws error"); };
    ws.onclose = function () { if (!closed) onFail("ws closed"); };
    return handle;
  }

  // ---------------------------------------------------------------------------
  // 提供者 3：Gate.io v4 WebSocket（spot.tickers），需应用级 ping 保活
  // ---------------------------------------------------------------------------
  function wsGate(ctx) {
    var p = FEED._st.current;
    var url = "wss://api.gateio.ws/ws/v4/";
    var ws = null, closed = false, openTimer = null, pingTimer = null;
    var pairs = ctx.symbols.map(function (s) { return s + "_USDT"; });

    var handle = {
      connected: false,
      stop: function () {
        closed = true;
        if (openTimer) clearTimeout(openTimer);
        if (pingTimer) clearInterval(pingTimer);
        try { ws && ws.close(); } catch (e) {}
      }
    };
    try { ws = new WebSocket(url); } catch (e) { return handle; }

    openTimer = setTimeout(function () {
      if (!handle.connected && !closed) { try { ws.close(); } catch (e) {} }
    }, WS_OPEN_TIMEOUT_MS);

    ws.onopen = function () {
      handle.connected = true;
      if (openTimer) clearTimeout(openTimer);
      try {
        ws.send(JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          channel: "spot.tickers", event: "subscribe", payload: pairs
        }));
      } catch (e) {}
      pingTimer = setInterval(function () {
        try { ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: "spot.ping" })); } catch (e) {}
      }, 10000);
      ok(p);
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || msg.channel !== "spot.tickers" || msg.event !== "update" || !msg.result) return;
      var r = msg.result;
      if (!r.currency_pair) return;
      var sym = String(r.currency_pair).split("_")[0];
      ok(p);
      ctx.emit(sym, parseFloat(r.last), parseFloat(r.change_percentage), msg.time_ms || msg.time * 1000);
    };
    ws.onerror = function () { if (!closed) onFailClose(); };
    ws.onclose = function () { if (!closed) onFailClose(); };
    function onFailClose() {
      // 由监督器统一判失败；这里仅置未连接
      handle.connected = false;
    }
    return handle;
  }

  // ---------------------------------------------------------------------------
  // 提供者 4/5：REST 轮询兜底（仅在 http/https 页面启用，避免预览沙箱跨域刷屏）
  // ---------------------------------------------------------------------------
  function restBinance(ctx) {
    var p = FEED._st.current;
    var timer = null, closed = false;
    function tick() {
      if (closed) return;
      var q = ctx.symbols.map(function (s) { return '"' + s + 'USDT"'; }).join(",");
      fetch("https://data-api.binance.vision/api/v3/ticker/24hr?symbols=" + encodeURIComponent("[" + q + "]"), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("binance " + r.status); return r.json(); })
        .then(function (arr) {
          if (closed) return;
          ok(p);
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            ctx.emit(String(it.symbol).replace("USDT", ""), parseFloat(it.lastPrice), parseFloat(it.priceChangePercent), it.closeTime);
          }
        })
        .catch(function (e) { if (!closed) { p.health.lastErr = "rest: " + e.message; } });
    }
    tick();
    timer = setInterval(tick, POLL_REST_MS);
    return { connected: true, stop: function () { closed = true; clearInterval(timer); } };
  }

  function restGate(ctx) {
    var p = FEED._st.current;
    var timer = null, closed = false;
    function tick() {
      if (closed) return;
      var q = ctx.symbols.map(function (s) { return s + "_USDT"; }).join(",");
      fetch("https://api.gateio.ws/api/v4/spot/tickers?currency_pair=" + encodeURIComponent(q), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("gate " + r.status); return r.json(); })
        .then(function (arr) {
          if (closed) return;
          ok(p);
          for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            ctx.emit(String(it.currency_pair).split("_")[0], parseFloat(it.last), parseFloat(it.change_percentage), parseFloat(it.lowest_ask) ? now() : now());
          }
        })
        .catch(function (e) { if (!closed) { p.health.lastErr = "rest: " + e.message; } });
    }
    tick();
    timer = setInterval(tick, POLL_REST_MS);
    return { connected: true, stop: function () { closed = true; clearInterval(timer); } };
  }

  // ---------------------------------------------------------------------------
  // 提供者 6：同源沙箱快照（Node 采集 worker 定时写入的真实行情，最后兜底）
  // ---------------------------------------------------------------------------
  function fileSnapshot(ctx) {
    var p = FEED._st.current;
    var timer = null, closed = false;
    function tick() {
      if (closed) return;
      fetch("data/live_prices.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (sp) {
          if (closed || !sp || !sp.prices) return;
          var t = sp.ts || (sp.generated_at ? Date.parse(sp.generated_at) : now());
          var filled = 0;
          for (var i = 0; i < ctx.symbols.length; i++) {
            var s = ctx.symbols[i], it = sp.prices[s];
            if (it && it.last > 0) { ctx.emit(s, it.last, it.percentage, it.timestamp || t); filled++; }
          }
          if (filled) ok(p);
        });
    }
    tick();
    timer = setInterval(tick, POLL_REST_MS);
    return { connected: true, stop: function () { closed = true; clearInterval(timer); } };
  }
})(window);