/*
 * 道场看板构建脚本
 * 用法: node build.js
 * 产出: /workspace/daochang/index.html（自包含，内联 echarts/profiles/engine/app）
 *       /workspace/daochang/dashboard_data.json（可复现 payload，供调试与自动化）
 */
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const SKILL = "/data/user/skills/dashboard-page";

function read(p) { return fs.readFileSync(p, "utf8"); }

const profilesSrc = read(path.join(DIR, "profiles.js"));
const engineSrc = read(path.join(DIR, "engine.js"));
const appSrc = read(path.join(DIR, "app.js"));
const echartsSrc = read(path.join(SKILL, "assets", "echarts.min.js"));

const CSS = `
:root{
  --ink:#2f3437; --muted:#68707a; --faint:#8b95a3; --line:#e1e5ea; --line-strong:#cbd3dc;
  --page:#ffffff; --panel:#FAFAFA; --soft:#f2f3f5; --soft-blue:#f3f6fb;
  --brand:#6979F8; --accent:#2F6BFF; --accent2:#00BFA6;
  --chart-text:#2f3437; --chart-muted:#68707a; --chart-line:#e1e5ea;
  --chart-primary:#2F6BFF; --chart-secondary:#00BFA6; --chart-tertiary:#FF7A3D; --chart-quaternary:#F45BB3;
  --chart-1:#F45BB3; --chart-2:#2F6BFF; --chart-3:#00BFA6; --chart-4:#FF7A3D; --chart-5:#9BD82E; --chart-6:#7C3AED; --chart-7:#FFD23F;
}
html[data-theme="trae-dark"]{
  --ink:#f5f9fe; --muted:#d1d3db; --faint:#9599a6; --line:#2a2d31; --line-strong:#3a3e44;
  --page:#0c0c0d; --panel:#1a1b1d; --soft:#222427; --soft-blue:#222427;
  --brand:#32f08c; --accent:#28d9ff; --accent2:#32f08c;
  --chart-text:#d1d3db; --chart-muted:#9599a6; --chart-line:#2a2d31;
  --chart-primary:#28d9ff; --chart-secondary:#32f08c; --chart-tertiary:#f6c85f; --chart-quaternary:#ff6b9a;
  --chart-1:#32f08c; --chart-2:#28d9ff; --chart-3:#a78bfa; --chart-4:#f6c85f; --chart-5:#ff6b9a; --chart-6:#6ea8ff; --chart-7:#d1d3db;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;
  color:var(--ink); background:var(--page); font-size:14px; line-height:1.5;
}
.topbar{position:sticky;top:0;z-index:50;background:rgba(255,255,255,0.94);backdrop-filter:blur(8px);
  border-bottom:1px solid var(--line);padding:10px 20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
html[data-theme="trae-dark"] .topbar{background:rgba(12,12,13,0.94)}
.brand{font-size:15px;font-weight:700;display:flex;align-items:center;gap:8px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
.fresh{color:var(--faint);font-size:12px}
.controls{margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.seg{display:flex;border:1px solid var(--line-strong);border-radius:8px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--muted);padding:6px 11px;font-size:12px;cursor:pointer;border-right:1px solid var(--line)}
.seg button:last-child{border-right:0}
.seg button.active{background:var(--soft-blue);color:var(--accent);font-weight:600}
.range-inputs{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted)}
.range-inputs input{width:62px;padding:5px 6px;border:1px solid var(--line-strong);border-radius:6px;background:var(--page);color:var(--ink);font-size:12px}
.active-range{font-size:12px;color:var(--muted);white-space:nowrap}
.icon-btn{border:1px solid var(--line-strong);background:var(--page);color:var(--muted);border-radius:7px;width:30px;height:30px;cursor:pointer;font-size:14px}
.icon-btn:hover{color:var(--accent)}
.live-bar{padding:8px 20px 12px;border-bottom:1px solid var(--line);background:var(--soft)}
.live-bar-head{display:flex;align-items:center;gap:12px;margin-bottom:8px}
.live-bar-tag{font-size:11px;font-weight:700;color:var(--accent);white-space:nowrap;display:flex;align-items:center;gap:5px}
.live-bar-tag .pulse{width:7px;height:7px;border-radius:50%;background:#22c55e;animation:livePulse 1.2s infinite}
@keyframes livePulse{0%,100%{opacity:1}50%{opacity:.3}}
.live-stamp{font-size:11px;color:var(--faint);margin-left:auto;white-space:nowrap}
.live-group{margin-bottom:8px}
.live-group:last-child{margin-bottom:0}
.live-group-title{font-size:11px;color:var(--faint);font-weight:600;margin:0 0 6px}
.live-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.coin-card{border:1px solid var(--line);border-radius:9px;padding:7px 10px;background:var(--page);min-width:0;transition:border-color .15s,transform .15s;text-decoration:none;color:inherit;display:block;cursor:pointer}
.coin-card:hover{border-color:var(--accent);transform:translateY(-1px)}
.coin-card .cc-top{display:flex;align-items:center;gap:6px;font-size:12px}
.coin-card .cc-rank{font-size:10px;font-weight:700;color:var(--faint);min-width:15px;text-align:right}
.coin-card .cc-sym{font-weight:700;color:var(--ink)}
.coin-card .cc-chg{margin-left:auto;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums}
.coin-card.up .cc-chg{color:#16a34a}
.coin-card.down .cc-chg{color:#dc2626}
.coin-card .cc-price{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--ink);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.coin-card .cc-pending{color:var(--faint);font-weight:400}
.filter-chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 20px 10px;margin-top:-2px}
.filter-chips .chip{border:1px solid var(--line);background:var(--page);color:var(--muted);font-size:12px;font-weight:600;padding:4px 12px;border-radius:20px;cursor:pointer;transition:all .15s;font-family:inherit}
.filter-chips .chip:hover{border-color:var(--accent);color:var(--ink)}
.filter-chips .chip.active{background:var(--accent);border-color:var(--accent);color:#fff}
.chip-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:5px;vertical-align:middle}
.nowrap{white-space:nowrap}
.dashboard-shell{max-width:1440px;margin:0 auto;padding:18px 20px 60px}
.section-title{font-size:13px;color:var(--faint);font-weight:600;letter-spacing:.03em;margin:0 0 10px;text-transform:uppercase}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:20px}
.kpi-tile{border:1px solid var(--line);border-radius:12px;padding:14px 14px 12px;background:var(--page);cursor:pointer;transition:box-shadow .15s,border-color .15s;border-top:3px solid var(--c,#2F6BFF)}
.kpi-tile:hover{box-shadow:0 6px 18px rgba(0,0,0,.06);border-color:var(--line-strong)}
.kpi-top{display:flex;justify-content:space-between;align-items:baseline}
.kpi-name{font-weight:700;font-size:14px}
.kpi-arena{font-size:11px;color:var(--faint)}
.kpi-value{font-size:22px;font-weight:700;margin:6px 0 2px}
.kpi-unit{font-size:12px;color:var(--faint);font-weight:400;margin-left:2px}
.kpi-delta{font-size:13px;font-weight:600}
.kpi-delta.up{color:var(--accent2)} .kpi-delta.down{color:var(--chart-quaternary)}
.kpi-meta{font-size:11px;color:var(--faint)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:14px}
.panel{border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--page);min-width:0}
.chart-panel{grid-column:span 6}
.chart-panel.wide{grid-column:span 12}
.table-panel{grid-column:span 6}
.table-panel.wide{grid-column:span 12}
.note-panel{grid-column:span 12}
.panel-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
.panel-title{font-size:13px;font-weight:600}
.panel-sub{font-size:11px;color:var(--faint);margin-top:-6px;margin-bottom:6px}
.panel-menu{position:relative;display:flex;align-items:center;gap:6px}
.menu-btn{border:0;background:transparent;color:var(--faint);cursor:pointer;font-size:16px;padding:2px 6px}
.menu-btn:hover{color:var(--accent)}
.chart{width:100%;height:300px}
.chart.wide{height:340px}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--faint);font-weight:600;background:var(--panel)}
td.rat{max-width:300px;white-space:normal;color:var(--muted)}
.hl-red{color:#e03a3a;font-weight:700}
.hl-red-bg{color:#e03a3a;font-weight:700;background:rgba(224,58,58,.10)}
.hl-green{color:#0fa968;font-weight:700}
.hl-green-bg{color:#0fa968;font-weight:700;background:rgba(15,169,104,.10)}
.hl-yellow{color:#856404;font-weight:600;background:rgba(255,243,205,.12)}
.tag{display:inline-block;font-size:10px;padding:1px 6px;border-radius:6px;font-weight:700}
.tag-red{background:rgba(224,58,58,.14);color:#e03a3a}
.tag-green{background:rgba(15,169,104,.14);color:#0fa968}
.empty{color:var(--faint);text-align:center;padding:18px}
.collapse-row td{text-align:center;padding:8px;border-bottom:0}
.collapse-btn{border:1px solid var(--line-strong);background:var(--page);color:var(--accent);border-radius:16px;padding:4px 18px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
.collapse-btn:hover{background:var(--soft-blue)}
.type-select{font-size:12px;padding:4px 6px;border:1px solid var(--line-strong);border-radius:6px;background:var(--page);color:var(--ink);display:none}
ul.rules{margin:6px 0;padding-left:20px}
ul.rules li{margin:4px 0}
/* Drawer */
.drawer-mask{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:100;opacity:0;pointer-events:none;transition:opacity .2s}
.drawer-mask.open{opacity:1;pointer-events:auto}
.drawer{position:fixed;top:0;right:0;height:100%;width:min(620px,92vw);background:var(--page);z-index:101;transform:translateX(100%);transition:transform .25s;box-shadow:-8px 0 30px rgba(0,0,0,.12);overflow-y:auto}
.drawer-mask.open .drawer{transform:translateX(0)}
.drawer-inner{padding:22px}
.drawer-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;border-bottom:1px solid var(--line);padding-bottom:12px;margin-bottom:14px}
.drawer h3{margin:0}
.drawer .style{color:var(--muted);font-size:13px;margin-top:4px}
.drawer .thesis{color:var(--accent);font-size:13px;margin-top:6px}
.drawer h4{font-size:13px;margin:18px 0 8px;color:var(--faint);letter-spacing:.02em}
.logic-item{border-left:2px solid var(--line);padding:6px 10px;margin:8px 0;font-size:13px}
.drawer ul{margin:0;padding-left:18px}
.drawer li{margin:4px 0;font-size:13px}
/* Modal */
.modal-backdrop{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:200;display:none;align-items:center;justify-content:center}
.modal-backdrop.open{display:flex}
.modal{width:min(720px,92vw);max-height:84vh;overflow-y:auto;background:var(--page);border-radius:14px;padding:20px;box-shadow:0 10px 40px rgba(0,0,0,.2)}
.modal-head{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:10px}
.modal-head h3{margin:0;font-size:15px}
.modal-sub{font-size:12px;color:var(--faint);margin-top:2px}
.code-wrap{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin:10px 0;font-size:12px}
.code-wrap pre{margin:0;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--muted)}
.copy-btn{position:absolute;top:8px;right:8px;border:1px solid var(--line-strong);background:var(--page);color:var(--faint);border-radius:6px;font-size:11px;padding:3px 8px;cursor:pointer}
.copy-btn:hover{color:var(--accent)}
.section-label{font-size:12px;font-weight:600;color:var(--faint);margin:12px 0 4px}
/* AI 对话 */
.ai-chat{display:flex;flex-direction:column;gap:8px}
.ai-chat-log{min-height:60px;max-height:340px;overflow-y:auto;padding:4px 2px;display:flex;flex-direction:column;gap:8px}
.ai-msg{border:1px solid var(--line);border-radius:10px;padding:8px 10px;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:var(--panel)}
.ai-msg.user{border-left:3px solid var(--accent);background:var(--soft-blue)}
.ai-msg.assistant{border-left:3px solid var(--accent2)}
.ai-msg.sys{border-left:3px solid var(--faint);color:var(--faint);font-size:11px}
.ai-chat-input{display:flex;gap:8px}
.ai-chat-input input{flex:1;padding:8px 10px;border:1px solid var(--line-strong);border-radius:8px;background:var(--page);color:var(--ink);font-size:13px}
.ai-chat-input button{border:1px solid var(--line-strong);background:var(--accent);color:#fff;border-radius:8px;padding:8px 16px;font-size:13px;cursor:pointer;font-weight:600}
.ai-chat-input button:disabled{opacity:.5;cursor:not-allowed}
@media (max-width:820px){
  .chart-panel,.table-panel,.chart-panel.wide,.table-panel.wide,.note-panel{grid-column:span 12}
  .dashboard-shell{padding:12px 10px 40px}
  .topbar{padding:8px 10px;gap:8px}
  .controls{margin-left:0;width:100%}
  .chart{height:240px}
}
/* 排行榜 */
.ranking-panel{margin-top:16px;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.ranking-title{font-size:14px;font-weight:700;color:var(--ink);margin-bottom:10px;display:flex;align-items:center;gap:6px}
.ranking-list{display:flex;flex-direction:column;gap:8px}
.ranking-item{display:flex;align-items:center;gap:12px;padding:8px 12px;background:var(--page);border:1px solid var(--line);border-radius:8px;transition:all .2s}
.ranking-item:hover{border-color:var(--accent);box-shadow:0 2px 8px rgba(47,107,255,.1)}
.ranking-rank{font-size:18px;font-weight:700;width:32px;text-align:center}
.ranking-rank.gold{color:#FFD700}
.ranking-rank.silver{color:#C0C0C0}
.ranking-rank.bronze{color:#CD7F32}
.ranking-info{flex:1;display:flex;flex-direction:column;gap:2px}
.ranking-name{font-size:13px;font-weight:600;color:var(--ink)}
.ranking-stats{font-size:11px;color:var(--muted);display:flex;gap:12px}
.ranking-equity{font-size:15px;font-weight:700;color:var(--accent)}
.ranking-pnl{font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
.ranking-pnl.up{background:#d4edda;color:#155724}
.ranking-pnl.down{background:#f8d7da;color:#721c24}
`;

