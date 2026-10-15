// Decision engine: the 10-step pipeline requested, shared by the backtester and the
// live bot. It returns a fully explained Decision record. Discord is NOT involved here.
import { classifyRegime } from "./regime.js";
import { STRATEGIES } from "./strategies.js";
import { roundTripCostPct, portfolioGate, sizePosition, correlation, RISK_DEFAULTS } from "./risk.js";

/**
 * @param {object} a
 *  asset, f (features), i (bar index), market {f,i}, now, barTime, maxBarAgeMs,
 *  exec {spreadPct, takerFeePct, slippagePct}, pf (portfolio snapshot),
 *  enabled: list of strategy names allowed to trade, stats: {name:{validated, meanNetPct, n}},
 *  returnsFor(asset) -> recent 1h returns array (for correlation), riskParams
 * @returns {object} decision
 */
export function decide(a) {
  const d = { asset: a.asset, at: new Date(a.now).toISOString(), barTime: new Date(a.barTime).toISOString(), action: "none", steps: {}, reasons: [] };
  const rp = a.riskParams || RISK_DEFAULTS;
  // 1. data freshness / consistency
  const age = a.now - a.barTime;
  const fresh = age <= (a.maxBarAgeMs ?? 2 * 3600000) && a.f.close[a.i] > 0 && Number.isFinite(a.f.atr14[a.i]);
  d.steps.data = { ok: fresh, barAgeMin: Math.round(age / 60000) };
  if (!fresh) return reject(d, "stale_or_invalid_data", `bar age ${Math.round(age / 60000)} min`);
  // 2. regime
  const regime = classifyRegime(a.f, a.i, a.market, a.exec);
  d.steps.regime = regime;
  // 3. signals of allowed strategies
  const signals = [];
  for (const name of a.enabled) {
    const s = STRATEGIES[name];
    if (!s) continue;
    if (!s.allowed(regime)) { d.reasons.push({ code: "regime_not_allowed", detail: `${name} not allowed in ${regime.label}${regime.marketTrend ? "/BTC " + regime.marketTrend : ""}` }); continue; }
    const sig = s.signal(a.f, a.i, a.strategyParams?.[name]);
    if (sig) signals.push(sig);
  }
  d.steps.signals = signals.map((s) => ({ strategy: s.strategy, score: +s.score.toFixed(1), stopPct: +s.stopPct.toFixed(2), reasons: s.reasons }));
  if (!signals.length) return reject(d, "no_signal", "no allowed strategy produced an entry signal");
  const sig = signals.sort((x, y) => y.score - x.score)[0];
  // 4. expected return (only from validated out-of-sample statistics, else heuristic)
  const st = a.stats?.[sig.strategy];
  d.steps.expectation = st?.validated
    ? { calibrated: true, meanNetPct: st.meanNetPct, n: st.n, source: "walk-forward out-of-sample" }
    : { calibrated: false, note: "heuristic score only - no validated out-of-sample statistics" };
  if (a.requireValidated && !st?.validated) return reject(d, "strategy_not_validated", `${sig.strategy} has no positive out-of-sample validation`);
  // 5. costs
  const rt = roundTripCostPct(a.exec);
  const expectedMovePct = sig.targetPct > 0 ? sig.targetPct : 2 * (a.f.atr14[a.i] / a.f.close[a.i]) * 100;
  d.steps.costs = { roundTripPct: +rt.toFixed(3), expectedMovePct: +expectedMovePct.toFixed(3), requiredMultiple: rp.costEdgeMultiple };
  if (expectedMovePct < rp.costEdgeMultiple * rt) return reject(d, "edge_below_costs", `expected move ${expectedMovePct.toFixed(2)}% < ${rp.costEdgeMultiple} x cost ${rt.toFixed(2)}%`);
  // 6-7. portfolio gates, correlation, sizing
  const gate = portfolioGate(a.pf, a.now, rp);
  if (!gate.ok) { d.reasons.push(...gate.reasons); d.steps.portfolio = { ok: false }; return reject(d, gate.reasons[0].code, gate.reasons[0].detail, true); }
  if (a.pf.positions.some((p) => p.asset === a.asset)) return reject(d, "already_held", a.asset);
  if (a.returnsFor) {
    const mine = a.returnsFor(a.asset);
    for (const p of a.pf.positions) {
      const c = correlation(mine, a.returnsFor(p.asset));
      if (c > rp.maxCorrelation) return reject(d, "correlated_exposure", `corr ${c.toFixed(2)} with open ${p.asset}`);
    }
  }
  const dailyVolPct = a.f.vol24[a.i] * Math.sqrt(24) * 100;
  const size = sizePosition({ signal: sig, costs: { roundTripPct: rt }, pf: a.pf, assetDailyVolPct: dailyVolPct }, rp);
  d.steps.sizing = { quote: size.quote, ...size.detail };
  if (!size.ok) return reject(d, size.reasons[0].code, size.reasons[0].detail);
  // 8-9. accept
  d.action = "enter";
  d.signal = sig;
  d.quote = size.quote;
  d.reasons.push({ code: "accepted", detail: `${sig.strategy}: ${sig.reasons.join(", ")}` });
  return d;
}

function reject(d, code, detail, already = false) {
  if (!already) d.reasons.push({ code, detail });
  d.action = "none";
  d.rejection = code;
  return d;
}
