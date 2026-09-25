/*
 * 道场看板（客户端运行时）
 * 依赖：window.PROFILES / window.ENGINE（已在 build 时内联）
 * 说明：
 *  - 确定性引擎：由 SEED 从 0 推进到 horizonTicks，可复现。
 *  - 实时模式：以 LAUNCH_TS 起算，随真实时间前进（1 tick = 1 小时）。
 *  - 回测预览：7D/30D/60D/90D/全部 快进到对应模拟天数。
 */
(function () {
  "use strict";

  var SEED = 20260913;
  var LAUNCH_TS = new Date("2026-09-18T00:00:00+08:00").getTime();
  var TICK_MS = 3600000;               // 1 tick = 1 小时
  var MAX_TICKS = 2160;                // 90 天封顶
  var TICK_PER_DAY = 24;

  var state = null;
  var horizon = 0;
  var charts = {};
  var activePreset = "live";

  function $(id) { return document.getElementById(id); }
  function r2(x) { return Math.round(x * 100) / 100; }
  function pct(x) { return (x * 100).toFixed(1) + "%"; }
  function day(t) { return (t / TICK_PER_DAY).toFixed(1); }
  function timeOf(tick) { return LAUNCH_TS + tick * TICK_MS; }
  function fmtDT(ts) {
    // 统一按东八区(Asia/Shanghai)格式化，避免跟随用户设备时区偏移
    var d = new Date(ts + 8 * 3600000);
    function pad(n) { return (n < 10 ? "0" : "") + n; }
    return d.getUTCFullYear() + "/" + (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
  }
  function fmtPrice(p) {
    if (p == null || isNaN(p)) return "—";
    p = Number(p);
    if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    if (p >= 0.01) return p.toFixed(4);
    if (p >= 0.0001) return p.toFixed(6);
    return p.toFixed(8);
  }

  // ---------- 仿真 ----------
  function bootState() {
    var st = ENGINE.initState(SEED, PROFILES.START_EQUITY || 1000);
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i];
      st.managers[p.id] = ENGINE.initManager(p.id, PROFILES.START_EQUITY || 1000);
    }
    return st;
  }
  function liveTicks() {
    var elapsed = Date.now() - LAUNCH_TS;
    return Math.max(0, Math.min(Math.floor(elapsed / TICK_MS), MAX_TICKS));
  }
  function run(horizonTicks) {
    var st = bootState();
    ENGINE.advance(st, horizonTicks);
    return st;
  }

  // ---------- 主题 ----------
  function isDark() { return document.documentElement.getAttribute("data-theme") === "trae-dark"; }
  function cssVar(name) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || undefined;
  }
  function refreshCharts() {
    for (var id in charts) {
      var c = chartFactories[id];
      if (c && charts[id]) charts[id].setOption(c(), true);
    }
  }
  function toggleTheme() {
    var dark = !isDark();
    document.documentElement.setAttribute("data-theme", dark ? "trae-dark" : "");
    refreshCharts();
  }

  // ---------- 图表工厂 ----------
  var chartFactories = {
    chartEquity: function () {
      var series = [];
      var managers = state.managers;
      for (var i = 0; i < PROFILES.KOLS.length; i++) {
        var p = PROFILES.KOLS[i]; var m = managers[p.id];
        var data = [];
        for (var j = 0; j < m.history.length; j++) {
          var h = m.history[j];
          if (h.t <= horizon) data.push([h.t / TICK_PER_DAY, h.e]);
        }
        series.push({
          name: p.name, type: "line", showSymbol: false, smooth: true,
          lineStyle: { width: 2 }, itemStyle: { color: p.color },
          emphasis: { focus: "series" }, data: data
        });
      }
      return {
        backgroundColor: "transparent",
        grid: { left: 44, right: 16, top: 30, bottom: 34 },
        legend: { top: 0, textStyle: { color: cssVar("--chart-muted") } },
        tooltip: { trigger: "axis", valueFormatter: function (v) { return v == null ? "-" : r2(v) + "U"; } },
        xAxis: { type: "value", name: "天", nameTextStyle: { color: cssVar("--chart-muted") }, axisLine: { lineStyle: { color: cssVar("--chart-line") } }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { show: false } },
        yAxis: { type: "value", name: "权益(U)", nameTextStyle: { color: cssVar("--chart-muted") }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { lineStyle: { color: cssVar("--chart-line") } } },
        series: series
      };
    },
    chartDrawdown: function () {
      var series = [];
      for (var i = 0; i < PROFILES.KOLS.length; i++) {
        var p = PROFILES.KOLS[i]; var m = state.managers[p.id];
        var data = []; var peak = m.startEquity;
        for (var j = 0; j < m.history.length; j++) {
          var h = m.history[j];
          if (h.e > peak) peak = h.e;
          if (h.t <= horizon) data.push([h.t / TICK_PER_DAY, r2(-(peak - h.e) / peak * 100)]);
        }
        series.push({ name: p.name, type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: p.color }, areaStyle: { opacity: 0.06 }, data: data });
      }
      return {
        backgroundColor: "transparent",
        grid: { left: 44, right: 16, top: 30, bottom: 34 },
        legend: { top: 0, textStyle: { color: cssVar("--chart-muted") } },
        tooltip: { trigger: "axis", valueFormatter: function (v) { return v == null ? "-" : r2(v) + "%"; } },
        xAxis: { type: "value", name: "天", nameTextStyle: { color: cssVar("--chart-muted") }, axisLine: { lineStyle: { color: cssVar("--chart-line") } }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { show: false } },
        yAxis: { type: "value", name: "回撤%", nameTextStyle: { color: cssVar("--chart-muted") }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { lineStyle: { color: cssVar("--chart-line") } } },
        series: series
      };
    },
    chartMarket: function () {
      var cats = []; var btc = []; var eth = []; var sol = []; var bnb = []; var doge = [];
      var pepe = []; var shib = []; var wif = []; var bonk = []; var floki = []; var meme = [];
      for (var j = 0; j < state.priceHistory.length; j++) {
        var h = state.priceHistory[j];
        if (h.t <= horizon) {
          cats.push(h.t / TICK_PER_DAY);
          btc.push(h.BTC); eth.push(h.ETH); sol.push(h.SOL);
          bnb.push(h.BNB); doge.push(h.DOGE);
          if (h.PEPE) pepe.push(h.PEPE);
          if (h.SHIB) shib.push(h.SHIB);
          if (h.WIF) wif.push(h.WIF);
          if (h.BONK) bonk.push(h.BONK);
          if (h.FLOKI) floki.push(h.FLOKI);
          if (h.MEME) meme.push(h.MEME);
        }
      }
      function norm(arr, base) { return arr.map(function (v) { return r2((v / base - 1) * 100); }); }
      var series = [
        { name: "BTC", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 2 }, data: norm(btc, btc[0] || 1) },
        { name: "ETH", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 2 }, data: norm(eth, eth[0] || 1) },
        { name: "SOL", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 2 }, data: norm(sol, sol[0] || 1) },
        { name: "BNB", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1.5, type: "dashed" }, data: norm(bnb, bnb[0] || 1) },
        { name: "DOGE", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1.5, type: "dashed" }, data: norm(doge, doge[0] || 1) }
      ];
      // Meme coins (only add if data exists)
      if (pepe.length) series.push({ name: "PEPE", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(pepe, pepe[0] || 1) });
      if (shib.length) series.push({ name: "SHIB", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(shib, shib[0] || 1) });
      if (wif.length) series.push({ name: "WIF", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(wif, wif[0] || 1) });
      if (bonk.length) series.push({ name: "BONK", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(bonk, bonk[0] || 1) });
      if (floki.length) series.push({ name: "FLOKI", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(floki, floki[0] || 1) });
      if (meme.length) series.push({ name: "MEME", type: "line", showSymbol: false, smooth: true, lineStyle: { width: 1, type: "dotted" }, data: norm(meme, meme[0] || 1) });
      return {
        backgroundColor: "transparent",
        grid: { left: 44, right: 16, top: 30, bottom: 34 },
        legend: { top: 0, textStyle: { color: cssVar("--chart-muted") } },
        tooltip: { trigger: "axis", valueFormatter: function (v) { return v == null ? "-" : r2(v) + "%"; } },
        xAxis: { type: "value", name: "天", nameTextStyle: { color: cssVar("--chart-muted") }, axisLine: { lineStyle: { color: cssVar("--chart-line") } }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { show: false } },
        yAxis: { type: "value", name: "涨跌%", nameTextStyle: { color: cssVar("--chart-muted") }, axisLabel: { color: cssVar("--chart-muted") }, splitLine: { lineStyle: { color: cssVar("--chart-line") } } },
        series: series
      };
    }
  };

  function initCharts() {
    for (var id in chartFactories) {
      var dom = $(id);
      if (!dom || !window.echarts) continue;
      if (charts[id]) { charts[id].setOption(chartFactories[id](), true); continue; }
      charts[id] = echarts.init(dom);
      charts[id].setOption(chartFactories[id]());
    }
    window.addEventListener("resize", function () {
      for (var id in charts) charts[id].resize();
    });
  }

  // ---------- KPI ----------
  function renderKpi() {
    var summary = ENGINE.summary(state);
    var el = $("kpiGrid");
    var html = "";
    for (var i = 0; i < summary.length; i++) {
      var r = summary[i];
      var arrow = r.pnl >= 0 ? "▲" : "▼";
      var cls = r.pnl >= 0 ? "up" : "down";
      var isMajor = Math.abs(r.pnlPct) >= 0.10; // 重要事件：盈亏波动 ≥10% 或回撤 ≥15%
      var isMajorDd = r.maxDrawdown >= 0.15;
      var badge = "";
      if (isMajor || isMajorDd) {
        badge = '<span class="tag ' + ((isMajor && r.pnl >= 0) || isMajorDd ? "tag-red" : "tag-green") + '">' + (isMajor && r.pnl >= 0 ? "盈利大增" : (isMajor ? "亏损预警" : "重大回撤")) + '</span> ';
      }
      var pnlAbs = (r.pnl >= 0 ? "+" : "") + r2(r.pnl) + "U";
      var mgr = state.managers[r.id];
      var held = "空仓";
      if (mgr && mgr.positions && mgr.positions.length) {
        var seen = {}, syms = [];
        for (var pi = 0; pi < mgr.positions.length; pi++) { var pc = mgr.positions[pi].coin; if (!seen[pc]) { seen[pc] = 1; syms.push(pc); } }
        held = syms.join("·");
      }
      html += '<section class="kpi-tile" data-id="' + r.id + '" style="--c:' + r.color + '">' +
        '<div class="kpi-top"><span class="kpi-name">' + r.name + '</span><span class="kpi-arena">' + r.arena + '</span></div>' +
        '<div class="kpi-value' + (isMajor && r.pnl < 0 ? " hl-red" : (isMajor && r.pnl >= 0 ? " hl-green" : "")) + '">' + r2(r.equity) + '<span class="kpi-unit">U</span></div>' +
        '<div class="kpi-delta ' + cls + '">' + arrow + " " + pct(r.pnlPct) + ' <span style="font-size:11px;opacity:0.8">(' + pnlAbs + ')</span></div>' +
        badge +
        '<div class="kpi-meta">交易 ' + r.trades + " · 胜率 " + pct(r.winRate) + '</div>' +
        '<div class="kpi-meta">回撤 -' + pct(r.maxDrawdown) + " · 持仓 " + r.open + "：" + held + '</div>' +
        '</section>';
    }
    el.innerHTML = html;
    var tiles = el.querySelectorAll(".kpi-tile");
    for (var k = 0; k < tiles.length; k++) {
      tiles[k].addEventListener("click", function () { openManager(this.getAttribute("data-id")); });
    }
    fillFreshness();
  }

  function fillFreshness() {
    var done = state.tick;
    $("dataFreshness").textContent = "已推进 " + day(done) + " 天 · 数据更新 " + new Date().toLocaleString("zh-CN", { hour12: false });
  }

  // ---------- 排行榜 ----------
  function renderRanking() {
    var summary = ENGINE.summary(state);
    // 按权益排序
    summary.sort(function (a, b) { return b.equity - a.equity; });
    var el = $("rankingList");
    if (!el) return;
    var html = "";
    for (var i = 0; i < summary.length; i++) {
      var r = summary[i];
      var rank = i + 1;
      var rankClass = rank === 1 ? "gold" : (rank === 2 ? "silver" : (rank === 3 ? "bronze" : ""));
      var rankIcon = rank === 1 ? "🥇" : (rank === 2 ? "🥈" : (rank === 3 ? "🥉" : rank));
      var pnlClass = r.pnlPct >= 0 ? "up" : "down";
      var pnlSign = r.pnlPct >= 0 ? "+" : "";
      var pnlAbs = pnlSign + r2(r.pnl) + "U";
      var m2 = state.managers[r.id];
      var held2 = "空仓";
      if (m2 && m2.positions && m2.positions.length) {
        var seen2 = {}, syms2 = [];
        for (var pj = 0; pj < m2.positions.length; pj++) { var pc2 = m2.positions[pj].coin; if (!seen2[pc2]) { seen2[pc2] = 1; syms2.push(pc2); } }
        held2 = syms2.join("·");
      }
      html += '<div class="ranking-item">' +
        '<div class="ranking-rank ' + rankClass + '">' + rankIcon + '</div>' +
        '<div class="ranking-info">' +
          '<div class="ranking-name" style="color:' + r.color + '">' + r.name + ' <span style="color:var(--muted);font-weight:400;font-size:11px">' + r.arena + '</span></div>' +
          '<div class="ranking-stats">' +
            '<span>交易 ' + r.trades + '</span>' +
            '<span>胜率 ' + pct(r.winRate) + '</span>' +
            '<span>回撤 -' + pct(r.maxDrawdown) + '</span>' +
            '<span>持仓 ' + r.open + '（' + held2 + '）</span>' +
            '<span>进化 ' + r.evolution + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="ranking-equity">' + r2(r.equity) + 'U</div>' +
        '<div class="ranking-pnl ' + pnlClass + '">' + pnlSign + pct(r.pnlPct) + '<div style="font-size:11px;opacity:0.8">' + pnlAbs + '</div></div>' +
        '</div>';
    }
    el.innerHTML = html;
  }

  // ---------- 列表表格通用：主理人胶囊筛选 + 超10条折叠 ----------
  var COLLAPSE_LIMIT = 10;
  var filters = { decisions: "", evolution: "", daily: "", positions: "" };

  function chipRow(section, activeId) {
    var html = '<button class="chip' + (activeId === "" ? " active" : "") + '" onclick="setSectionFilter(\'' + section + '\',\'\')">全部</button>';
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i];
      html += '<button class="chip' + (activeId === p.id ? " active" : "") + '" onclick="setSectionFilter(\'' + section + '\',\'' + p.id + '\')"><i class="chip-dot" style="background:' + p.color + '"></i>' + p.name + '</button>';
    }
    return html;
  }
  window.setSectionFilter = function (section, id) {
    filters[section] = id || "";
    renderAllTables();
  };

  function setTable(bodyId, rowHtmlArr, colspan, emptyText) {
    var body = $(bodyId);
    if (!body) return;
    body._rows = rowHtmlArr || [];
    body._colspan = colspan;
    body._empty = emptyText || "暂无记录";
    body._expanded = false;
    drawTable(body);
  }
  function drawTable(body) {
    var rows = body._rows;
    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="' + body._colspan + '" class="empty">' + body._empty + '</td></tr>';
      return;
    }
    var collapsed = rows.length > COLLAPSE_LIMIT && !body._expanded;
    var shown = collapsed ? rows.slice(0, COLLAPSE_LIMIT) : rows;
    var html = shown.join("");
    if (rows.length > COLLAPSE_LIMIT) {
      html += '<tr class="collapse-row"><td colspan="' + body._colspan + '"><button class="collapse-btn" onclick="toggleTable(\'' + body.id + '\')">' +
        (collapsed ? '展开全部 ' + rows.length + ' 条 ▼' : '收起 ▲') + '</button></td></tr>';
    }
    body.innerHTML = html;
  }
  window.toggleTable = function (bodyId) {
    var body = $(bodyId);
    if (!body) return;
    body._expanded = !body._expanded;
    drawTable(body);
  };

  // ---------- 操作决策日志（新到旧 · 含开仓价/平仓价） ----------
  function makeDecisionRow(prof, d) {
    var single = filters.decisions !== "";
    var isBlock = d.type === "iron_block";
    var typeLabel = d.type === "open" ? "开仓" : (d.type === "close" ? "平仓" : (d.type === "add" ? "加仓" : (d.type === "1_3_watch" ? "1+3观望" : (isBlock ? "铁律拦截" : d.type))));
    var typeCls = isBlock ? ' class="hl-red-bg"' : (d.type === "1_3_watch" ? ' class="hl-yellow"' : "");
    var typeTag = isBlock ? '<span class="tag tag-red">重要</span> ' : (d.type === "1_3_watch" ? '<span class="tag" style="background:#fff3cd;color:#856404">观望</span> ' : "");
    var openPx = "—";
    var closePx = "—";
    if (d.type === "open") {
      openPx = (typeof d.price === "number") ? "$" + fmtPrice(d.price) : openPx;
    } else if (d.type === "close") {
      openPx = (typeof d.entry === "number") ? "$" + fmtPrice(d.entry) : openPx;
      closePx = (typeof d.price === "number") ? "$" + fmtPrice(d.price) : closePx;
    }
    var nameCell = single ? "" : '<td style="color:' + prof.color + '">' + prof.name + '</td>';
    var html = '<tr>' + nameCell + '<td class="nowrap">' + fmtDT(timeOf(d.tick)) + '</td><td' + typeCls + '>' + typeTag + typeLabel + '</td><td>' + (d.coin || "") +
      '</td><td>' + (d.side || "") + '</td>' +
      '<td class="num">' + openPx + '</td><td class="num">' + closePx + '</td>' +
      '<td>' + (d.detail || "") + '</td><td class="rat">' + (d.rationale || "") + '</td></tr>';
    return { tick: d.tick, html: html };
  }
  function renderDecisions() {
    var fc = $("decisionFilter");
    if (fc) fc.innerHTML = chipRow("decisions", filters.decisions);
    var single = filters.decisions !== "";
    var thMgr = $("decisionThMgr");
    if (thMgr) thMgr.style.display = single ? "none" : "";

    var items = [];
    if (single) {
      var prof = PROFILES.byId(filters.decisions);
      var mgr = state.managers[filters.decisions];
      if (mgr) {
        for (var j = mgr.decisions.length - 1; j >= 0; j--) items.push(makeDecisionRow(prof, mgr.decisions[j]));
      }
    } else {
      // 先收集全部决策，再按时间降序排列，最后截取最近 120 条
      // 修复：旧逻辑按主理人顺序收集 120 条就截断，导致某位主理人决策多时其他主理人的近期决策被漏掉
      for (var i2 = 0; i2 < PROFILES.KOLS.length; i2++) {
        var p2 = PROFILES.KOLS[i2]; var m2 = state.managers[p2.id];
        for (var j2 = m2.decisions.length - 1; j2 >= 0; j2--) {
          items.push(makeDecisionRow(p2, m2.decisions[j2]));
        }
      }
      items.sort(function (a, b) { return b.tick - a.tick; });
      if (items.length > 120) items.length = 120;
    }
    setTable("decisionBody", items.map(function (r) { return r.html; }), single ? 8 : 9, single ? "该主理人暂无决策记录" : "当前窗口无决策记录");
  }

  // ---------- 自我纠错沉淀 ----------
  function makeEvolutionRow(p, e) {
    var single = filters.evolution !== "";
    var nameCell = single ? "" : '<td style="color:' + p.color + '">' + p.name + '</td>';
    var html = '<tr>' + nameCell + '<td class="nowrap">' + fmtDT(timeOf(e.tick)) + '</td><td>' + (e.trigger || "") + '</td><td class="rat">' + (e.lesson || "") + '</td></tr>';
    return { tick: e.tick, html: html };
  }
  function renderEvolution() {
    var fc = $("evolutionFilter");
    if (fc) fc.innerHTML = chipRow("evolution", filters.evolution);
    var single = filters.evolution !== "";
    var thMgr = $("evolutionThMgr");
    if (thMgr) thMgr.style.display = single ? "none" : "";

    var items = [];
    var ids = single ? [filters.evolution] : PROFILES.KOLS.map(function (p) { return p.id; });
    for (var mi = 0; mi < ids.length; mi++) {
      var p2 = PROFILES.byId(ids[mi]); var m2 = state.managers[ids[mi]]; if (!m2) continue;
      for (var j = m2.evolution.length - 1; j >= 0; j--) items.push(makeEvolutionRow(p2, m2.evolution[j]));
    }
    items.sort(function (a, b) { return b.tick - a.tick; });
    setTable("evolutionBody", items.map(function (r) { return r.html; }), single ? 3 : 4, single ? "该主理人暂无进化沉淀" : "暂无进化沉淀");
  }

  // ---------- 每日复盘 ----------
  function makeDailyRow(p, r) {
    var single = filters.daily !== "";
    var winRate = (typeof r.winRate === "number") ? r.winRate : (r.trades ? (r.wins / r.trades) : 0);
    var up = r.pnl >= 0;
    var isMajor = Math.abs(r.pnlPct) >= 0.05;
    var pnlCls = up ? (isMajor ? "hl-green-bg" : "hl-green") : "hl-red-bg";
    var equityCls = isMajor && !up ? "hl-red" : "";
    var tradeStr = r.trades === 0 ? "空仓无交易" : (r.trades + "笔 · 胜率" + Math.round(winRate * 100) + "% · " + r.wins + "胜/" + r.losses + "负");
    var nameCell = single ? "" : '<td style="color:' + p.color + '">' + p.name + '</td>';
    var html = '<tr>' + nameCell + '<td>第' + ((r.day || 0) + 1) + '天</td>' +
      '<td class="' + equityCls + '">' + r2(r.equity || 0) + '</td>' +
      '<td class="' + pnlCls + '">' + (up ? '+' : '') + r2(r.pnl || 0) + ' (' + (up ? '+' : '') + pct(r.pnlPct || 0) + ')</td>' +
      '<td>' + tradeStr + '</td>' +
      '<td class="rat">' + (r.lesson || "") + (r.action ? '<div style="color:var(--faint);font-size:11px;margin-top:2px">→ ' + r.action + '</div>' : '') + '</td></tr>';
    return { day: (r.day || 0), html: html };
  }
  function renderDailyReview() {
    var fc = $("dailyFilter");
    if (fc) fc.innerHTML = chipRow("daily", filters.daily);
    var single = filters.daily !== "";
    var thMgr = $("dailyThMgr");
    if (thMgr) thMgr.style.display = single ? "none" : "";

    var items = [];
    var ids = single ? [filters.daily] : PROFILES.KOLS.map(function (p) { return p.id; });
    for (var mi = 0; mi < ids.length; mi++) {
      var p2 = PROFILES.byId(ids[mi]); var m2 = state.managers[ids[mi]]; if (!m2) continue;
      var rev = m2.dailyReview || [];
      for (var j = rev.length - 1; j >= 0; j--) items.push(makeDailyRow(p2, rev[j]));
    }
    items.sort(function (a, b) { return b.day - a.day; });
    setTable("dailyReviewBody", items.map(function (r) { return r.html; }), single ? 5 : 6, single ? "该主理人暂无每日复盘" : "暂无每日复盘（首个完整交易日后自动生成，可在 7D/30D 预览中直接查看）");
  }

  // ---------- 当前持仓 ----------
  function makePositionRow(p, pos) {
    var single = filters.positions !== "";
    var kind = pos.kind === "spot" ? "现货" : (pos.kind === "perp" ? "合约" : (pos.otype === "call" ? "看涨(" + pos.side + ")" : "看跌(" + pos.side + ")"));
    var qty = pos.qty ? r2(pos.qty) : (pos.contracts || "-");
    var entry = (typeof pos.entry === "number") ? "$" + fmtPrice(pos.entry) : "-";
    var nameCell = single ? "" : '<td style="color:' + p.color + '">' + p.name + '</td>';
    var html = '<tr>' + nameCell + '<td>' + pos.coin + '</td><td>' + kind + '</td><td>' + (pos.side || "") + '</td><td class="num">' + qty + '</td><td class="num">' + entry + '</td></tr>';
    return { tick: (typeof pos.openTick === "number" ? pos.openTick : 0), html: html };
  }
  function renderPositions() {
    var fc = $("positionFilter");
    if (fc) fc.innerHTML = chipRow("positions", filters.positions);
    var single = filters.positions !== "";
    var thMgr = $("positionThMgr");
    if (thMgr) thMgr.style.display = single ? "none" : "";

    var items = [];
    var ids = single ? [filters.positions] : PROFILES.KOLS.map(function (p) { return p.id; });
    for (var mi = 0; mi < ids.length; mi++) {
      var p2 = PROFILES.byId(ids[mi]); var m2 = state.managers[ids[mi]]; if (!m2) continue;
      for (var j = 0; j < m2.positions.length; j++) items.push(makePositionRow(p2, m2.positions[j]));
    }
    items.sort(function (a, b) { return b.tick - a.tick; });
    setTable("positionBody", items.map(function (r) { return r.html; }), single ? 5 : 6, single ? "该主理人当前无持仓" : "当前无持仓");
  }

  function renderIronRules() {
    $("ironRulesBox").innerHTML = PROFILES.IRON_RULES_OPTIONS.map(function (r) {
      return '<li>' + r + '</li>';
    }).join("");
  }

  // ---------- 主理人详情（体系课程/核心逻辑/铁律） ----------
  function openManager(id) {
    var p = PROFILES.byId(id);
    if (!p) return;
    $("mgDetailName").textContent = p.name + " · " + p.aka;
    $("mgDetailStyle").textContent = p.style;
    $("mgDetailThesis").textContent = p.thesis;
    $("mgDetailSystem").innerHTML = "<b>" + p.coreSystem.name + "</b><br>" + p.coreSystem.desc;
    $("mgDetailLogic").innerHTML = p.coreLogic.map(function (l) {
      return '<div class="logic-item"><b>' + l.title + '</b>：' + l.body + '</div>';
    }).join("");
    $("mgDetailIron").innerHTML = p.ironRules.map(function (r) { return '<li>' + r + '</li>'; }).join("");
    $("mgDetailCourse").innerHTML = p.course.modules.map(function (m) {
      return '<div class="course-mod"><h4>' + m.title + '</h4><ul>' + m.points.map(function (pt) { return '<li>' + pt + '</li>'; }).join("") + '</ul></div>';
    }).join("");
    $("mgDetailQuotes").innerHTML = p.quotes.map(function (q) { return '<li>' + q + '</li>'; }).join("");
    $("mgDrawer").classList.add("open");
  }
  function closeDrawer() { $("mgDrawer").classList.remove("open"); }

  // ---------- 时间控制 ----------
  var PRESETS = { live: null, "7d": 168, "30d": 720, "60d": 1440, "90d": 2160, all: MAX_TICKS };
  function setPreset(key) {
    activePreset = key;
    var btns = document.querySelectorAll("[data-range-preset]");
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-range-preset") === key);
    if (key === "live") {
      $("rangeStart").value = 0;
      $("rangeEnd").value = 0;
      applyLive(true);
      return;
    }
    horizon = PRESETS[key];
    $("rangeStart").value = 0;
    $("rangeEnd").value = Math.floor(horizon / TICK_PER_DAY);
    apply();
  }
  function apply() {
    state = run(horizon);
    var s = Math.floor(horizon / TICK_PER_DAY);
    $("activeRangeLabel").textContent = "第 0 – " + s + " 天（推演预览）";
    renderAllTables();
    refreshCharts();
  }
  function applyCustom() {
    var s = parseInt($("rangeStart").value || "0", 10);
    var e = parseInt($("rangeEnd").value || "0", 10);
    if (isNaN(s) || isNaN(e) || e < s) e = s;
    activePreset = "custom";
    var btns = document.querySelectorAll("[data-range-preset]");
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove("active");
    horizon = Math.min(e * TICK_PER_DAY, MAX_TICKS);
    apply();
  }

  // ---------- 数据源 Modal ----------
  var globalCurrentSource = { title: "", snippet: "", logic: "" };
  function showSource(title, snippet, logic) {
    globalCurrentSource = { title: title, snippet: snippet, logic: logic };
    $("modalTitle").textContent = title;
    $("modalSnippet").textContent = snippet;
    $("modalLogic").textContent = logic;
    $("modalBackdrop").classList.add("open");
  }
  function closeModal() { $("modalBackdrop").classList.remove("open"); }
  function copyText(id) {
    var t = $(id).textContent || "";
    if (navigator.clipboard) navigator.clipboard.writeText(t);
  }

  var SOURCE_META = {
    chartEquity: {
      title: "权益曲线",
      snippet: "对 state.managers[id].history（t=模拟tick, e=权益U）按 x=t/24 天 抽样绘制多序列折线。",
      logic: "5 位 AI 主理人从 1000U 起步，逐 tick 记账（现货/合约/价差期权），权益=现金+未实现损益；此处按通道取每 tick 快照。"
    },
    chartDrawdown: {
      title: "回撤曲线",
      snippet: "峰值回撤 = (历史峰值 - 当前权益) / 历史峰值 × 100%，逐 tick 计算。",
      logic: "对每位主理人的权益历史做滚动峰值，输出回撤百分比序列，用于衡量最大回撤与风险特征。"
    },
    chartMarket: {
      title: "市场走势",
      snippet: "state.priceHistory 记录 BTC/ETH/SOL 价格，转成相对首点的涨跌%绘制。",
      logic: "几何随机游走 + 趋势状态机(regime) + 偶发冲击，drift/vol 按币种定义；用于给趋势/均值回归策略提供可捕捉的 edge。"
    }
  };

  // ---------- AI 对话（agnès 模型，优先 3.0-flash，失败依次回退 2.5-flash → DeepSeek V4 flash） ----------
  var AGNES_BASE = "https://api.agnes-ai.cn/v1";
  var AGNES_KEY = "sk-IshOaJW7iFMSCMhDkFvMCXxQPg2awNuZ8wrT7MNYptA1bTB0";
  var DEEPSEEK_BASE = "https://api.deepseek.com/v1";
  var DEEPSEEK_KEY = ""; // 可选：填入 DeepSeek 官方 API Key（sk-...）以启用第三级回退
  var AI_CHAT_MODELS = [
    { id: "agnes-3.0-flash", label: "agnès 3.0-flash", base: AGNES_BASE, key: AGNES_KEY },
    { id: "agnes-2.5-flash", label: "agnès 2.5-flash", base: AGNES_BASE, key: AGNES_KEY },
    { id: "deepseek-v4-flash", label: "DeepSeek V4 flash", base: DEEPSEEK_BASE, key: DEEPSEEK_KEY }
  ];
  var aiHistory = []; // [{role, content}]
  var aiBusy = false;
  var aiActiveModel = 0; // 激活模型的索引（0=agnès 3.0-flash，优先）

  function buildSystemPrompt() {
    var snap = "";
    try {
      var s = ENGINE.summary(state);
      snap = "当前模拟盘快照（起始 1000U，单位 U）：\n" + s.map(function (r) {
        return "  - " + r.name + "[" + r.arena + "] 权益=" + r2(r.equity) + " 盈亏=" + (r.pnlPct * 100).toFixed(1) + "% 胜率=" + (r.winRate * 100).toFixed(0) + "% 最大回撤=-" + (r.maxDrawdown * 100).toFixed(1) + "% 持仓=" + r.open;
      }).join("\n");
      snap += "\n已推进 " + day(state.tick) + " 天。";
    } catch (e) { snap = ""; }
    return "你是「AI主理·实盘道场/期权演武场」看板的交易军师，熟悉六位 KOL 体系（蓝鸟会/狙击手/老猫/熬鹰/幻狐/洪七公）。\n" +
      "请基于下方实时快照与用户问题，给出简明的解读、归因或操作建议；涉及具体策略时点出对应主理人的规则铁律。回答用中文、简洁、分点。\n" + snap;
  }

  function aiAppend(role, text, modelNote) {
    var log = $("aiChatLog");
    var div = document.createElement("div");
    div.className = "ai-msg " + role;
    div.textContent = text;
    if (modelNote) {
      var tag = document.createElement("div");
      tag.className = "ai-note";
      tag.style.cssText = "font-size:10px;color:var(--faint);margin-top:4px";
      tag.textContent = modelNote;
      div.appendChild(tag);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function aiSend() {
    if (aiBusy) return;
    var input = $("aiChatInput");
    var text = (input.value || "").trim();
    if (!text) return;
    input.value = "";
    aiHistory.push({ role: "user", content: text });
    aiAppend("user", text);
    aiBusy = true;
    var btn = $("aiChatSend");
    btn.disabled = true;
    aiAppend("sys", "正在调用 " + AI_CHAT_MODELS[aiActiveModel].label + "（不通则按 2.5-flash → DeepSeek V4 flash 顺序自动回退）…");

    var messages = [{ role: "system", content: buildSystemPrompt() }].concat(aiHistory.slice(-12));

    function callOnce(idx) {
      var m = AI_CHAT_MODELS[idx];
      if (!m.key) return Promise.reject(new Error("no api key"));
      return fetch(m.base + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + m.key },
        body: JSON.stringify({ model: m.id, messages: messages, temperature: 0.4, max_tokens: 600 })
      }).then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then(function (j) {
        var c = j && j.choices && j.choices[0] && j.choices[0].message;
        if (!c || !c.content) throw new Error("empty content");
        return c.content;
      });
    }

    // 三级回退链：agnès 3.0-flash → agnès 2.5-flash → DeepSeek V4 flash；全部失败才报错
    function chainFrom(idx) {
      return callOnce(idx).catch(function () {
        if (idx + 1 < AI_CHAT_MODELS.length) {
          aiActiveModel = idx + 1;
          aiAppend("sys", AI_CHAT_MODELS[idx].label + " 调用失败，已自动切换到 " + AI_CHAT_MODELS[idx + 1].label + " 重试。");
          return chainFrom(idx + 1);
        }
        aiActiveModel = 0; // 全部失败，复位优先 agnès 3.0-flash
        throw new Error("all models failed");
      });
    }

    chainFrom(aiActiveModel)
      .then(function (content) {
        aiHistory.push({ role: "assistant", content: content });
        aiAppend("assistant", content, "模型：" + AI_CHAT_MODELS[aiActiveModel].label);
        aiActiveModel = 0; // 成功后复位，下次优先 agnès 3.0-flash
      })
      .catch(function (err) {
        aiActiveModel = 0;
        aiAppend("sys", "三个模型均调用失败（" + (err && err.message ? err.message : err) + "），请检查网络或稍后再试。");
      })
      .then(function () {
        aiBusy = false;
        btn.disabled = false;
      });
  }

  function aiClear() {
    aiHistory = [];
    $("aiChatLog").innerHTML = "";
    aiActiveModel = 0;
    aiAppend("sys", "对话已清空。");
  }

  // ---------- 数据加载：实时 = 云端快照（与刷新一致）；预览 = 本地确定性回测 ----------
  function loadCloudSnapshot() {
    return fetch("data/latest.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (live) {
        return (live && live.managers && typeof live.tick === "number" && live.market) ? live : null;
      });
  }
  function applyLive(showFeedback) {
    if (showFeedback) {
      var btn = $("refreshBtn");
      if (btn) { btn.disabled = true; btn.textContent = "⟳"; btn.style.opacity = 0.5; }
    }
    loadCloudSnapshot().then(function (live) {
      if (live) bootWithLiveState(live);
      else bootDeterministic();
      var btn = $("refreshBtn");
      if (btn) { btn.textContent = "✓"; setTimeout(function () { btn.textContent = "↻"; btn.disabled = false; btn.style.opacity = 1; }, 1200); }
    });
  }
  function refreshData() { applyLive(true); }

  // ---------- 事件绑定 ----------
  function bindEvents() {
    document.querySelectorAll("[data-range-preset]").forEach(function (b) {
      b.addEventListener("click", function () { setPreset(b.getAttribute("data-range-preset")); });
    });
    $("rangeStart").addEventListener("change", applyCustom);
    $("rangeEnd").addEventListener("change", applyCustom);
    $("themeBtn").addEventListener("click", toggleTheme);
    $("refreshBtn").addEventListener("click", refreshData);
    $("mgClose").addEventListener("click", closeDrawer);
    $("modalClose").addEventListener("click", closeModal);
    $("copySnippet").addEventListener("click", function () { copyText("modalSnippet"); });
    $("copyLogic").addEventListener("click", function () { copyText("modalLogic"); });
    $("modalBackdrop").addEventListener("click", function (e) { if (e.target === $("modalBackdrop")) closeModal(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { closeModal(); closeDrawer(); } });
    // 每个图表面板的来源查看
    document.querySelectorAll(".chart-panel").forEach(function (panel) {
      var srcBtn = panel.querySelector("[data-source]");
      if (srcBtn) srcBtn.addEventListener("click", function () {
        var k = panel.getAttribute("data-chart");
        var meta = SOURCE_META[k] || { title: k, snippet: "-", logic: "-" };
        showSource(meta.title, meta.snippet, meta.logic);
      });
    });
    // AI 对话
    var sendBtn = $("aiChatSend");
    if (sendBtn) sendBtn.addEventListener("click", aiSend);
    var chatInput = $("aiChatInput");
    if (chatInput) chatInput.addEventListener("keydown", function (e) { if (e.key === "Enter") aiSend(); });
    var clearBtn = $("aiChatClear");
    if (clearBtn) clearBtn.addEventListener("click", aiClear);
  }

  // ---------- 入口 ----------
  function highlightPreset(key) {
    document.querySelectorAll("[data-range-preset]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-range-preset") === key);
    });
  }
  function renderAllTables() {
    renderIronRules(); renderKpi(); renderRanking(); renderDecisions(); renderEvolution(); renderPositions(); renderDailyReview();
  }

  // ---------- 实时行情（统一数据层 · 推送优先 · 真·秒级 · 多源自动降级） ----------
  // 取数全部交给 MarketDataFeed（datafeed.js）：WebSocket 推送 → REST 轮询 → 同源快照。
  // 本函数只负责渲染，与取数彻底解耦（Hummingbot：MarketDataProvider 单一数据入口）。
  // 主流币 TOP10（市值排名，剔除稳定币）；Meme 币为主理人严选（剔除高风险割韭菜币）
  function initLiveTicker() {
    var mainGrid = $("liveMainGrid");
    var memeGrid = $("liveMemeGrid");
    if (!mainGrid && !memeGrid) return;
    if (!window.MarketDataFeed) return;

    var MAINSTREAM = [
      { rank: 1, sym: "BTC" }, { rank: 2, sym: "ETH" }, { rank: 3, sym: "XRP" },
      { rank: 4, sym: "BNB" }, { rank: 5, sym: "SOL" }, { rank: 6, sym: "ADA" },
      { rank: 7, sym: "TRX" }, { rank: 8, sym: "AVAX" }, { rank: 9, sym: "LINK" }, { rank: 10, sym: "SUI" }
    ];
    var MEMES = ["DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI"];
    var ALL = MAINSTREAM.map(function (c) { return c.sym; }).concat(MEMES);

    // 交易跳转目标（国内可直连优先；如需切换交易所改这里）
    var EXCHANGE = {
      name: "Gate.io",
      tradeUrl: function (sym) { return "https://www.gate.io/trade/" + sym + "_USDT"; }
    };

    function fmtPx(p) {
      if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
      if (p >= 1) return p.toFixed(2);
      if (p >= 0.01) return p.toFixed(4);
      if (p >= 0.0001) return p.toFixed(6);
      return p.toFixed(8);
    }

    function coinCard(sym, rank, d) {
      var href = EXCHANGE.tradeUrl(sym);
      if (!d || !(d.last > 0)) {
        return '<a class="coin-card" href="' + href + '" target="_blank" rel="noopener" title="点击前往 ' + EXCHANGE.name + ' 交易 ' + sym + '/USDT">' +
          '<div class="cc-top"><span class="cc-rank">' + (rank || "") + '</span><span class="cc-sym">' + sym + '</span>' +
          '<span class="cc-chg cc-pending">—</span></div>' +
          '<div class="cc-price cc-pending">等待数据…</div></a>';
      }
      var chg = d.percentage || 0;
      var cls = chg >= 0 ? "up" : "down";
      var sign = chg >= 0 ? "+" : "";
      return '<a class="coin-card ' + cls + '" href="' + href + '" target="_blank" rel="noopener" title="点击前往 ' + EXCHANGE.name + ' 交易 ' + sym + '/USDT">' +
        '<div class="cc-top"><span class="cc-rank">' + (rank || "") + '</span><span class="cc-sym">' + sym + '</span>' +
        '<span class="cc-chg">' + sign + chg.toFixed(2) + '%</span></div>' +
        '<div class="cc-price">$' + fmtPx(d.last) + '</div></a>';
    }

    function agoText(ms) {
      if (ms < 1000) return "刚刚";
      if (ms < 60000) return Math.round(ms / 1000) + "s";
      var m = Math.round(ms / 60000);
      if (m < 60) return m + " 分钟";
      var h = Math.round(m / 60);
      if (h < 24) return h + " 小时";
      return Math.round(h / 24) + " 天";
    }

    // 渲染：只读 MarketDataFeed.snapshot()，不再包含任何取数逻辑
    function render() {
      var snap = window.MarketDataFeed.snapshot() || {};
      if (mainGrid) {
        var h = "";
        for (var i = 0; i < MAINSTREAM.length; i++) h += coinCard(MAINSTREAM[i].sym, MAINSTREAM[i].rank, snap[MAINSTREAM[i].sym]);
        mainGrid.innerHTML = h;
      }
      if (memeGrid) {
        var m = "";
        for (var j = 0; j < MEMES.length; j++) m += coinCard(MEMES[j], "", snap[MEMES[j]]);
        memeGrid.innerHTML = m;
      }
      var stamp = $("liveStamp");
      if (!stamp) return;
      var st = window.MarketDataFeed.status();
      if (!st || st.source === "连接中") { stamp.textContent = "正在连接行情源…"; return; }
      var kindTxt = st.kind === "ws" ? "WebSocket 推送（真·秒级）"
        : st.kind === "rest" ? "REST 轮询兜底"
          : "同源快照兜底";
      var label = "更新于 " + new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
        " · " + st.source + " · " + kindTxt;
      if (st.ageMs != null) label += " · " + agoText(st.ageMs) + "前";
      stamp.textContent = label;
    }

    // 渲染节流：推送密集时合并到下一帧，避免高频重排
    var rafPending = false;
    function scheduleRender() {
      if (rafPending) return;
      rafPending = true;
      var raf = window.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
      raf(function () { rafPending = false; render(); });
    }

    // 取数完全委托给统一数据层：WS 推送 → REST → 同源快照，自动降级与升级回切
    window.MarketDataFeed.init({
      symbols: ALL,
      onTick: function () { scheduleRender(); },
      onStatus: function () { scheduleRender(); }
    });

    // 每秒刷新一次新鲜度标签（即使无新推送，也能反映数据年龄）
    setInterval(render, 1000);
    render();
  }

  // 实时/云端快照模式：优先读取服务器按 12 小时推进生成的状态
  function bootWithLiveState(live) {
    state = live;
    horizon = live.tick || 0;
    activePreset = "live";
    highlightPreset("live");
    $("rangeStart").value = 0;
    $("rangeEnd").value = Math.floor(horizon / TICK_PER_DAY);
    $("activeRangeLabel").textContent = "第 0 – " + Math.floor(horizon / TICK_PER_DAY) + " 天（实时 · 云端快照）";
    renderAllTables();
    initCharts();
  }

  function bootDeterministic() {
    horizon = liveTicks();
    if (horizon < 1) { horizon = PRESETS["60d"]; activePreset = "60d"; }
    highlightPreset(activePreset);
    state = run(horizon);
    $("rangeStart").value = 0;
    $("rangeEnd").value = Math.floor(horizon / TICK_PER_DAY);
    $("activeRangeLabel").textContent = "第 0 – " + Math.floor(horizon / TICK_PER_DAY) + " 天（离线确定性回测 · 云端快照不可达）";
    renderAllTables();
    initCharts();
  }

  function setupDashboardRuntime() {
    ENGINE.attachProfiles(PROFILES);
    bindEvents();
    initLiveTicker();
    applyLive(false);
  }

  window.setupDashboardRuntime = setupDashboardRuntime;
  window.chartFactories = chartFactories;
  window.openManager = openManager;
  window.showSource = showSource;
})();