/*
 * 道场模拟盘引擎（浏览器 + Node 共用，UMD）
 * - 确定性多币市场模型（seed 可复现）
 * - 6 位 AI 主理人策略（由 KOL 交易体系蒸馏得来）
 * - 量化预判评分体系（趋势方向/强度/四阶段/全维度）+ 1+3形态检测
 * - 决策逻辑 + 自我纠错沉淀
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ENGINE = factory();
})(typeof self !== "undefined" ? self : this, function () {

  // ---------- 基础工具 ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gauss(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function r2(x) { return Math.round(x * 100) / 100; }

  // ---------- 市场模型 ----------
  var COIN_DEF = {
    "BTC": { base: 77284, vol: 0.010, drift: 0.00025, isMeme: false },
    "ETH": { base: 2520, vol: 0.014, drift: 0.00018, isMeme: false },
    "SOL": { base: 102, vol: 0.020, drift: 0.00020, isMeme: false },
    "BNB": { base: 610, vol: 0.016, drift: 0.00015, isMeme: false },
    "DOGE": { base: 0.18, vol: 0.024, drift: 0.00008, isMeme: true },
    "PEPE": { base: 0.000012, vol: 0.032, drift: 0.00004, isMeme: true },
    "SHIB": { base: 0.000025, vol: 0.035, drift: 0.00004, isMeme: true },
    "WIF": { base: 2.5, vol: 0.050, drift: 0.00005, isMeme: true },
    "BONK": { base: 0.000028, vol: 0.040, drift: 0.00004, isMeme: true },
    "FLOKI": { base: 0.00018, vol: 0.038, drift: 0.00004, isMeme: true },
    "MEME": { base: 0.015, vol: 0.042, drift: 0.00004, isMeme: true }
  };
  var REAL_COINS = ["BTC", "ETH", "SOL", "BNB", "DOGE", "PEPE", "SHIB", "WIF", "BONK", "FLOKI", "MEME"]; // 所有主理涉及的币种均锚定真实行情

  function initMarket(seed) {
    var rng = mulberry32(seed);
    var coins = {};
    for (var s in COIN_DEF) {
      var d = COIN_DEF[s];
      var hist = [];
      var p = d.base;
      for (var i = 0; i < 30; i++) { p *= Math.exp(d.drift + d.vol * gauss(rng) * 0.6); hist.push(p); }
      coins[s] = {
        sym: s, price: p, hist: hist, drift: d.drift, vol: d.vol, base: d.base,
        isMeme: d.isMeme, heat: 40 + rng() * 30, smartMoney: 0, rug: 0, regime: 0,
        sma5: p, sma20: p, rsi: 50, atr: d.vol * p, iv: 50, volSpike: 1
      };
    }
    return coins;
  }

  function stepMarket(coins, rng, realPrices) {
    for (var s in coins) {
      var c = coins[s];
      var realPrice = (realPrices && realPrices[s] && REAL_COINS.indexOf(s) >= 0) ? realPrices[s] : null;
      var ret;
      if (realPrice) {
        // ===== 锚定真实行情 =====
        var prev = c.price || c.base;
        ret = Math.log(realPrice / prev);
        c.price = realPrice;
        // 从 SMA 交叉推断趋势状态（给策略用）
        if (c.sma5 > c.sma20 * 1.002) c.regime = 1;
        else if (c.sma5 < c.sma20 * 0.998) c.regime = -1;
        else c.regime = 0;
        c.drift = clamp(ret * 0.3 + c.drift * 0.5, -0.008, 0.008);
      } else {
        // ===== 合成行情（原逻辑） =====
        var shock = (rng() < 0.008) ? (rng() < 0.5 ? -1 : 1) * (0.03 + rng() * 0.05) : 0;
        c.drift = c.drift * 0.985 + (rng() < 0.04 ? (rng() < 0.5 ? -1 : 1) * 0.0006 : 0);
        if (rng() < 0.01) { if (c.regime === 1) c.regime = -1; else c.regime = (rng() < 0.5 ? 1 : -1); c.regime = c.regime || 0; }
        else if (rng() < 0.006) c.regime = 0;
        var trendDrift = (c.regime || 0) * 0.0005;
        var sigma = c.vol * (0.6 + rng() * 0.9);
        ret = c.drift + trendDrift + sigma * gauss(rng) + shock;
        c.price = Math.max(c.base * 0.05, c.price * Math.exp(ret));
      }
      // ===== 公共指标更新（真实 & 合成共用） =====
      c.hist.push(c.price);
      if (c.hist.length > 30) c.hist.shift();
      var arr = c.hist, n = arr.length;
      var sum5 = 0, sum20 = 0;
      for (var i = 0; i < n; i++) { sum20 += arr[i]; if (i >= n - 5) sum5 += arr[i]; }
      c.sma5 = sum5 / 5;
      c.sma20 = sum20 / n;
      var up = 0, dn = 0;
      for (var i2 = 1; i2 < n; i2++) { var ch = arr[i2] - arr[i2 - 1]; if (ch >= 0) up += ch; else dn -= ch; }
      c.rsi = up + dn === 0 ? 50 : 100 * up / (up + dn);
      var sumA = 0; for (var i3 = 1; i3 < n; i3++) sumA += Math.abs(arr[i3] - arr[i3 - 1]);
      c.atr = (sumA / (n - 1)) || c.vol * c.price;
      c.iv = clamp(30 + Math.abs(ret) / c.vol * 14 + rng() * 6, 25, 130);
      c.volSpike = clamp(Math.abs(ret) / c.vol, 0.3, 3);
      if (c.isMeme) {
        c.heat = clamp(c.heat + (rng() - 0.5) * 8 + (ret > 0 ? 2 : -1), 10, 95);
        c.smartMoney = clamp(c.smartMoney + (rng() - 0.48) * 3, 3, 40);
        if (c.heat > 60 && rng() < 0.55) c.price *= Math.exp(0.0004 + rng() * 0.0005);
        c.drift = clamp(c.drift, -0.006, 0.006);
        c.rug = clamp(
          (c.volSpike > 2 ? 1.2 : 0) +
          (c.rsi > 80 ? 1 : 0) +
          (c.heat > 85 ? 0.8 : 0) +
          (c.smartMoney < 10 ? 1 : 0) +
          (rng() - 0.5) * 1.5, 0, 5);
      }
    }
  }

  // ---------- 期权定价（Black-Scholes） ----------
  function ncdf(x) {
    var t = 1 / (1 + 0.2316419 * Math.abs(x));
    var d = 0.3989423 * Math.exp(-x * x / 2);
    var prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - prob : prob;
  }
  function bsPrice(S, K, T, r, sig, isCall) {
    if (T <= 0) return Math.max(0, (isCall ? S - K : K - S));
    var d1 = (Math.log(S / K) + (r + 0.5 * sig * sig) * T) / (sig * Math.sqrt(T));
    var d2 = d1 - sig * Math.sqrt(T);
    if (isCall) return S * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
    return K * Math.exp(-r * T) * ncdf(-d2) - S * ncdf(-d1);
  }
  var TICK_PER_DAY = 24;

  // ---------- 状态 ----------
  function initState(seed, startEquity) {
    return {
      seed: seed, startEquity: startEquity, tick: 0,
      startedAt: new Date().toISOString(),
      market: initMarket(seed), managers: {}, lastEvents: [], priceHistory: []
    };
  }
  function initManager(id, equity) {
    return {
      id: id, equity: equity, cash: equity, startEquity: equity,
      positions: [], closed: [], decisions: [], evolution: [], history: [], dailyReview: [],
      stats: { trades: 0, wins: 0, losses: 0, realized: 0, peak: equity, maxDrawdown: 0 },
      dayTrades: 0, dayLosses: 0, dayMark: 0, monthTrades: 0, monthMark: 0, evoSeenIdx: 0,
      _dayStartEquity: equity
    };
  }

  // ---------- 全局引用 ----------
  var RNG = null, _tick = 0;
  function rng_global() { return RNG ? RNG() : Math.random(); }
  function stateTick() { return _tick; }

  // ---------- 量化预判评分体系（幻狐第7/8章蒸馏） ----------
  // 趋势方向：-100(极空) ~ +100(极多)
  function calcTrendDirection(c) {
    var score = 0;
    var smaRatio = (c.sma5 - c.sma20) / c.sma20;
    score += clamp(smaRatio * 2000, -40, 40);
    var priceRatio = (c.price - c.sma20) / c.sma20;
    score += clamp(priceRatio * 1500, -30, 30);
    score += (c.rsi - 50) * 0.6;
    return Math.round(clamp(score, -100, 100));
  }
  // 趋势强度：0(无趋势) ~ 100(极强)
  function calcTrendStrength(c) {
    var score = 0;
    var smaSpread = Math.abs(c.sma5 - c.sma20) / c.sma20;
    score += clamp(smaSpread * 1000, 0, 30);
    score += clamp((c.volSpike - 0.3) * 20, 0, 25);
    score += Math.abs(c.rsi - 50) * 0.5;
    score += (c.regime !== 0) ? 20 : 0;
    return Math.round(clamp(score, 0, 100));
  }
  // 黑马四阶段：1=启动 2=加速 3=高潮 4=退潮
  function calcPhase(c) {
    var smaSpread = Math.abs((c.sma5 - c.sma20) / c.sma20);
    if (c.rsi > 70 && c.volSpike > 1.8) return 3;
    if (smaSpread < 0.005 && c.rsi < 45 && c.regime !== 1) return 4;
    if (smaSpread >= 0.003 && c.volSpike >= 1.0) return 2;
    if (smaSpread < 0.003 && c.volSpike < 1.2) return 1;
    return smaSpread >= 0.003 ? 2 : 1;
  }
  // 全维度综合评分：-100 ~ +100
  // 宏观25% + 周期20% + 微观15% + 链上15% + 政策10% + 赛道10%
  function calcDimensionScore(c, coins) {
    var macroScore = 0;
    if (coins && coins["BTC"]) {
      var btc = coins["BTC"];
      var btcMacro = (btc.sma5 > btc.sma20 * 1.002) ? 1 : (btc.sma5 < btc.sma20 * 0.998 ? -1 : 0);
      macroScore = btcMacro * 100;
    }
    var cycleScore = (c.rsi - 50) * 2;
    var microScore = clamp(((c.price - c.sma20) / c.sma20 * 3000) + (c.regime * 40), -100, 100);
    var chainScore = 0;
    if (c.isMeme) {
      chainScore = clamp((c.heat - 50) * 2 + (c.smartMoney - 15) * 3, -100, 100);
    } else {
      chainScore = clamp((c.smartMoney - 10) * 5, -50, 50);
    }
    var policyScore = clamp((c.volSpike - 1) * 60, -100, 100);
    var sectorScore = 0;
    if (coins && coins["BTC"] && c.sym !== "BTC") {
      var btcH = coins["BTC"].hist;
      var btcRet = btcH.length >= 6 ? (coins["BTC"].price / btcH[btcH.length - 6] - 1) : 0;
      var cRet = c.hist.length >= 6 ? (c.price / c.hist[c.hist.length - 6] - 1) : 0;
      sectorScore = clamp((cRet - btcRet) * 500, -100, 100);
    }
    var total = macroScore * 0.25 + cycleScore * 0.20 + microScore * 0.15 + chainScore * 0.15 + policyScore * 0.10 + sectorScore * 0.10;
    return Math.round(clamp(total, -100, 100));
  }

  // ---------- 1+3 形态检测（幻狐核心模型） ----------
  // 返回 {pattern, bigOne, smallThree, direction}
  // pattern: "1+3_long_confirm" | "1+3_long_pending" | "1+3_short_confirm" | "1+3_short_pending" | "none"
  function detectPattern131(c) {
    var h = c.hist;
    var n = h.length;
    if (n < 8) return { pattern: "none", bigOne: null, smallThree: null, direction: 0 };
    // === 做多1+3：找"大一"(近期新低后反弹) → 检查"小三"(后续3根收盘均在大一之上) ===
    var biL = -1, lowL = Infinity;
    for (var i = Math.max(1, n - 7); i < n - 3; i++) {
      if (h[i] < lowL && h[i] < h[i - 1] && h[i + 1] > h[i]) { lowL = h[i]; biL = i; }
    }
    if (biL >= 0) {
      var okL = true;
      for (var j = biL + 1; j < Math.min(biL + 4, n); j++) { if (h[j] <= lowL) { okL = false; break; } }
      if (okL) {
        var preHighL = -Infinity;
        for (var k = Math.max(0, biL - 3); k <= biL; k++) { if (h[k] > preHighL) preHighL = h[k]; }
        var newHighL = (biL + 3 < n) ? (h[biL + 3] > preHighL) : false;
        if (newHighL) return { pattern: "1+3_long_confirm", bigOne: lowL, smallThree: true, direction: 1 };
        return { pattern: "1+3_long_pending", bigOne: lowL, smallThree: true, direction: 1 };
      }
    }
    // === 做空1+3：找"大一"(近期新高后回落) → 检查"小三"(后续3根收盘均在大一之下) ===
    var biS = -1, highS = -Infinity;
    for (var i2 = Math.max(1, n - 7); i2 < n - 3; i2++) {
      if (h[i2] > highS && h[i2] > h[i2 - 1] && h[i2 + 1] < h[i2]) { highS = h[i2]; biS = i2; }
    }
    if (biS >= 0) {
      var okS = true;
      for (var j2 = biS + 1; j2 < Math.min(biS + 4, n); j2++) { if (h[j2] >= highS) { okS = false; break; } }
      if (okS) {
        var preLowS = Infinity;
        for (var k2 = Math.max(0, biS - 3); k2 <= biS; k2++) { if (h[k2] < preLowS) preLowS = h[k2]; }
        var newLowS = (biS + 3 < n) ? (h[biS + 3] < preLowS) : false;
        if (newLowS) return { pattern: "1+3_short_confirm", bigOne: highS, smallThree: true, direction: -1 };
        return { pattern: "1+3_short_pending", bigOne: highS, smallThree: true, direction: -1 };
      }
    }
    return { pattern: "none", bigOne: null, smallThree: null, direction: 0 };
  }

  // ---------- 视图 ----------
  function viewCoin(c, coins) {
    return {
      sym: c.sym, price: c.price, sma5: c.sma5, sma20: c.sma20, rsi: c.rsi, atr: c.atr, iv: c.iv,
      heat: c.heat, smartMoney: c.smartMoney, rug: c.rug, isMeme: c.isMeme, volSpike: c.volSpike, regime: c.regime,
      trendScore: calcTrendDirection(c),
      trendStrength: calcTrendStrength(c),
      phase: calcPhase(c),
      dimensionScore: calcDimensionScore(c, coins),
      pattern131: detectPattern131(c)
    };
  }

  // ---------- 执行动作（直接改动 manager 并写决策日志） ----------
  function logDecision(mgr, d) { mgr.decisions.push(d); if (mgr.decisions.length > 800) mgr.decisions.shift(); }

  function openSpot(profile, mgr, c, side, rr, rationale) {
    var pct = (profile.sim.positionPct || 0.2) * (0.7 + rng_global() * 0.6);
    var cost = mgr.cash * pct;
    var qty = cost / c.price;
    
    // 根据主理人交易体系计算具体止损位和目标位
    var slPrice, tpPrice, slReason, tpReason;
    var atr = c.atr || (c.price * 0.02);
    
    if (profile.id === "huanhu") {
      var slPct = side === "long" ? 0.05 : 0.05;
      var tpPct = side === "long" ? (0.5 + rr * 0.15) : (0.5 + rr * 0.15);
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + tpPct) : (1 - tpPct));
      slReason = "1+3失效，大一低点×0.98纪律止损";
      tpReason = "目标50-100%，盈亏比≥3:1";
    } else if (profile.id === "sniper") {
      var slPct = 2 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "三重确认失效，2倍ATR止损";
      tpReason = "盈亏比" + rr.toFixed(2) + "，3倍ATR目标";
    } else if (profile.id === "laomao") {
      var slPct = 1.5 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "趋势反转，1.5倍ATR止损";
      tpReason = "趋势延续目标，盈亏比" + rr.toFixed(2);
    } else if (profile.id === "aoying") {
      var slPct = 1 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "低杠杆风控，1倍ATR止损";
      tpReason = "波段目标，盈亏比" + rr.toFixed(2);
    } else if (profile.id === "lanniaohui") {
      var slPct = 2.5 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "meme币高波动，2.5倍ATR止损";
      tpReason = "meme爆发目标，盈亏比" + rr.toFixed(2);
    } else {
      slPrice = c.price * (side === "long" ? 0.92 : 1.08);
      tpPrice = c.price * (side === "long" ? (1 + 0.08 * rr) : (1 - 0.08 * rr));
      slReason = "默认8%止损";
      tpReason = "默认目标";
    }
    
    var pos = {
      kind: "spot", coin: c.sym, side: side, qty: qty, margin: cost, notional: cost,
      entry: c.price, leverage: 1, openTick: stateTick(), rr: rr,
      sl: slPrice, tp: tpPrice,
      rationale: rationale + " | 止损:" + r2(slPrice) + "(" + slReason + ") 目标:" + r2(tpPrice) + "(" + tpReason + ")"
    };
    mgr.cash -= cost; mgr.positions.push(pos);
    mgr.dayTrades++; mgr.monthTrades++;
    logDecision(mgr, { tick: stateTick(), type: "open", coin: c.sym, kind: "spot", side: side, detail: r2(cost), rationale: pos.rationale });
    return { type: "open", coin: c.sym, kind: "spot", side: side, detail: r2(cost), rationale: pos.rationale };
  }

  function maxLevFor(profile, c) {
    if (profile.id === "aoying") {
      // 熬鹰「低杠杆复利」蒸馏规则：大饼≤5x(实盘给3x)、主流山寨1.5x、meme 1x
      if (c && c.isMeme) return 1;
      if (c && c.sym === "BTC") return 3;
      return 1.5;
    }
    return 3;
  }

  function openPerp(profile, mgr, c, side, rr, rationale) {
    var cap = maxLevFor(profile, c);
    var lev = cap * (0.7 + rng_global() * 0.6);
    lev = Math.max(1, Math.min(lev, cap));
    var margin = mgr.cash * (profile.sim.positionPct || 0.25);
    var qty = margin * lev / c.price;
    
    // 根据主理人交易体系计算具体止损位和目标位
    var slPrice, tpPrice, slReason, tpReason;
    var atr = c.atr || (c.price * 0.02); // 默认ATR为价格的2%
    
    if (profile.id === "huanhu") {
      // 幻狐：1+3右侧交易，止损=大一低点×0.98，目标50-100%
      var slPct = side === "long" ? 0.05 : 0.05; // 5%止损（1+3失效）
      var tpPct = side === "long" ? (0.5 + rr * 0.15) : (0.5 + rr * 0.15); // 50-100%目标
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + tpPct) : (1 - tpPct));
      slReason = "1+3失效，大一低点×0.98纪律止损";
      tpReason = "目标50-100%，盈亏比≥3:1";
    } else if (profile.id === "sniper") {
      // 狙击手：三重确认，ATR止损
      var slPct = 2 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "三重确认失效，2倍ATR止损";
      tpReason = "盈亏比" + rr.toFixed(2) + "，3倍ATR目标";
    } else if (profile.id === "laomao") {
      // 老猫：趋势跟踪，ATR止损
      var slPct = 1.5 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "趋势反转，1.5倍ATR止损";
      tpReason = "趋势延续目标，盈亏比" + rr.toFixed(2);
    } else if (profile.id === "aoying") {
      // 熬鹰：低杠杆波段，ATR止损
      var slPct = 1 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "低杠杆风控，1倍ATR止损";
      tpReason = "波段目标，盈亏比" + rr.toFixed(2);
    } else if (profile.id === "lanniaohui") {
      // 蓝鸟会：meme币高波动，ATR止损
      var slPct = 2.5 * atr / c.price;
      slPrice = c.price * (side === "long" ? (1 - slPct) : (1 + slPct));
      tpPrice = c.price * (side === "long" ? (1 + slPct * rr) : (1 - slPct * rr));
      slReason = "meme币高波动，2.5倍ATR止损";
      tpReason = "meme爆发目标，盈亏比" + rr.toFixed(2);
    } else {
      // 默认：固定百分比
      slPrice = c.price * (side === "long" ? 0.93 : 1.07);
      tpPrice = c.price * (side === "long" ? (1 + 0.07 * rr) : (1 - 0.07 * rr));
      slReason = "默认7%止损";
      tpReason = "默认目标";
    }
    
    var pos = {
      kind: "perp", coin: c.sym, side: side, qty: qty, margin: margin, notional: margin * lev,
      entry: c.price, leverage: lev, openTick: stateTick(), rr: rr,
      sl: slPrice, tp: tpPrice,
      rationale: rationale + " | 止损:" + r2(slPrice) + "(" + slReason + ") 目标:" + r2(tpPrice) + "(" + tpReason + ")"
    };
    mgr.cash -= margin; mgr.positions.push(pos);
    mgr.dayTrades++; mgr.monthTrades++;
    logDecision(mgr, { tick: stateTick(), type: "open", coin: c.sym, kind: "perp", side: side, detail: r2(margin) + "U@" + r2(lev) + "x", rationale: pos.rationale });
    return { type: "open", coin: c.sym, kind: "perp", side: side, detail: r2(margin), rationale: pos.rationale };
  }

  function addPyramid(profile, mgr, c, pos, rationale) {
    var add = pos.margin * 0.6;
    var qtyAdd = add * pos.leverage / c.price;
    if (mgr.cash < add) return { type: "skip", rationale: "现金不足，跳过金字塔加仓" };
    pos.margin += add; pos.notional += add * pos.leverage; pos.qty += qtyAdd;
    mgr.cash -= add;
    logDecision(mgr, { tick: stateTick(), type: "add", coin: pos.coin, side: pos.side, detail: r2(add), rationale: rationale });
    return { type: "add", coin: pos.coin, detail: r2(add), rationale: rationale };
  }

  function openOption(profile, mgr, c, side, buySell, rationale) {
    var S = c.price, iv = c.iv / 100;
    var isCall = side === "call";
    var k1 = isCall ? S * 1.03 : S * 0.97;   // 近端行权价（方向腿）
    var k2 = isCall ? S * 1.10 : S * 0.90;   // 远端翼行权价（保护腿，defined-risk 价差）
    var Tdays = 7 + Math.floor(rng_global() * 21);
    var T = Tdays / 365;
    var r = 0.02;
    var p1 = bsPrice(S, k1, T, r, iv, isCall);
    var p2 = bsPrice(S, k2, T, r, iv, isCall);
    var net0 = Math.max(p1 - p2, 1e-9);
    var width = Math.abs(k2 - k1);
    // 以预算锚定资金占用（1 张 = 1 份名义，不做×100，避免单张名义远超账户）
    var budget = mgr.cash * (profile.sim.positionPct || 0.2);
    var cost = Math.min(budget, mgr.cash * 0.5);
    if (cost <= 0) return { type: "skip", rationale: "现金不足，期权开仓失败" };
    var maxWinRatio = Math.max(0, (width - net0) / net0); // 买方最大收益倍数 = 卖方最大亏损倍数
    var pos = {
      kind: "option", coin: c.sym, otype: side, side: buySell,
      strike: r2(k1), wingStrike: r2(k2), contracts: 1,
      premiumEntry: net0, spent: cost, tExp: Tdays, spreadWidth: width,
      maxWinRatio: maxWinRatio,
      openTick: stateTick(), ivEntry: c.iv, entrySpot: S, rationale: rationale
    };
    if (buySell === "buy") {
      pos.margin = cost;         // 买方：已付权利金即最大风险
      mgr.cash -= cost;
    } else {
      // 卖方：收到权利金，负债按市价逐日盯市，不扣押现金（风控字段仅展示）
      mgr.cash += cost;
      pos.margin = cost * maxWinRatio;
      pos.sellerMaxLoss = cost * maxWinRatio;
    }
    mgr.positions.push(pos);
    mgr.dayTrades++; mgr.monthTrades++;
    logDecision(mgr, { tick: stateTick(), type: "open", coin: c.sym, kind: "option", side: side + (buySell === "buy" ? "/买" : "/卖"), detail: "K=" + r2(k1) + "/" + r2(k2) + " IV=" + r2(c.iv) + " 投入=" + r2(cost) + "U", rationale: rationale });
    return { type: "open", coin: c.sym, kind: "option", side: side, detail: r2(cost), rationale: rationale };
  }

  function realizePnl(mgr, pos, c) {
    var fee = (pos.notional || pos.spent || 0) * 0.0004;
    var pnl = 0, exit = c.price;
    if (pos.kind === "option") {
      var ov = optionState(pos, c);
      if (pos.side === "buy") { pnl = ov.abs - pos.spent - fee; mgr.cash += ov.abs; }
      else { pnl = pos.spent - ov.abs - fee; mgr.cash -= ov.abs; }
    } else if (pos.kind === "spot") {
      pnl = (c.price - pos.entry) * pos.qty * (pos.side === "long" ? 1 : -1) - fee;
      mgr.cash += pos.margin + pnl;
    } else {
      pnl = (c.price - pos.entry) * pos.qty * (pos.side === "long" ? 1 : -1) - fee;
      mgr.cash += pos.margin + pnl;
    }
    mgr.stats.trades++; mgr.stats.realized += pnl;
    if (pnl > 0) mgr.stats.wins++; else { mgr.stats.losses++; mgr.dayLosses++; }
    mgr.closed.push({ coin: pos.coin, side: pos.side, otype: pos.otype, entry: pos.entry, exit: exit, pnl: pnl, rationale: pos.rationale, tick: stateTick() });
    if (mgr.closed.length > 400) mgr.closed.shift();
    return pnl;
  }

  function closePosition(mgr, pos, c, rationale) {
    var pnl = realizePnl(mgr, pos, c);
    var idx = mgr.positions.indexOf(pos);
    if (idx >= 0) mgr.positions.splice(idx, 1);
    logDecision(mgr, { tick: stateTick(), type: "close", coin: pos.coin, side: pos.side, detail: r2(pnl) + "U", rationale: rationale });
    return { type: "close", coin: pos.coin, pnl: pnl, rationale: rationale };
  }

  function profit(pos, c) {
    if (!c) return 0;
    if (pos.kind === "spot") return (c.price - pos.entry) / pos.entry * (pos.side === "long" ? 1 : -1);
    if (pos.kind === "perp") return (c.price - pos.entry) / pos.entry * pos.leverage * (pos.side === "long" ? 1 : -1);
    var p = optionPnl(pos, c); return p / (pos.spent || 1);
  }
  function optionState(pos, c) {
    var Tdays = pos.tExp - (stateTick() - pos.openTick) / TICK_PER_DAY;
    var T = Math.max(Tdays / 365, 1 / 365);
    var iv = c.iv / 100;
    var isCall = pos.otype === "call";
    var p1 = bsPrice(c.price, pos.strike, T, 0.02, iv, isCall);
    var p2 = bsPrice(c.price, pos.wingStrike, T, 0.02, iv, isCall);
    var netNow = Math.max(0, Math.min(p1 - p2, pos.spreadWidth));
    var abs = pos.spent * (netNow / (pos.premiumEntry || 1e-9)); // 价差当前绝对价值
    return { abs: abs, signed: pos.side === "buy" ? abs : -abs };
  }
  function optionPnl(pos, c) {
    var s = optionState(pos, c);
    return pos.side === "buy" ? (s.abs - pos.spent) : (pos.spent - s.abs);
  }

  // ---------- 策略决策 ----------
  function decide(profile, mgr, coins, rng, st) {
    var tick = st.tick;
    if (tick - mgr.dayMark >= 24) { mgr.dayMark = tick; mgr.dayTrades = 0; mgr.dayLosses = 0; }
    if (tick - mgr.monthMark >= 24 * 30) { mgr.monthMark = tick; mgr.monthTrades = 0; }
    var ev = [];
    if (profile.id === "lanniaohui") ev = decideLanniaohui(profile, mgr, coins, rng);
    else if (profile.id === "sniper") ev = decideSniper(profile, mgr, coins, rng);
    else if (profile.id === "laomao") ev = decideLaomao(profile, mgr, coins, rng);
    else if (profile.id === "aoying") ev = decideAoying(profile, mgr, coins, rng);
    else if (profile.id === "hongqigong") ev = decideHongqigong(profile, mgr, coins, rng);
    else if (profile.id === "huanhu") ev = decideHuanhu(profile, mgr, coins, rng);
    return ev;
  }

  function decideLanniaohui(p, mgr, coins, rng) {
    var ev = [];
    var rake = [];
    for (var i = 0; i < p.sim.coinsA.length; i++) {
      var c = coins[p.sim.coinsA[i]]; if (!c) continue;
      var v = viewCoin(c);
      rake.push({ coin: c.sym, redFlags: Math.round(v.rug), heat: v.heat, smartMoney: v.smartMoney, rug: v.rug });
    }
    // 持仓离场
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var cc = coins[pos.coin]; if (!cc) continue;
      if (cc.heat < 30 || cc.rug > 3.2) {
        ev.push(closePosition(mgr, pos, cc, "叙事热度退潮/排雷触发，纪律离场"));
      }
    }
    rake.sort(function (a, b) { return (b.heat + b.smartMoney * 1.5 - b.rug * 3) - (a.heat + a.smartMoney * 1.5 - a.rug * 3); });
    var pass = rake.filter(function (r) { return r.redFlags < 2 && r.smartMoney >= 12; });
    var blocked = rake.filter(function (r) { return r.redFlags >= 2 || r.smartMoney < 12; });
    if (blocked.length && rng() < 0.12) {
      var b = blocked[Math.floor(rng() * blocked.length)];
      ev.push({ type: "iron_block", coin: b.coin, rationale: "九关排雷拒单：" + b.coin + " 红旗" + b.redFlags + "，看不懂的盘不买" });
    }
    if (mgr.positions.length >= 3) return ev;
    if (pass.length === 0) return ev;
    var best = pass[0]; var c = coins[best.coin];
    var rr = 2.0 + rng();
    ev.push(openSpot(p, mgr, c, "long", rr,
      "钱包追踪命中(" + best.coin + ")热度" + r2(best.heat) + "/聪明钱" + r2(best.smartMoney) + "%/红旗" + best.redFlags + "，验证击球区小仓进场"));
    return ev;
  }

  function decideSniper(p, mgr, coins, rng) {
    var ev = [];
    if (mgr.dayTrades >= 5) return ev; // 持续寻找机会：放宽每日出场上限
    if (mgr.dayLosses >= 3) return ev; // 连亏3笔才停手，保持活性
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var cc = coins[pos.coin]; if (!cc) continue;
      if (profit(pos, cc) < -0.03) ev.push(closePosition(mgr, pos, cc, "硬风控：单笔亏损达阈值，执行纪律止损"));
    }
    if (mgr.positions.length > 0) return ev;
    var candidates = [];
    for (var i = 0; i < p.sim.coinsA.length; i++) {
      var c = coins[p.sim.coinsA[i]]; if (!c) continue;
      var v = viewCoin(c);
      var side = v.sma5 > v.sma20 ? "long" : "short";
      var trig = Math.abs(v.price - v.sma5) / v.sma5;
      var rr = 1.6 + rng() * 0.8;
      if (trig > 0.004 && v.volSpike < 2.4 && rr >= 1.5) candidates.push({ c: c, side: side, rr: rr, score: trig });
    }
    if (!candidates.length) return ev;
    candidates.sort(function (a, b) { return b.score - a.score; });
    var pick = candidates[0];
    ev.push(openPerp(p, mgr, pick.c, pick.side, pick.rr,
      "三重确认：大周期方向(" + (pick.side === "long" ? "多头" : "空头") + ")+小周期触发+盈亏比" + r2(pick.rr) + "≥1.5"));
    return ev;
  }

  function decideLaomao(p, mgr, coins, rng) {
    var ev = [];
    if (mgr.monthTrades >= 5) return ev; // 放宽月度出手上限，持续跟踪趋势
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var c = coins[pos.coin]; if (!c) continue;
      var pnl = profit(pos, c);
      if (pnl > 0.3 && pos.leverage < 1.6 && rng() < 0.10) {
        ev.push(addPyramid(p, mgr, c, pos, "盈利" + r2(pnl * 100) + "%，正向金字塔加仓(1:0.6:0.3)"));
        return ev;
      }
      if (pnl < -0.02 && c.sma5 < c.sma20) { ev.push(closePosition(mgr, pos, c, "50日线破位止损(三线定乾坤)")); }
    }
    if (mgr.positions.length > 0) return ev;
    for (var i = 0; i < p.sim.coinsA.length; i++) {
      var cc = coins[p.sim.coinsA[i]]; if (!cc) continue;
      var v = viewCoin(cc);
      if (v.sma5 > v.sma20 && v.rsi > 50 && v.rsi < 70 && v.volSpike > 1.15) {
        ev.push(openPerp(p, mgr, cc, "long", 2.2, "三线定乾坤：均线多头+量能放大+回踩，进趋势"));
        return ev;
      }
    }
    return ev;
  }

  function decideAoying(p, mgr, coins, rng) {
    var ev = [];
    if (mgr.dayTrades >= 12) return ev;  // 快进快出：放大单日频次，持续捕捉短线
    if (mgr.dayLosses >= 4) return ev;   // 连亏4笔才停手，保持活性
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var c = coins[pos.coin]; if (!c) continue;
      if (profit(pos, c) < -0.04) { ev.push(closePosition(mgr, pos, c, "短线止损：破位就砍，不扛单")); }
      else if ((stateTick() - pos.openTick) >= p.sim.holdMaxTicks) { ev.push(closePosition(mgr, pos, c, "短线快进快出，到达持仓周期离场")); }
    }
    if (mgr.positions.length >= 3) return ev;
    var sym = rng() < 0.4 ? "BTC" : (rng() < 0.5 ? "ETH" : (rng() < 0.5 ? "SOL" : "DOGE"));
    var c = coins[sym]; var v = viewCoin(c);
    var side = v.regime === 1 ? "long" : (v.regime === -1 ? "short" : (v.rsi < 40 ? "long" : (v.rsi > 62 ? "short" : (v.sma5 > v.sma20 ? "long" : "short"))));
    var rr = 1.2 + rng() * 0.8;
    ev.push(openPerp(p, mgr, c, side, rr,
      "突破/区间/反抽判断：RSI" + r2(v.rsi) + "，" + (side === "long" ? "做多" : "做空") + "，低杠杆波段"));
    return ev;
  }

  function decideHongqigong(p, mgr, coins, rng) {
    var ev = [];
    // 极端行情：波动放大触发「只做 BTC」铁律
    mgr.mode = (coins["BTC"] && coins["BTC"].iv > 85) ? "btc_only" : "";
    // 铁律诱惑：周期性想碰山寨被拦截
    if (rng() < 0.09) {
      var evils = ["DOGE.OP", "PEPE.OP", "WIF.OP", "SHIB.OP"];
      var evil = evils[Math.floor(rng() * evils.length)];
      ev.push({ type: "iron_block", coin: evil, rationale: "铁律拦截：非BTC/ETH/SOL标的(" + evil + ")期权请求被拒绝，杜绝一期山寨币" });
      return ev;
    }
    var pool = mgr.mode === "btc_only" ? ["BTC"] : ["BTC", "ETH", "SOL"];
    var c = coins[pool[Math.floor(rng() * pool.length)]];
    var v = viewCoin(c);
    // 到期/止损
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var cc = coins[pos.coin]; if (!cc) continue;
      if (profit(pos, cc) < -0.5) { ev.push(closePosition(mgr, pos, cc, "卖方/买方风控：亏损达阈值，保护性平仓")); }
    }
    if (mgr.positions.length > 0) return ev;
    // 方向+波动率双轴（蒸馏核心逻辑）
    var trend = v.regime; // 1=多 / -1=空 / 0=震荡
    var buy, side;
    if (trend !== 0 && v.iv < 75) { buy = true; side = (trend === 1) ? "call" : "put"; }
    else if (trend === 0 && v.iv > 55) { buy = false; side = (v.sma5 > v.sma20) ? "call" : "put"; }
    else if (v.iv >= 90) { buy = true; side = (v.sma5 > v.sma20) ? "call" : "put"; }
    else return ev; // 无清晰 edge，观望
    ev.push(openOption(p, mgr, c, side, buy ? "buy" : "sell",
      (buy ? "方向博弈" : "卖方收时间价值") + "：regime=" + trend + " IV=" + r2(v.iv) + "，" + side + "(合法标的)"));
    return ev;
  }

  // 幻狐：机构1+3右侧交易（评分+形态驱动版）
  // 入场条件：1+3形态确认 + 趋势方向评分 + 趋势强度 + 全维度综合评分门槛
  // 离场条件：反向1+3确认 / 趋势评分反转 / 阶段4退潮 / 硬止损
  function decideHuanhu(p, mgr, coins, rng) {
    var ev = [];
    if (mgr.dayTrades >= 3) return ev;
    if (mgr.dayLosses >= 3) return ev;
    var rrMin = p.sim.rrMin || 3.0;
    // ① 持仓管理：形态失效 + 评分反转 + 阶段退潮 + 硬止损
    for (var k = mgr.positions.length - 1; k >= 0; k--) {
      var pos = mgr.positions[k]; var cc = coins[pos.coin]; if (!cc) continue;
      var pf = profit(pos, cc);
      var v = viewCoin(cc, coins);
      var pat = v.pattern131;
      // 反向1+3确认 → 形态失效，纪律离场
      if (pos.side === "long" && pat.pattern === "1+3_short_confirm") {
        ev.push(closePosition(mgr, pos, cc, "下跌1+3确认→多头形态失效，纪律离场不扛单"));
        continue;
      }
      if (pos.side === "short" && pat.pattern === "1+3_long_confirm") {
        ev.push(closePosition(mgr, pos, cc, "上涨1+3确认→空头形态失效，纪律离场不扛单"));
        continue;
      }
      // 趋势评分反转 + 浮亏 → 止损
      if ((v.trendScore < -40 && pos.side === "long" && pf < -0.02) ||
          (v.trendScore > 40 && pos.side === "short" && pf < -0.02)) {
        ev.push(closePosition(mgr, pos, cc, "趋势评分反转(" + v.trendScore + ")，1+3止损纪律"));
        continue;
      }
      // 硬止损 -12%
      if (pf < -0.12) {
        ev.push(closePosition(mgr, pos, cc, "硬止损-12%，不扛单"));
        continue;
      }
      // 阶段4退潮 + 高盈利 → 分批止盈
      if (pf > 0.25 && v.phase === 4) {
        ev.push(closePosition(mgr, pos, cc, "阶段4退潮+浮盈" + Math.round(pf * 100) + "%，分批止盈锁定利润"));
        continue;
      }
      // 阶段3高潮 + 极高盈利 → 落袋
      if (pf > 0.4 && v.phase === 3) {
        ev.push(closePosition(mgr, pos, cc, "阶段3高潮+浮盈" + Math.round(pf * 100) + "%，落袋为安"));
        continue;
      }
      // 持有周期到期
      if ((stateTick() - pos.openTick) >= p.sim.holdMaxTicks) {
        ev.push(closePosition(mgr, pos, cc, "持有周期到期，移动止盈离场"));
      }
    }
    // ② 右侧入场：1+3形态确认 + 评分门槛
    if (mgr.positions.length >= 3) return ev;
    var cands = [];
    for (var i = 0; i < p.sim.coinsA.length; i++) {
      var c = coins[p.sim.coinsA[i]]; if (!c) continue;
      var v2 = viewCoin(c, coins);
      var pat2 = v2.pattern131;
      // 全维度评分门槛：综合评分绝对值≥25才考虑入场
      if (Math.abs(v2.dimensionScore) < 25) continue;
      // 趋势强度门槛：≥30
      if (v2.trendStrength < 30) continue;
      // 1+3做多确认
      if (pat2.pattern === "1+3_long_confirm" && v2.trendScore > 25) {
        var rr = rrMin + rng() * 1.5;
        var sc = v2.dimensionScore * 0.35 + v2.trendScore * 0.30 + v2.trendStrength * 0.20 + (v2.volSpike > 1.1 ? 15 : 0) + (v2.phase === 2 ? 10 : 0);
        cands.push({ c: c, side: "long", rr: rr, score: sc, pat: pat2, v: v2 });
      }
      // 1+3做空确认
      if (pat2.pattern === "1+3_short_confirm" && v2.trendScore < -25) {
        var rr2 = rrMin + rng() * 1.5;
        var sc2 = Math.abs(v2.dimensionScore) * 0.35 + Math.abs(v2.trendScore) * 0.30 + v2.trendStrength * 0.20 + (v2.volSpike > 1.1 ? 15 : 0) + (v2.phase === 2 ? 10 : 0);
        cands.push({ c: c, side: "short", rr: rr2, score: sc2, pat: pat2, v: v2 });
      }
    }
    if (!cands.length) {
      // 无1+3确认 → 观望（附带评分快照，让看板可解释为什么不出手）
      if (rng() < 0.06) {
        var watch = coins[p.sim.coinsA[Math.floor(rng() * p.sim.coinsA.length)]];
        if (watch) {
          var wv = viewCoin(watch, coins);
          var wpat = wv.pattern131;
          var patLabel = wpat.pattern !== "none" ? wpat.pattern : "无1+3形态";
          ev.push({ type: "1_3_watch", coin: watch.sym,
            rationale: "趋势" + wv.trendScore + "/强度" + wv.trendStrength + "/阶段" + wv.phase + "/维度" + wv.dimensionScore + "/" + patLabel + "，1+3未确认，观望" });
        }
      }
      return ev;
    }
    cands.sort(function (a, b) { return b.score - a.score; });
    var pick = cands[0];
    var patName = (pick.pat.pattern.indexOf("long") >= 0) ? "上涨1+3确认" : "下跌1+3确认";
    ev.push(openPerp(p, mgr, pick.c, pick.side, pick.rr,
      patName + "：趋势" + pick.v.trendScore + "/强度" + pick.v.trendStrength + "/维度" + pick.v.dimensionScore + "/阶段" + pick.v.phase + "，盈亏比" + r2(pick.rr) + "≥3"));
    return ev;
  }

  // ---------- 每日复盘 ----------
  function rollDailyReview(mgr, profile, st) {
    var day = Math.floor((st.tick - 1) / TICK_PER_DAY); // 刚结束的交易日序号
    var dayStart = (typeof mgr._dayStartEquity === "number") ? mgr._dayStartEquity : mgr.startEquity;
    var dayEnd = mgr.equity;
    var pnl = dayEnd - dayStart;
    var trades = 0, wins = 0, losses = 0;
    for (var i = 0; i < mgr.closed.length; i++) {
      var c = mgr.closed[i];
      if (Math.floor(c.tick / TICK_PER_DAY) === day) {
        trades++;
        if (c.pnl > 0) wins++; else losses++;
      }
    }
    var sc = profile.selfCorrection && profile.selfCorrection.length ? profile.selfCorrection : ["持续复盘，修正交易认知"];
    var lesson = sc[mgr.dailyReview.length % sc.length];
    mgr.dailyReview.push({
      day: day, equity: r2(dayEnd), pnl: r2(pnl),
      pnlPct: r2(pnl / Math.max(Math.abs(dayStart), 1e-9)),
      trades: trades, wins: wins, losses: losses, lesson: lesson
    });
    if (mgr.dailyReview.length > 120) mgr.dailyReview.shift();
    mgr._dayStartEquity = dayEnd;
  }

  // ---------- 主推进 ----------
  function advance(st, nTicks, realPrices) {
    // 可续推：把 PRNG 内部状态 a 持久化，避免断点重播导致随机序列重复
    var a = (typeof st.rngState === "number" && !isNaN(st.rngState)) ? (st.rngState | 0) : (st.seed | 0);
    var rng = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    var events = [];
    for (var i = 0; i < nTicks; i++) {
      _tick = st.tick; RNG = rng;
      // 每日复盘：每个交易日(24 tick)结束，为每位主理人结算当日
      if (st.tick > 0 && st.tick % TICK_PER_DAY === 0) {
        for (var idr in st.managers) {
          var prf = PROFILES_BY_ID[idr];
          if (prf) rollDailyReview(st.managers[idr], prf, st);
        }
      }
      stepMarket(st.market, rng, realPrices);
      st.priceHistory.push({ 
        t: st.tick, 
        BTC: r2(st.market.BTC.price), ETH: r2(st.market.ETH.price), SOL: r2(st.market.SOL.price), 
        BNB: r2(st.market.BNB.price), DOGE: r2(st.market.DOGE.price),
        PEPE: r2(st.market.PEPE.price), SHIB: r2(st.market.SHIB.price), WIF: r2(st.market.WIF.price),
        BONK: r2(st.market.BONK.price), FLOKI: r2(st.market.FLOKI.price), MEME: r2(st.market.MEME.price)
      });
      if (st.priceHistory.length > 6000) st.priceHistory.shift();
      for (var id in st.managers) {
        var mgr = st.managers[id]; var profile = PROFILES_BY_ID[id]; if (!profile) continue;
        // 止损/止盈/到期
        for (var k = mgr.positions.length - 1; k >= 0; k--) {
          var pos = mgr.positions[k]; var c = st.market[pos.coin]; if (!c) continue;
          var slHit = pos.sl && (pos.side === "long" ? c.price <= pos.sl : c.price >= pos.sl);
          var tpHit = pos.tp && (pos.side === "long" ? c.price >= pos.tp : c.price <= pos.tp);
          var expir = pos.kind === "option" && (st.tick - pos.openTick) >= pos.tExp * TICK_PER_DAY;
          if (slHit || tpHit || expir) {
            var why = slHit ? "止损触发" : (tpHit ? "止盈触发" : "期权到期结算");
            events.push(closePosition(mgr, pos, c, why));
          }
        }
        var ev = decide(profile, mgr, st.market, rng, st);
        for (var e = 0; e < ev.length; e++) events.push(ev[e]);
        mgr.equity = mgr.cash + openUnrealized(mgr, st.market);
        if (mgr.equity > mgr.stats.peak) mgr.stats.peak = mgr.equity;
        var dd = (mgr.stats.peak - mgr.equity) / mgr.stats.peak;
        if (dd > mgr.stats.maxDrawdown) mgr.stats.maxDrawdown = dd;
        mgr.history.push({ t: st.tick, e: r2(mgr.equity) });
        if (mgr.history.length > 6000) mgr.history.shift();
        evolve(profile, mgr, st.tick, rng);
      }
      st.tick++;
    }
    st.rngState = a;
    st.lastEvents = events;
    st.lastUpdate = new Date().toISOString();
    return st;
  }

  function openUnrealized(mgr, coins) {
    var u = 0;
    for (var i = 0; i < mgr.positions.length; i++) {
      var pos = mgr.positions[i]; var c = coins[pos.coin]; if (!c) continue;
      if (pos.kind === "spot") u += c.price * pos.qty;                                   // 现货：本金+浮盈
      else if (pos.kind === "perp") u += pos.margin + (c.price - pos.entry) * pos.qty * (pos.side === "long" ? 1 : -1); // 合约：锁定保证金+浮盈亏
      else u += optionState(pos, c).signed;                                            // 期权：买方=现价、卖方=负债
    }
    return u;
  }

  function evolve(profile, mgr, tick, rng) {
    if (mgr.closed.length && mgr.evoSeenIdx !== mgr.closed.length) {
      var last = mgr.closed[mgr.closed.length - 1];
      mgr.evoSeenIdx = mgr.closed.length;
      if (last.pnl < 0 && mgr.evolution.length < 60) {
        var lesson = profile.selfCorrection[mgr.evolution.length % profile.selfCorrection.length];
        mgr.evolution.push({ tick: tick, trigger: "亏损复盘#" + last.coin, lesson: lesson, delta: "参数微调" });
      }
    }
    if (rng() < 0.012 && mgr.evolution.length < 120) {
      var l2 = profile.selfCorrection[Math.floor(rng() * profile.selfCorrection.length)];
      mgr.evolution.push({ tick: tick, trigger: "周期复盘", lesson: l2, delta: "进化指针" });
    }
  }

  function summary(st) {
    var rows = [];
    for (var i = 0; i < PROFILES_LIST.length; i++) {
      var p = PROFILES_LIST[i]; var mgr = st.managers[p.id]; if (!mgr) continue;
      var w = mgr.stats.wins, l = mgr.stats.losses, t = w + l;
      rows.push({
        id: p.id, name: p.name, arena: p.arena, color: p.color,
        equity: mgr.equity, cash: mgr.cash, realized: mgr.stats.realized,
        pnl: mgr.equity - mgr.startEquity, pnlPct: (mgr.equity - mgr.startEquity) / mgr.startEquity,
        trades: t, wins: w, losses: l, winRate: t ? w / t : 0,
        maxDrawdown: mgr.stats.maxDrawdown, open: mgr.positions.length
      });
    }
    return rows;
  }

  var PROFILES_LIST = [], PROFILES_BY_ID = {};
  function attachProfiles(profileModule) {
    PROFILES_LIST = profileModule.KOLS;
    for (var i = 0; i < PROFILES_LIST.length; i++) PROFILES_BY_ID[PROFILES_LIST[i].id] = PROFILES_LIST[i];
  }

  return {
    COIN_DEF: COIN_DEF, initMarket: initMarket, stepMarket: stepMarket, bsPrice: bsPrice,
    initState: initState, initManager: initManager, advance: advance, summary: summary,
    attachProfiles: attachProfiles, mulberry32: mulberry32, TICK_PER_DAY: TICK_PER_DAY,
    r2: r2, viewCoin: viewCoin
  };
});