// Portfolio backtester on 1-hour bars (event-driven, no look-ahead).
//  - decisions at the CLOSE of bar i, using only bars <= i (decision engine shared with live)
//  - entries fill at the OPEN of the asset's next bar: ask = open x (1 + spread/2 + slippage), taker fee
//  - stops: if the bar opens below the stop the fill is the open (gap), else the stop price;
//    stop is checked BEFORE the target within a bar (conservative)
//  - trailing stops / time stops / signal exits are updated at bar close and execute next open
//  - capital: start cash, hard budget cap, slots 5/3/2, one position per asset
import { decide } from "../quant/decision.js";
import { signalExit } from "../quant/strategies.js";
import { classifyRegime } from "../quant/regime.js";
import { RISK_DEFAULTS } from "../quant/risk.js";
import { computeMetrics } from "./metrics.js";

/**
 * @param {object} o
 *  assets: { [asset]: { bars, f, spreadPct } } (BTC must be present as market reference)
 *  start, end (ms), startCash, budget, takerFeePct, slippagePct, enabled (strategy names),
 *  strategyParams, riskParams, stats, requireValidated
 */
export function runBacktest(o) {
  const fee = (o.takerFeePct ?? 0.09) / 100;
  const slip = (o.slippagePct ?? 0.05) / 100;
  const rp = { ...RISK_DEFAULTS, ...(o.riskParams || {}) };
  const names = Object.keys(o.assets);
  const idx = {};
  const timesSet = new Set();
  for (const n of names) {
    const m = new Map();
    o.assets[n].bars.forEach((b, i) => { m.set(b.t, i); if (b.t >= o.start && b.t < o.end) timesSet.add(b.t); });
    idx[n] = m;
  }
  const times = [...timesSet].sort((a, b) => a - b);
  const market = o.assets.BTC ? { f: o.assets.BTC.f, idx: idx.BTC } : null;
  let cash = o.startCash;
  const open = new Map(); // asset -> position
  const pendingEntries = [];
  const trades = [];
  const curve = [];
  const decisionsLog = o.collectDecisions ? [] : null;
  let monthKey = null, monthStartEquity = cash, dayKey = null, dayStartEquity = cash;
  let lossStreak = 0, lastLossAt = 0, exposureHours = 0, exposureSum = 0, peakEquity = o.startCash, monthFlattened = null;
  const policyEvents = [];
  const rejectionCounts = {};

  const markEquity = (t) => {
    let eq = cash;
    for (const [n, p] of open) {
      const i = idx[n].get(t) ?? p.lastIdx;
      const c = o.assets[n].bars[i].close;
      eq += p.qty * c * (1 - o.assets[n].spreadPct / 200) * (1 - fee);
    }
    return eq;
  };

  const closePos = (n, p, fillMid, t, reason, isGapOrLevel = true) => {
    const spread = o.assets[n].spreadPct / 100;
    const px = fillMid * (1 - spread / 2) * (1 - slip);
    const gross = p.qty * px;
    const proceeds = gross * (1 - fee);
    cash += proceeds;
    const pnl = proceeds - p.cost;
    const midNotional = p.qty * fillMid;
    const costs = p.entryCosts + (midNotional - proceeds);
    trades.push({ asset: n, strategy: p.strategy, regime: p.regime, entryT: p.entryT, exitT: t, entryPx: p.entryPx, exitPx: px, qty: p.qty, cost: p.cost, proceeds, pnl, pnlPct: (pnl / p.cost) * 100, costs, holdHours: (t - p.entryT) / 3600000, reason });
    open.delete(n);
    if (pnl <= 0) { lossStreak++; lastLossAt = t; } else lossStreak = 0;
  };

  for (const t of times) {
    // month / day bookkeeping on mark-to-market equity
    const d = new Date(t);
    const mk = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const dk = Math.floor(t / 86400000);
    const eqNow = markEquity(t);
    if (mk !== monthKey) { monthKey = mk; monthStartEquity = eqNow; }
    if (dk !== dayKey) { dayKey = dk; dayStartEquity = eqNow; }

    // 0) monthly loss policy (mark-to-market): flatten everything at this bar's open
    if (rp.monthlyLimitAction === "flatten" && monthFlattened !== mk && eqNow - monthStartEquity <= -(rp.monthlyLossPct / 100) * monthStartEquity) {
      monthFlattened = mk;
      policyEvents.push({ t, event: "monthly_loss_flatten", monthPnl: eqNow - monthStartEquity });
      for (const [n, p] of [...open]) {
        const i = idx[n].get(t);
        closePos(n, p, o.assets[n].bars[i ?? p.lastIdx].open ?? o.assets[n].bars[p.lastIdx].close, t, "MONTHLY_LOSS_LIMIT");
      }
      pendingEntries.length = 0;
    }

    // 1) fill pending entries at this bar's open
    for (const e of pendingEntries.splice(0)) {
      const i = idx[e.asset].get(t);
      if (i === undefined || open.has(e.asset)) { pendingEntries.push(e); continue; }
      const b = o.assets[e.asset].bars[i];
      const spread = o.assets[e.asset].spreadPct / 100;
      const px = b.open * (1 + spread / 2) * (1 + slip);
      const quote = Math.min(e.quote, cash * 0.995);
      if (quote < rp.minPositionQuote) continue;
      const qty = quote / (1 + fee) / px;
      const cost = qty * px * (1 + fee);
      cash -= cost;
      const atrPct = e.signal.stopPct; // stop distance at decision time
      open.set(e.asset, {
        asset: e.asset, strategy: e.signal.strategy, regime: e.regime, slot: e.slot, entryT: t, entryIdx: i, lastIdx: i, entryPx: px, qty, cost,
        entryCosts: qty * b.open * (spread / 2 + slip) + qty * px * fee,
        stop: px * (1 - atrPct / 100), target: e.signal.targetPct > 0 ? px * (1 + e.signal.targetPct / 100) : Infinity,
        trailAtr: e.signal.trailAtr, maxHoldBars: e.signal.maxHoldBars, exitOnSignal: e.signal.exitOnSignal, highestClose: b.open, pendingExit: null
      });
    }

    // 2) exits: pending (from previous close) at open, then intrabar stop/target
    for (const [n, p] of [...open]) {
      const i = idx[n].get(t);
      if (i === undefined) continue;
      const b = o.assets[n].bars[i];
      p.lastIdx = i;
      if (p.pendingExit) { closePos(n, p, b.open, t, p.pendingExit); continue; }
      if (b.open <= p.stop) { closePos(n, p, b.open, t, "STOP_GAP"); continue; }
      if (b.low <= p.stop) { closePos(n, p, p.stop, t, p.trailed ? "TRAILING_STOP" : "STOP_LOSS"); continue; }
      if (b.high >= p.target) { closePos(n, p, Math.max(p.target, b.open), t, "TAKE_PROFIT"); continue; }
      // close-of-bar updates (applied from the next bar on)
      const f = o.assets[n].f;
      p.highestClose = Math.max(p.highestClose, b.close);
      if (p.trailAtr > 0 && Number.isFinite(f.atr14[i])) {
        const trail = p.highestClose - p.trailAtr * f.atr14[i];
        if (trail > p.stop) { p.stop = trail; p.trailed = true; }
      }
      if (i - p.entryIdx >= p.maxHoldBars) p.pendingExit = "TIME_EXIT";
      else if (p.exitOnSignal && signalExit(p.exitOnSignal, f, i)) p.pendingExit = "SIGNAL_EXIT";
    }

    // 3) decisions at this bar's close
    const eq = markEquity(t);
    peakEquity = Math.max(peakEquity, eq);
    const positions = [...open.values()].map((p) => ({ asset: p.asset, slot: p.slot }));
    const usedSlots = new Set([...open.values()].map((p) => p.slot).concat(pendingEntries.map((e) => e.slot)));
    const freeSlot = [1, 2, 3].slice(0, rp.maxPositions).find((s) => !usedSlots.has(s));
    const deployed = [...open.values()].reduce((s, p) => s + p.cost, 0) + pendingEntries.reduce((s, e) => s + e.quote, 0);
    if (freeSlot) {
      const pf = { equity: eq, peakEquity, cash, deployed, budget: o.budget, freeSlot, monthStartEquity, monthPnl: eq - monthStartEquity, dayStartEquity, dayPnl: eq - dayStartEquity, lossStreak, lastLossAt, positions: positions.concat(pendingEntries.map((e) => ({ asset: e.asset }))), emergency: false };
      const cands = [];
      for (const n of names) {
        const i = idx[n].get(t);
        if (i === undefined || i < 250 || open.has(n)) continue;
        const a = o.assets[n];
        const mi = market ? market.idx.get(t) : undefined;
        const dec = decide({
          asset: n, f: a.f, i, market: market && mi !== undefined ? { f: market.f, i: mi } : null, now: t + 3600000, barTime: t,
          exec: { spreadPct: a.spreadPct, takerFeePct: o.takerFeePct ?? 0.09, slippagePct: o.slippagePct ?? 0.05 },
          pf, enabled: o.enabled, strategyParams: o.strategyParams, riskParams: rp, stats: o.stats, requireValidated: o.requireValidated,
          returnsFor: o.correlation === false ? null : (asset) => {
            const ai = idx[asset].get(t);
            const f2 = o.assets[asset].f;
            return ai === undefined ? [] : f2.ret1.slice(Math.max(0, ai - 24 * 30 + 1), ai + 1);
          }
        });
        if (decisionsLog && dec.action === "enter") decisionsLog.push(dec);
        if (dec.action === "enter") cands.push(dec);
        else rejectionCounts[dec.rejection] = (rejectionCounts[dec.rejection] || 0) + 1;
      }
      if (cands.length) {
        const best = cands.sort((x, y) => y.signal.score - x.signal.score)[0];
        pendingEntries.push({ asset: best.asset, quote: best.quote, signal: best.signal, regime: best.steps.regime.label, slot: freeSlot });
      }
    }
    if (open.size) { exposureHours++; exposureSum += [...open.values()].reduce((s, p) => s + p.cost, 0); }
    curve.push({ t, equity: eq });
  }
  // close remaining positions at the last close (marked, flagged)
  const lastT = times[times.length - 1];
  for (const [n, p] of [...open]) closePos(n, p, o.assets[n].bars[p.lastIdx].close, lastT, "END_OF_TEST");
  if (curve.length) curve[curve.length - 1].equity = cash;
  const metrics = computeMetrics({ trades, curve, startEquity: o.startCash, exposureHours, totalHours: times.length, exposureSum });
  return { metrics, trades, curve, rejectionCounts, decisions: decisionsLog, policyEvents };
}

