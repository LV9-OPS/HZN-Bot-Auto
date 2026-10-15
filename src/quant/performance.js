// Strategy performance tracking and kill switch.
// Parameters are NEVER re-optimised in production. A strategy is only switched OFF when its
// live results degrade persistently; switching it back on requires a new offline validation
// (npm run research) and a manual reset (delete state.strategyStatus entry or `npm run strategies -- --reset`).

export const KILL_DEFAULTS = Object.freeze({ window: 20, minTrades: 10, maxProfitFactor: 0.8, maxExpectancyPct: 0 });

export function strategyReport(history, p = KILL_DEFAULTS) {
  const by = {};
  for (const pos of history) {
    if (pos.status !== "closed" || pos.plan?.mode !== "quant") continue;
    const s = pos.plan.strategy;
    (by[s] ||= []).push(pos);
  }
  const out = {};
  for (const [s, list] of Object.entries(by)) {
    const recent = list.slice(-p.window);
    const pct = recent.map((x) => (x.costBasisQuote > 0 ? (x.realizedNetPnl / x.costBasisQuote) * 100 : 0));
    const wins = recent.filter((x) => x.realizedNetPnl > 0).reduce((a, x) => a + x.realizedNetPnl, 0);
    const losses = -recent.filter((x) => x.realizedNetPnl <= 0).reduce((a, x) => a + x.realizedNetPnl, 0);
    const pf = losses > 0 ? wins / losses : wins > 0 ? Infinity : null;
    const exp = pct.length ? pct.reduce((a, b) => a + b, 0) / pct.length : null;
    const slip = recent.map((x) => x.entry?.slippagePct).filter(Number.isFinite);
    out[s] = {
      trades: list.length, recentTrades: recent.length, profitFactor: pf === null ? null : +pf.toFixed(3), expectancyPct: exp === null ? null : +exp.toFixed(3),
      netPnl: +list.reduce((a, x) => a + (x.realizedNetPnl || 0), 0).toFixed(4),
      avgEntrySlippagePct: slip.length ? +(slip.reduce((a, b) => a + b, 0) / slip.length).toFixed(4) : null,
      degraded: recent.length >= p.minTrades && pf !== null && pf < p.maxProfitFactor && exp <= p.maxExpectancyPct
    };
  }
  return out;
}

/** Apply the kill switch to state.strategyStatus. Returns newly disabled strategies. */
export function applyKillSwitch(state, p = KILL_DEFAULTS) {
  const rep = strategyReport(state.history, p);
  state.strategyStatus ||= {};
  const newly = [];
  for (const [s, r] of Object.entries(rep)) {
    if (r.degraded && !state.strategyStatus[s]?.disabled) {
      state.strategyStatus[s] = { disabled: true, at: new Date().toISOString(), reason: `last ${r.recentTrades} trades: PF ${r.profitFactor}, expectancy ${r.expectancyPct}%` };
      newly.push(s);
    }
  }
  return { report: rep, newly };
}
