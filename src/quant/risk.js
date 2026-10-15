// Quant risk engine: position sizing and portfolio-level gates. Pure functions so the
// backtester and the live bot apply exactly the same rules.

export const RISK_DEFAULTS = Object.freeze({
  riskPerTradePct: 1.0, // max loss per trade (stop + costs) as % of equity
  maxPositionPct: 50, // max notional per position as % of equity
  slotAllocations: [5, 3, 2], // hard caps per slot (USDC), as requested
  maxPositions: 3,
  minPositionQuote: 1, // below this an order is pointless / below exchange minimums
  dailyLossPct: 1.5, // realized+unrealized loss today that blocks entries
  monthlyLossPct: 3.0, // monthly loss (vs month-start equity, incl. unrealized) that triggers the monthly policy
  monthlyLimitAction: "flatten", // "flatten" = close all positions + block entries until next month; "block" = block entries only
  maxDrawdownPct: 10, // portfolio drawdown from peak equity that halts entries until a manual review
  lossStreakPause: 3, // consecutive losses that trigger a pause
  lossStreakPauseHours: 24,
  maxCorrelation: 0.8, // reject a new position too correlated with an open one
  costEdgeMultiple: 3, // expected favourable move must be >= this x round-trip cost
  volTargetDailyPct: 4 // scale size down when asset daily vol exceeds this
});

/** Round-trip cost in % of notional: 2 x taker fee + spread + 2 x slippage. */
export function roundTripCostPct({ takerFeePct = 0.09, spreadPct = 0.2, slippagePct = 0.05 }) {
  return 2 * takerFeePct + spreadPct + 2 * slippagePct;
}

/**
 * Portfolio gates. @returns {{ok:boolean, reasons:object[]}}
 * pf: { equity, monthStartEquity, monthPnl, dayStartEquity, dayPnl, lossStreak, lastLossAt, positions:[{asset}] , emergency }
 */
export function portfolioGate(pf, now, p = RISK_DEFAULTS) {
  const reasons = [];
  const no = (code, detail) => reasons.push({ code, detail });
  if (pf.emergency) no("emergency_stop", "emergency stop active");
  if (pf.monthPnl <= -(p.monthlyLossPct / 100) * pf.monthStartEquity) no("monthly_loss_limit", `month ${pf.monthPnl.toFixed(4)} <= -${p.monthlyLossPct}% of ${pf.monthStartEquity.toFixed(2)}`);
  if (pf.peakEquity > 0 && (pf.peakEquity - pf.equity) / pf.peakEquity * 100 >= p.maxDrawdownPct) no("max_drawdown_halt", `drawdown ${(((pf.peakEquity - pf.equity) / pf.peakEquity) * 100).toFixed(2)}% >= ${p.maxDrawdownPct}% from peak ${pf.peakEquity.toFixed(2)}`);
  if (pf.dayPnl <= -(p.dailyLossPct / 100) * pf.dayStartEquity) no("daily_loss_limit", `day ${pf.dayPnl.toFixed(4)} <= -${p.dailyLossPct}%`);
  if (pf.lossStreak >= p.lossStreakPause && now - (pf.lastLossAt || 0) < p.lossStreakPauseHours * 3600000) no("loss_streak_pause", `${pf.lossStreak} consecutive losses, pause ${p.lossStreakPauseHours}h`);
  if (pf.positions.length >= p.maxPositions) no("max_positions", `${pf.positions.length} open`);
  return { ok: reasons.length === 0, reasons };
}

/** Pearson correlation of two equal-length return arrays. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 30) return NaN;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; cov += x * y; va += x * x; vb += y * y; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : NaN;
}

/**
 * Size a trade. @returns {{ok, quote, reasons, detail}}
 * signal: { stopPct }, costs: { roundTripPct }, pf: { equity, cash, deployed, budget, freeSlot }, assetDailyVolPct
 */
export function sizePosition({ signal, costs, pf, assetDailyVolPct }, p = RISK_DEFAULTS) {
  const reasons = [];
  const lossPerUnitPct = signal.stopPct + costs.roundTripPct; // worst planned loss incl. costs
  const riskQuote = (p.riskPerTradePct / 100) * pf.equity;
  let quote = riskQuote / (lossPerUnitPct / 100);
  const caps = {
    risk: quote,
    slot: p.slotAllocations[(pf.freeSlot || 1) - 1] ?? 0,
    maxPosition: (p.maxPositionPct / 100) * pf.equity,
    budget: Math.max(0, pf.budget - pf.deployed),
    cash: pf.cash * 0.995
  };
  quote = Math.min(...Object.values(caps));
  let volScale = 1;
  if (Number.isFinite(assetDailyVolPct) && assetDailyVolPct > p.volTargetDailyPct) {
    volScale = p.volTargetDailyPct / assetDailyVolPct;
    quote *= volScale;
  }
  quote = Math.floor(quote * 100) / 100;
  if (quote < p.minPositionQuote) reasons.push({ code: "size_below_minimum", detail: `risk-based size ${quote.toFixed(2)} < ${p.minPositionQuote} USDC (stop ${signal.stopPct.toFixed(2)}% + costs ${costs.roundTripPct.toFixed(2)}%)` });
  return { ok: reasons.length === 0, quote, reasons, detail: { riskQuote, lossPerUnitPct, caps, volScale, plannedMaxLoss: quote * lossPerUnitPct / 100 } };
}
