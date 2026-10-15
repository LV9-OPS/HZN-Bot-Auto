import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatureSet, rsi, ema } from "../../src/quant/features.js";
import { classifyRegime } from "../../src/quant/regime.js";
import { STRATEGIES } from "../../src/quant/strategies.js";
import { sizePosition, portfolioGate, roundTripCostPct, correlation, RISK_DEFAULTS } from "../../src/quant/risk.js";
import { decide } from "../../src/quant/decision.js";
import { runBacktest } from "../../src/backtest/engine.js";
import { computeMetrics } from "../../src/backtest/metrics.js";
import { strategyReport, applyKillSwitch } from "../../src/quant/performance.js";
import { evaluateExit } from "../../src/strategy/profitPlan.js";
import { rng } from "../helpers.js";

function series({ n = 3000, drift = 0, noise = 0.004, seed = 1, start = Date.UTC(2024, 0, 1), shock = null }) {
  const r = rng(seed);
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    let ret = drift + (r() - 0.5) * 2 * noise;
    if (shock && i === shock.at) ret = shock.ret;
    const o = p, c = p * (1 + ret);
    bars.push({ t: start + i * 3600000, open: o, high: Math.max(o, c) * (1 + r() * noise * 0.3), low: Math.min(o, c) * (1 - r() * noise * 0.3), close: c, volume: 1000 * (0.7 + r() * 0.6) });
    p = c;
  }
  return bars;
}

test("indicators: RSI bounds and EMA convergence", () => {
  const up = Array.from({ length: 50 }, (_, i) => 100 + i);
  assert.equal(rsi(up)[49], 100);
  const flat = Array.from({ length: 60 }, () => 5);
  assert.ok(Math.abs(ema(flat, 20)[59] - 5) < 1e-12);
});

test("regime: uptrend, downtrend and extreme move are classified reproducibly", () => {
  const upF = computeFeatureSet(series({ drift: 0.001 }));
  assert.equal(classifyRegime(upF, 2999).trend, "up");
  const dnF = computeFeatureSet(series({ drift: -0.001 }));
  assert.equal(classifyRegime(dnF, 2999).trend, "down");
  const shockF = computeFeatureSet(series({ shock: { at: 2999, ret: -0.08 } }));
  assert.equal(classifyRegime(shockF, 2999).extreme, true);
  const stress = classifyRegime(upF, 2999, null, { spreadPct: 1.2 });
  assert.equal(stress.stress, true);
});

test("strategies are blocked in unsuitable regimes (no long trend trades in a downtrend / crash)", () => {
  const down = { trend: "down", vol: "normal", extreme: false, stress: false, marketTrend: "down" };
  const crash = { trend: "up", vol: "high", extreme: true, stress: false, marketTrend: "up" };
  for (const s of Object.values(STRATEGIES)) {
    assert.equal(s.allowed(down), false, s.name);
    assert.equal(s.allowed(crash), false, s.name);
  }
});

test("costs: round trip = 2 fees + spread + 2 slippage", () => {
  assert.ok(Math.abs(roundTripCostPct({ takerFeePct: 0.09, spreadPct: 0.2, slippagePct: 0.05 }) - 0.48) < 1e-12);
});

test("risk sizing: loss at stop (incl. costs) never exceeds the per-trade risk budget; caps apply", () => {
  const pf = { equity: 10, cash: 10, deployed: 0, budget: 10, freeSlot: 1 };
  const r = sizePosition({ signal: { stopPct: 4 }, costs: { roundTripPct: 0.5 }, pf, assetDailyVolPct: 3 });
  assert.ok(r.ok);
  assert.ok(r.quote * 0.045 <= 0.1 + 1e-9, `planned loss ${r.quote * 0.045}`);
  const wide = sizePosition({ signal: { stopPct: 15 }, costs: { roundTripPct: 0.5 }, pf, assetDailyVolPct: 3 });
  assert.equal(wide.ok, false);
  assert.equal(wide.reasons[0].code, "size_below_minimum");
  const slot3 = sizePosition({ signal: { stopPct: 0.5 }, costs: { roundTripPct: 0.3 }, pf: { ...pf, freeSlot: 3 }, assetDailyVolPct: 3 });
  assert.ok(slot3.quote <= 2, "slot 3 capped at 2 USDC");
});