const SHELL = `<!-- Generated by Trae Work -->
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta http-equiv="refresh" content="600">
<title>AI主理 · 实盘道场 / 期权演武场 看板</title>
<style>
${CSS}
</style>
</head>
<body>
<div class="topbar">
  <div class="brand"><span class="dot"></span>AI主理 · 实盘道场 / 期权演武场</div>
  <div class="fresh" id="dataFreshness">加载中…</div>
  <div class="controls">
    <div class="seg" id="presetSeg">
      <button data-range-preset="live">实时</button>
      <button data-range-preset="7d">7D</button>
      <button data-range-preset="30d">30D</button>
      <button data-range-preset="60d">60D</button>
      <button data-range-preset="90d">90D</button>
      <button data-range-preset="all">全部</button>
    </div>
    <div class="range-inputs">
      <input id="rangeStart" type="number" min="0" value="0" title="起始天" />
      <span>—</span>
      <input id="rangeEnd" type="number" min="0" value="60" title="结束天" />
    </div>
    <span class="active-range" id="activeRangeLabel">第 0 – 0 天</span>
    <button class="icon-btn" id="refreshBtn" title="刷新数据（拉取最新快照）">↻</button>
    <button class="icon-btn" id="themeBtn" title="切换主题">◐</button>
  </div>
</div>

<div class="live-bar">
  <div class="live-bar-head">
    <span class="live-bar-tag"><span class="pulse"></span>实时行情 · 秒级 · 点击卡片直达 Gate.io 交易（国内可访问）</span>
    <span class="live-stamp" id="liveStamp">连接中…</span>
  </div>
  <div class="live-group">
    <div class="live-group-title">主流币 · TOP 10（市值排名，剔除稳定币）</div>
    <div class="live-grid" id="liveMainGrid"></div>
  </div>
  <div class="live-group">
    <div class="live-group-title">Meme币 · 主理人严选（主流靠谱 · 已剔除高风险割韭菜币）</div>
    <div class="live-grid" id="liveMemeGrid"></div>
  </div>
</div>

<main class="dashboard-shell">
  <section aria-label="主理人KPI">
    <p class="section-title">主理人总览 · 起始资金 1000U</p>
    <div class="kpi-grid" id="kpiGrid">
      <section class="kpi-tile"><div class="kpi-name">加载中…</div></section>
    </div>
    <div class="ranking-panel" id="rankingPanel">
      <div class="ranking-title">🏆 实时排行榜 · 六大主理PK</div>
      <div class="ranking-list" id="rankingList"></div>
    </div>
  </section>

  <section aria-label="图表">
    <div class="grid">
      <section class="dashboard-panel chart-panel wide" data-chart="chartEquity">
        <div class="panel-head">
          <div><div class="panel-title">主理人权益曲线</div><div class="panel-sub">单位 U · 每位主理人 1000U 起步</div></div>
          <div class="panel-menu"><button class="menu-btn" data-source title="查看数据来源">⋮</button><button class="menu-btn" onclick="toggleEdit(this,'chartEquity')" title="编辑图表">✎</button><select class="type-select" onchange="switchType('chartEquity',this.value)"><option value="line">折线</option></select></div>
        </div>
        <div class="chart wide" id="chartEquity"></div>
      </section>

      <section class="dashboard-panel chart-panel wide" data-chart="chartDrawdown">
        <div class="panel-head">
          <div><div class="panel-title">回撤曲线</div><div class="panel-sub">单位 % · 峰值回撤</div></div>
          <div class="panel-menu"><button class="menu-btn" data-source title="查看数据来源">⋮</button><button class="menu-btn" onclick="toggleEdit(this,'chartDrawdown')" title="编辑图表">✎</button><select class="type-select" onchange="switchType('chartDrawdown',this.value)"><option value="line">折线</option></select></div>
        </div>
        <div class="chart wide" id="chartDrawdown"></div>
      </section>

      <section class="dashboard-panel chart-panel wide" data-chart="chartMarket">
        <div class="panel-head">
          <div><div class="panel-title">市场走势</div><div class="panel-sub">主流币(BTC/ETH/SOL/BNB/DOGE) + Meme币(PEPE/SHIB/WIF/BONK/FLOKI/MEME) 全部锚定 Binance 实时</div></div>
          <div class="panel-menu"><button class="menu-btn" data-source title="查看数据来源">⋮</button><button class="menu-btn" onclick="toggleEdit(this,'chartMarket')" title="编辑图表">✎</button><select class="type-select" onchange="switchType('chartMarket',this.value)"><option value="line">折线</option></select></div>
        </div>
        <div class="chart wide" id="chartMarket"></div>
      </section>

      <section class="dashboard-panel table-panel wide">
        <div class="panel-head">
          <div><div class="panel-title">操作决策日志</div><div class="panel-sub">新到旧排序 · 超 10 条折叠可展开 · 全部视图最近 120 条（含铁律拦截）· 显示开仓价 / 平仓价</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('操作决策日志','对 state.managers[*].decisions 聚合：tick→天, type, coin, side, detail, price, entry, rationale。','每开/平仓与铁律拦截都会写入该主理人的 decisions 数组；可切换单个主理人聚焦其完整操作路径。')" title="查看数据来源">⋮</button></div>
        </div>
        <div class="filter-chips" id="decisionFilter"></div>
        <div class="table-wrap"><table><thead><tr><th id="decisionThMgr">主理人</th><th>时间</th><th>动作</th><th>标的</th><th>方向</th><th>开仓价</th><th>平仓价</th><th>明细</th><th>决策逻辑</th></tr></thead><tbody id="decisionBody"></tbody></table></div>
      </section>

      <section class="dashboard-panel table-panel wide">
        <div class="panel-head">
          <div><div class="panel-title">每日复盘</div><div class="panel-sub">每位主理人每交易日结算 · 新到旧排序 · 超 10 条折叠可展开 · 数据驱动复盘：权益 / 盈亏 / 胜率 / 沉淀教训 + 下一步进化动作</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('每日复盘','对 state.managers[*].dailyReview 聚合：day, equity, pnl, pnlPct, trades, wins, losses, winRate, bestPnl, worstPnl, lesson, action。','每个交易日(24 tick)结束由 rollDailyReview() 结算：对比日末权益与日初权益得当日盈亏，统计当日平仓胜/负与胜率，并按实际表现生成数据驱动的教训(lesson)与下一步进化动作(action)，供后续沉淀到策略参数。')" title="查看数据来源">⋮</button></div>
        </div>
        <div class="filter-chips" id="dailyFilter"></div>
        <div class="table-wrap"><table><thead><tr><th id="dailyThMgr">主理人</th><th>天</th><th>权益(U)</th><th>当日盈亏</th><th>交易/胜率</th><th>复盘沉淀</th></tr></thead><tbody id="dailyReviewBody"></tbody></table></div>
      </section>

      <section class="dashboard-panel table-panel">
        <div class="panel-head">
          <div><div class="panel-title">自我纠错沉淀</div><div class="panel-sub">亏损复盘 / 周期复盘 · 新到旧排序 · 超 10 条折叠可展开</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('自我纠错沉淀','对 state.managers[*].evolution 聚合：trigger, lesson, delta。','亏损平仓与周期性复盘触发 evolve()，把体系 selfCorrection 沉淀为进化条目。')" title="查看数据来源">⋮</button></div>
        </div>
        <div class="filter-chips" id="evolutionFilter"></div>
        <div class="table-wrap"><table><thead><tr><th id="evolutionThMgr">主理人</th><th>时间</th><th>触发</th><th>沉淀教训</th></tr></thead><tbody id="evolutionBody"></tbody></table></div>
      </section>

      <section class="dashboard-panel table-panel">
        <div class="panel-head">
          <div><div class="panel-title">当前持仓</div><div class="panel-sub">现货 / 合约 / 价差期权 · 新到旧排序 · 超 10 条折叠可展开</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('当前持仓','对 state.managers[*].positions 聚合。','持仓为未平仓位；期权为 defined-risk 价差（铁律：不裸卖）。')" title="查看数据来源">⋮</button></div>
        </div>
        <div class="filter-chips" id="positionFilter"></div>
        <div class="table-wrap"><table><thead><tr><th id="positionThMgr">主理人</th><th>标的</th><th>类型</th><th>方向</th><th>数量</th><th>开仓价</th></tr></thead><tbody id="positionBody"></tbody></table></div>
      </section>

      <section class="dashboard-panel note-panel">
        <div class="panel-head">
          <div><div class="panel-title">期权演武场 · 规则铁律（洪七公）</div><div class="panel-sub">数字投行洪七公 AI 主理 · 只做 BTC / ETH / SOL</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('规则铁律','读取 PROFILES.IRON_RULES_OPTIONS（期权演武场铁律）。','铁律：只做 BTC/ETH/SOL、杜绝一期山寨币、极端只做 BTC、卖方必对冲、满仓卖权/裸买一票否决。')" title="查看数据来源">⋮</button></div>
        </div>
        <ul class="rules" id="ironRulesBox"></ul>
      </section>

      <section class="dashboard-panel note-panel" id="aiChatPanel">
        <div class="panel-head">
          <div><div class="panel-title">AI 对话</div><div class="panel-sub">agnès 模型 · 优先 3.0-flash，不通自动回退 2.5-flash → DeepSeek V4 flash · 可结合当前模拟盘上下文</div></div>
          <div class="panel-menu"><button class="menu-btn" onclick="showSource('AI 对话','前端调 OpenAI Chat Completions：优先 POST https://api.agnes-ai.cn/v1/chat/completions（model=agnes-3.0-flash），失败自动切 agnes-2.5-flash，再失败切 DeepSeek V4 flash（https://api.deepseek.com/v1，需配置 DeepSeek API Key）。','系统提示注入当前 6 位主理人权益/回撤/持仓等实时快照，使 AI 能就模拟盘表现给出解读与建议；对话为多轮上下文。')" title="查看数据来源">⋮</button><button class="icon-btn" id="aiChatClear" title="清空对话">↺</button></div>
        </div>
        <div class="ai-chat">
          <div class="ai-chat-log" id="aiChatLog"></div>
          <div class="ai-chat-input">
            <input id="aiChatInput" type="text" placeholder="例如：洪七公这轮回撤大，帮我分析原因并给出期权策略建议…" autocomplete="off" />
            <button id="aiChatSend" type="button">发送</button>
          </div>
        </div>
      </section>
    </div>
  </section>
</main>

<div class="drawer-mask" id="mgDrawer">
  <div class="drawer">
    <div class="drawer-inner">
      <div class="drawer-head">
        <div><h3 id="mgDetailName"></h3><div class="style" id="mgDetailStyle"></div><div class="thesis" id="mgDetailThesis"></div></div>
        <button class="icon-btn" id="mgClose" title="关闭">✕</button>
      </div>
      <h4>核心体系</h4><div id="mgDetailSystem" style="font-size:13px"></div>
      <h4>核心逻辑</h4><div id="mgDetailLogic"></div>
      <h4>规则铁律</h4><ul id="mgDetailIron"></ul>
      <h4>体系课程</h4><div id="mgDetailCourse"></div>
      <h4>金句</h4><ul id="mgDetailQuotes"></ul>
    </div>
    <div style="height:40px"></div>
  </div>
</div>

<div class="modal-backdrop" id="modalBackdrop">
  <div class="modal">
    <div class="modal-head">
      <div><h3 id="modalTitle">数据来源</h3><div class="modal-sub">本面板的数据加工与分析逻辑</div></div>
      <button class="icon-btn" id="modalClose">✕</button>
    </div>
    <div class="section-label">Panel transform</div>
    <div class="code-wrap"><button class="copy-btn" id="copySnippet">复制</button><pre id="modalSnippet"></pre></div>
    <div class="section-label">Analysis logic</div>
    <div class="code-wrap"><button class="copy-btn" id="copyLogic">复制</button><pre id="modalLogic"></pre></div>
  </div>
</div>

<script>
/* profiles（蒸馏体系库） */
${profilesSrc}
/* engine（模拟盘引擎） */
${engineSrc}
/* echarts（图表运行时） */
${echartsSrc}
/* app（看板运行时） */
${appSrc}
/* 启动看板运行时 */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", function () { setupDashboardRuntime(); });
} else {
  setupDashboardRuntime();
}
</script>
</body>
</html>
`;