/** Buy-and-hold benchmark on one asset with the same costs. */
export function buyAndHold({ asset, start, end, startCash, takerFeePct = 0.09, slippagePct = 0.05 }) {
  const bars = asset.bars.filter((b) => b.t >= start && b.t < end);
  if (bars.length < 2) return null;
  const fee = takerFeePct / 100, slip = slippagePct / 100, sp = asset.spreadPct / 100;
  const px = bars[0].open * (1 + sp / 2) * (1 + slip);
  const qty = startCash / (1 + fee) / px;
  const curve = bars.map((b) => ({ t: b.t, equity: qty * b.close * (1 - sp / 2) * (1 - fee) }));
  const exitPx = bars[bars.length - 1].close * (1 - sp / 2) * (1 - slip);
  const proceeds = qty * exitPx * (1 - fee);
  const trades = [{ pnl: proceeds - startCash, pnlPct: (proceeds / startCash - 1) * 100, cost: startCash, holdHours: (bars.at(-1).t - bars[0].t) / 3600000, costs: 0 }];
  curve[curve.length - 1].equity = proceeds;
  return computeMetrics({ trades, curve, startEquity: startCash, exposureHours: bars.length, totalHours: bars.length, exposureSum: startCash * bars.length });
}

export { classifyRegime };
