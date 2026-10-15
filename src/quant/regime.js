// Market-regime classification (reproducible, rule-based, no fitting).
//  trend : up | down | range   from EMA50/EMA200 alignment and the 7-day return
//  vol   : high | normal | low  from the percentile of 24h realized vol within the last 90 days
//  stress: true when execution liquidity is poor (wide spread) or data look abnormal
//  extreme: true on violent moves (|1h return| > 4 sigma or market 24h drop > 10%)
// The asset regime is combined with the market regime (BTC) because altcoins are highly
// correlated with BTC, especially in sell-offs.

export const REGIME_DEFAULTS = Object.freeze({
  volHighPct: 0.8,
  volLowPct: 0.2,
  trendBandPct: 0.5, // EMA50 vs EMA200 gap below this = range
  extremeSigma: 4,
  marketCrash24hPct: -10,
  maxSpreadPct: 0.4
});

/**
 * @param {object} f feature columns (computeFeatureSet) for the asset
 * @param {number} i bar index
 * @param {object} [m] market (BTC) features + index {f, i}
 * @param {object} [exec] { spreadPct } current execution quality (live only)
 */
export function classifyRegime(f, i, m = null, exec = null, p = REGIME_DEFAULTS) {
  const reasons = [];
  const close = f.close[i];
  const gap = ((f.ema50[i] - f.ema200[i]) / f.ema200[i]) * 100;
  let trend = "range";
  if (Number.isFinite(gap)) {
    if (gap > p.trendBandPct && close > f.ema200[i] && f.ret168[i] > 0) trend = "up";
    else if (gap < -p.trendBandPct && close < f.ema200[i] && f.ret168[i] < 0) trend = "down";
  } else reasons.push("trend: insufficient history");
  const vp = f.volPct90d[i];
  const vol = !Number.isFinite(vp) ? "normal" : vp >= p.volHighPct ? "high" : vp <= p.volLowPct ? "low" : "normal";
  const sigma = f.vol24[i];
  const r1 = Math.log(close / f.close[i - 1]);
  let extreme = Number.isFinite(sigma) && sigma > 0 && Math.abs(r1) > p.extremeSigma * sigma;
  if (extreme) reasons.push(`|1h move| ${(r1 * 100).toFixed(2)}% > ${p.extremeSigma} sigma`);
  let marketTrend = null;
  if (m && m.f && Number.isFinite(m.i) && m.i >= 0) {
    const mr = m.f.ret24[m.i];
    if (mr <= p.marketCrash24hPct) { extreme = true; reasons.push(`market 24h ${mr.toFixed(1)}%`); }
    const mg = ((m.f.ema50[m.i] - m.f.ema200[m.i]) / m.f.ema200[m.i]) * 100;
    marketTrend = mg > p.trendBandPct && m.f.close[m.i] > m.f.ema200[m.i] ? "up" : mg < -p.trendBandPct && m.f.close[m.i] < m.f.ema200[m.i] ? "down" : "range";
  }
  let stress = false;
  if (exec && Number.isFinite(exec.spreadPct) && exec.spreadPct > p.maxSpreadPct) { stress = true; reasons.push(`spread ${exec.spreadPct.toFixed(2)}%`); }
  if (!(close > 0) || !Number.isFinite(f.atr14[i])) { stress = true; reasons.push("invalid data"); }
  const label = extreme ? "extreme" : stress ? "liquidity_stress" : `${trend}_${vol}vol`;
  return { trend, vol, extreme, stress, marketTrend, label, reasons };
}