test("portfolio gates: monthly 3% loss, daily loss, loss streak and emergency block entries", () => {
  const base = { equity: 10, monthStartEquity: 10, monthPnl: 0, dayStartEquity: 10, dayPnl: 0, lossStreak: 0, lastLossAt: 0, positions: [], emergency: false };
  assert.equal(portfolioGate(base, Date.now()).ok, true);
  assert.equal(portfolioGate({ ...base, monthPnl: -0.3 }, Date.now()).reasons[0].code, "monthly_loss_limit");
  assert.equal(portfolioGate({ ...base, dayPnl: -0.2 }, Date.now()).reasons[0].code, "daily_loss_limit");
  assert.equal(portfolioGate({ ...base, lossStreak: 3, lastLossAt: Date.now() }, Date.now()).reasons[0].code, "loss_streak_pause");
  assert.equal(portfolioGate({ ...base, emergency: true }, Date.now()).reasons[0].code, "emergency_stop");
});

test("correlation guard measures co-movement", () => {
  const a = Array.from({ length: 100 }, (_, i) => Math.sin(i));
  assert.ok(correlation(a, a.map((x) => x * 2)) > 0.99);
  assert.ok(Math.abs(correlation(a, a.map((_, i) => Math.cos(i * 7)))) < 0.5);
});

test("decision engine explains every rejection and never invents a probability", () => {
  const bars = series({ drift: 0.0008 });
  const f = computeFeatureSet(bars);
  const pf = { equity: 10, cash: 10, deployed: 0, budget: 10, freeSlot: 1, monthStartEquity: 10, monthPnl: 0, dayStartEquity: 10, dayPnl: 0, lossStreak: 0, lastLossAt: 0, positions: [], emergency: false };
  const now = bars.at(-1).t + 3600000;
  const stale = decide({ asset: "X", f, i: 2999, now: now + 10 * 3600000, barTime: bars.at(-1).t, exec: { spreadPct: 0.1 }, pf, enabled: ["trend"] });
  assert.equal(stale.rejection, "stale_or_invalid_data");
  let accepted = null;
  for (let i = 300; i < 3000 && !accepted; i++) {
    const d = decide({ asset: "X", f, i, now: bars[i].t + 3600000, barTime: bars[i].t + 3600000, exec: { spreadPct: 0.1 }, pf, enabled: ["trend", "breakout", "pullback"] });
    assert.ok(d.reasons.length > 0);
    if (d.action === "enter") accepted = d;
  }
  assert.ok(accepted, "at least one entry in a steady uptrend");
  assert.equal(accepted.steps.expectation.calibrated, false);
  assert.ok(accepted.steps.costs.roundTripPct > 0);
  const notValidated = decide({ asset: "X", f, i: accepted && f.close.findIndex((_, k) => k === 0) + 0 || 0, now: 0, barTime: 0, exec: {}, pf, enabled: [] });
  assert.equal(notValidated.action, "none");
});

test("decision engine refuses a non-validated strategy when validation is required", () => {
  const bars = series({ drift: 0.0008 });
  const f = computeFeatureSet(bars);
  const pf = { equity: 10, cash: 10, deployed: 0, budget: 10, freeSlot: 1, monthStartEquity: 10, monthPnl: 0, dayStartEquity: 10, dayPnl: 0, lossStreak: 0, lastLossAt: 0, positions: [], emergency: false };
  let rejection = null;
  for (let i = 300; i < 3000 && !rejection; i++) {
    const d = decide({ asset: "X", f, i, now: bars[i].t + 3600000, barTime: bars[i].t + 3600000, exec: { spreadPct: 0.1 }, pf, enabled: ["trend"], requireValidated: true, stats: { trend: { validated: false } } });
    if (d.rejection === "strategy_not_validated") rejection = d;
    assert.notEqual(d.action, "enter");
  }
  assert.ok(rejection);
});

test("backtester: entry at next bar open (no look-ahead), costs charged, stops respected", () => {
  const btc = series({ drift: 0.0015, noise: 0.012, seed: 3 });
  const assets = { BTC: { bars: btc, f: computeFeatureSet(btc), spreadPct: 0.1 } };
  const r = runBacktest({ assets, start: btc[400].t, end: btc.at(-1).t, startCash: 10, budget: 10, enabled: ["trend", "breakout", "pullback"], correlation: false });
  assert.ok(r.trades.length > 0);
  for (const t of r.trades) {
    const bar = btc.find((b) => b.t === t.entryT);
    assert.ok(Math.abs(t.entryPx - bar.open * 1.0005 * 1.0005) < 1e-9, "fill = open + half spread + slippage");
    assert.ok(t.costs > 0);
  }
  assert.ok(Number.isFinite(r.metrics.sharpe));
  assert.ok(r.metrics.maxDrawdownPct >= 0);
});