const indexHtml = SHELL;
fs.writeFileSync(path.join(DIR, "index.html"), indexHtml, "utf8");

// ---------- 生成 dashboard_data.json（可复现 payload） ----------
const PROFILES = require(path.join(DIR, "profiles.js"));
const ENGINE = require(path.join(DIR, "engine.js"));
ENGINE.attachProfiles(PROFILES);
const SEED = 20260913;
const HORIZON = 1440; // 60 天
let st = ENGINE.initState(SEED, PROFILES.START_EQUITY || 1000);
for (const p of PROFILES.KOLS) st.managers[p.id] = ENGINE.initManager(p.id, PROFILES.START_EQUITY || 1000);
st = ENGINE.advance(st, HORIZON);

const payload = {
  generated_at: new Date().toISOString(),
  launch_ts: "2026-09-13T00:00:00+08:00",
  timezone: "Asia/Shanghai",
  seed: SEED,
  startEquity: PROFILES.START_EQUITY || 1000,
  tick: st.tick,
  horizonDays: HORIZON / 24,
  managers: ENGINE.summary(st).map(function (r) {
    const p = PROFILES.byId(r.id); const m = st.managers[r.id];
    return {
      id: r.id, name: r.name, arena: r.arena, color: r.color, style: p.style, thesis: p.thesis,
      coreSystem: p.coreSystem, ironRules: p.ironRules, course: p.course,
      equity: r.equity, cash: r.cash, pnl: r.pnl, pnlPct: r.pnlPct, realized: r.realized,
      trades: r.trades, wins: r.wins, losses: r.losses, winRate: r.winRate, maxDrawdown: r.maxDrawdown, open: r.open,
      decisionsCount: m.decisions.length, evolutionCount: m.evolution.length
    };
  }),
  ironRulesOptions: PROFILES.IRON_RULES_OPTIONS
};
fs.writeFileSync(path.join(DIR, "dashboard_data.json"), JSON.stringify(payload, null, 2), "utf8");

console.log("Generated index.html (" + (indexHtml.length / 1024).toFixed(0) + " KB) and dashboard_data.json");
console.log("60天推演:", payload.managers.map(function (m) { return m.name + "=" + (m.pnlPct * 100).toFixed(1) + "%"; }).join("  "));