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
  var LAUNCH_TS = new Date("2026-09-13T00:00:00+08:00").getTime();
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
      html += '<section class="kpi-tile" data-id="' + r.id + '" style="--c:' + r.color + '">' +
        '<div class="kpi-top"><span class="kpi-name">' + r.name + '</span><span class="kpi-arena">' + r.arena + '</span></div>' +
        '<div class="kpi-value' + (isMajor && r.pnl < 0 ? " hl-red" : (isMajor && r.pnl >= 0 ? " hl-green" : "")) + '">' + r2(r.equity) + '<span class="kpi-unit">U</span></div>' +
        '<div class="kpi-delta ' + cls + '">' + arrow + " " + pct(r.pnlPct) + '</div>' +
        badge +
        '<div class="kpi-meta">交易 ' + r.trades + " · 胜率 " + pct(r.winRate) + '</div>' +
        '<div class="kpi-meta">回撤 -' + pct(r.maxDrawdown) + " · 持仓 " + r.open + '</div>' +
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
      html += '<div class="ranking-item">' +
        '<div class="ranking-rank ' + rankClass + '">' + rankIcon + '</div>' +
        '<div class="ranking-info">' +
          '<div class="ranking-name" style="color:' + r.color + '">' + r.name + ' <span style="color:var(--muted);font-weight:400;font-size:11px">' + r.arena + '</span></div>' +
          '<div class="ranking-stats">' +
            '<span>交易 ' + r.trades + '</span>' +
            '<span>胜率 ' + pct(r.winRate) + '</span>' +
            '<span>回撤 -' + pct(r.maxDrawdown) + '</span>' +
            '<span>持仓 ' + r.open + '</span>' +
            '<span>进化 ' + r.evolution + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="ranking-equity">' + r2(r.equity) + 'U</div>' +
        '<div class="ranking-pnl ' + pnlClass + '">' + pnlSign + pct(r.pnlPct) + '</div>' +
        '</div>';
    }
    el.innerHTML = html;
  }

  // ---------- 表格 ----------
  function renderDecisions() {
    var rows = [];
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i]; var m = state.managers[p.id];
      for (var j = m.decisions.length - 1; j >= 0; j--) {
        var d = m.decisions[j];
        rows.push({ name: p.name, color: p.color, day: day(d.tick), type: d.type, coin: d.coin || "", side: d.side || "", detail: d.detail || "", rationale: d.rationale || "" });
        if (rows.length >= 120) break;
      }
      if (rows.length >= 120) break;
    }
    rows.sort(function (a, b) { return parseFloat(b.day) - parseFloat(a.day); });
    var html = "";
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var isBlock = r.type === "iron_block";
      var typeLabel = r.type === "open" ? "开仓" : (r.type === "close" ? "平仓" : (r.type === "1_3_watch" ? "1+3观望" : (isBlock ? "铁律拦截" : r.type)));
      var typeCls = isBlock ? ' class="hl-red-bg"' : (r.type === "1_3_watch" ? ' class="hl-yellow"' : "");
      var typeTag = isBlock ? '<span class="tag tag-red">重要</span> ' : (r.type === "1_3_watch" ? '<span class="tag" style="background:#fff3cd;color:#856404">观望</span> ' : "");
      html += '<tr><td style="color:' + r.color + '">' + r.name + '</td><td>' + r.day + '</td><td' + typeCls + '>' + typeTag + typeLabel + '</td><td>' + r.coin +
        '</td><td>' + r.side + '</td><td>' + r.detail + '</td><td class="rat">' + r.rationale + '</td></tr>';
    }
    $("decisionBody").innerHTML = html || '<tr><td colspan="7" class="empty">当前窗口无决策记录</td></tr>';
  }

  function renderEvolution() {
    var rows = [];
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i]; var m = state.managers[p.id];
      for (var j = m.evolution.length - 1; j >= 0; j--) {
        var e = m.evolution[j];
        rows.push({ name: p.name, color: p.color, day: day(e.tick), trigger: e.trigger, lesson: e.lesson, delta: e.delta });
        if (rows.length >= 60) break;
      }
      if (rows.length >= 60) break;
    }
    var html = "";
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      html += '<tr><td style="color:' + r.color + '">' + r.name + '</td><td>' + r.day + '</td><td>' + r.trigger + '</td><td class="rat">' + r.lesson + '</td></tr>';
    }
    $("evolutionBody").innerHTML = html || '<tr><td colspan="4" class="empty">暂无进化沉淀</td></tr>';
  }

  function renderDailyReview() {
    var rows = [];
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i]; var m = state.managers[p.id];
      var rev = m.dailyReview || [];
      for (var j = rev.length - 1; j >= 0; j--) {
        var r = rev[j];
        rows.push({ name: p.name, color: p.color, day: r.day + 1, equity: r2(r.equity), pnl: r2(r.pnl), pnlPct: r.pnlPct, trades: r.trades, wins: r.wins, losses: r.losses, lesson: r.lesson });
        if (rows.length >= 80) break;
      }
      if (rows.length >= 80) break;
    }
    rows.sort(function (a, b) { return b.day - a.day; });
    var html = "";
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      var up = r.pnl >= 0;
      var isMajor = Math.abs(r.pnlPct) >= 0.05;
      var pnlCls = up ? (isMajor ? "hl-green-bg" : "hl-green") : "hl-red-bg";
      var equityCls = isMajor && !up ? "hl-red" : "";
      html += '<tr><td style="color:' + r.color + '">' + r.name + '</td><td>第' + r.day + '天</td>' +
        '<td class="' + equityCls + '">' + r.equity + '</td>' +
        '<td class="' + pnlCls + '">' + (up ? '+' : '') + r.pnl + ' (' + (up ? '+' : '') + pct(r.pnlPct) + ')</td>' +
        '<td>' + r.trades + '笔/' + r.wins + '胜/' + r.losses + '负</td><td class="rat">' + r.lesson + '</td></tr>';
    }
    $("dailyReviewBody").innerHTML = html || '<tr><td colspan="6" class="empty">暂无每日复盘（首个完整交易日后自动生成）</td></tr>';
  }

  function renderPositions() {
    var rows = [];
    for (var i = 0; i < PROFILES.KOLS.length; i++) {
      var p = PROFILES.KOLS[i]; var m = state.managers[p.id];
      for (var j = 0; j < m.positions.length; j++) {
        var pos = m.positions[j];
        var kind = pos.kind === "spot" ? "现货" : (pos.kind === "perp" ? "合约" : (pos.otype === "call" ? "看涨(" + pos.side + ")" : "看跌(" + pos.side + ")"));
        rows.push({ name: p.name, color: p.color, coin: pos.coin, kind: kind, side: pos.side, entry: r2(pos.entry), qty: pos.qty ? r2(pos.qty) : (pos.contracts || "-") });
      }
    }
    var html = "";
    for (var k = 0; k < rows.length; k++) {
      var r = rows[k];
      html += '<tr><td style="color:' + r.color + '">' + r.name + '</td><td>' + r.coin + '</td><td>' + r.kind + '</td><td>' + r.side + '</td><td>' + r.qty + '</td></tr>';
    }
    $("positionBody").innerHTML = html || '<tr><td colspan="5" class="empty">当前无持仓</td></tr>';
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
    if (key === "live") horizon = liveTicks();
    else horizon = PRESETS[key];
    $("rangeStart").value = 0;
    $("rangeEnd").value = Math.floor(horizon / TICK_PER_DAY);
    apply();
  }
  function apply() {
    state = run(horizon);
    var s = Math.floor(horizon / TICK_PER_DAY);
    $("activeRangeLabel").textContent = "第 0 – " + s + " 天" + (activePreset === "live" ? "（实时）" : "（推演预览）");
    renderKpi(); renderRanking(); renderDecisions(); renderEvolution(); renderPositions(); renderDailyReview();
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

  // ---------- 刷新数据 ----------
  function refreshData() {
    var btn = $("refreshBtn");
    if (btn) { btn.disabled = true; btn.textContent = "⟳"; btn.style.opacity = 0.5; }
    // 强制绕过缓存拉最新快照
    fetch("data/latest.json?v=" + Date.now(), { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (live) {
        if (live && live.managers && typeof live.tick === "number" && live.market) {
          bootWithLiveState(live);
          if (btn) { btn.textContent = "✓"; setTimeout(function () { btn.textContent = "↻"; btn.disabled = false; btn.style.opacity = 1; }, 1500); }
        } else {
          // 回退确定性推演
          bootDeterministic();
          if (btn) { btn.textContent = "✗"; setTimeout(function () { btn.textContent = "↻"; btn.disabled = false; btn.style.opacity = 1; }, 1500); }
        }
      });
  }

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
    $("activeRangeLabel").textContent = "第 0 – " + Math.floor(horizon / TICK_PER_DAY) + " 天" + (activePreset === "live" ? "（实时）" : "（推演预览）");
    renderAllTables();
    initCharts();
  }

  function setupDashboardRuntime() {
    ENGINE.attachProfiles(PROFILES);
    bindEvents();
    // 优先加载云端快照（服务端 data/latest.json），失败则回退确定性推演
    fetch("data/latest.json", { cache: "no-store" })
      .then(function (res) { return res.ok ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (live) {
        if (live && live.managers && typeof live.tick === "number" && live.market) bootWithLiveState(live);
        else bootDeterministic();
      });
  }

  window.setupDashboardRuntime = setupDashboardRuntime;
  window.chartFactories = chartFactories;
  window.openManager = openManager;
  window.showSource = showSource;
})();