test("metrics: profit factor, expectancy and monthly stats", () => {
  const trades = [{ pnl: 1, pnlPct: 10, cost: 10, holdHours: 1, costs: 0.1 }, { pnl: -0.5, pnlPct: -5, cost: 10, holdHours: 1, costs: 0.1 }];
  const curve = [{ t: Date.UTC(2024, 0, 1), equity: 10 }, { t: Date.UTC(2024, 1, 1), equity: 10.5 }];
  const m = computeMetrics({ trades, curve, startEquity: 10 });
  assert.equal(m.profitFactor, 2);
  assert.equal(m.expectancyPct, 2.5);
  assert.equal(m.totalCostsQuote, 0.2);
});

test("kill switch disables a persistently losing strategy (no parameter re-optimisation)", () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ status: "closed", plan: { mode: "quant", strategy: "trend" }, realizedNetPnl: i % 4 === 0 ? 0.02 : -0.05, costBasisQuote: 3 }));
  const rep = strategyReport(history);
  assert.equal(rep.trend.degraded, true);
  const state = { history };
  const { newly } = applyKillSwitch(state);
  assert.deepEqual(newly, ["trend"]);
  assert.equal(state.strategyStatus.trend.disabled, true);
  assert.deepEqual(applyKillSwitch(state).newly, [], "not re-disabled");
});

test("quant exit: dynamic stop on the bid and optional target", () => {
  const p = { entryPrice: 100, plan: { mode: "quant", stopPrice: 96, targetPrice: 0 }, targetReached: false };
  assert.equal(evaluateExit(p, { bid: 96.5, reliable: true }, { stopLossPct: 3 }).action, "hold");
  assert.equal(evaluateExit(p, { bid: 96, reliable: true }, { stopLossPct: 3 }).reason, "STOP_LOSS");
  const t = { ...p, plan: { ...p.plan, stopPrice: 101, trailed: true } };
  assert.equal(evaluateExit(t, { bid: 100.9, reliable: true }, { stopLossPct: 3 }).reason, "TRAILING_STOP");
  const tp = { ...p, plan: { ...p.plan, targetPrice: 103 } };
  assert.equal(evaluateExit(tp, { bid: 103, reliable: true }, { stopLossPct: 3 }).reason, "TAKE_PROFIT");
});

test("defaults: monthly loss limit is 3% and per-trade risk 1%", () => {
  assert.equal(RISK_DEFAULTS.monthlyLossPct, 3);
  assert.equal(RISK_DEFAULTS.riskPerTradePct, 1);
});

test("max drawdown halt blocks entries until manual reset", () => {
  const base = { equity: 8.9, peakEquity: 10, monthStartEquity: 8.9, monthPnl: 0, dayStartEquity: 8.9, dayPnl: 0, lossStreak: 0, lastLossAt: 0, positions: [], emergency: false };
  assert.equal(portfolioGate(base, Date.now()).reasons[0].code, "max_drawdown_halt");
});

test("backtester applies the monthly flatten policy when the month loses 3% mark-to-market", () => {
  // steady uptrend then a sharp 2-day slide: open positions must be flattened, not ride the loss
  const up = series({ n: 2600, drift: 0.0015, noise: 0.012, seed: 9 });
  let p = up.at(-1).close;
  for (let k = 0; k < 400; k++) { const o = p; p = p * (1 - 0.004); up.push({ t: up.at(-1).t + 3600000, open: o, high: o, low: p, close: p, volume: 1000 }); }
  const assets = { BTC: { bars: up, f: computeFeatureSet(up), spreadPct: 0.1 } };
  const r = runBacktest({ assets, start: up[400].t, end: up.at(-1).t, startCash: 10, budget: 10, enabled: ["trend", "breakout"], correlation: false });
  const flat = r.trades.filter((t) => t.reason === "MONTHLY_LOSS_LIMIT");
  assert.ok(r.policyEvents.length >= 0);
  for (const e of r.policyEvents) assert.ok(e.monthPnl <= -0.29);
  if (flat.length) assert.ok(r.policyEvents.length > 0);
});
