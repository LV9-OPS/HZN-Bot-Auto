// Stage C - transparent candidate scoring.
// Every gate produces a named rejection reason; every score component is
// returned with its points so a Discord/log line can explain the ranking.
import { ramp, fmt } from "../util/num.js";

/**
 * Default signal parameters. Rationale (all testable with `npm run replay`):
 *  - minRet5 0.25%: below this a 5-minute move is indistinguishable from noise at 0.1-0.3% spreads.
 *  - maxRet5 3%: a >3% 5-minute candle burst is usually the climax, not the start.
 *  - minRelVol5 1.5: volume must clearly exceed its own 60-minute baseline.
 *  - maxRet60 6% / maxMoveFromLow 5% / maxDistEma21Pct 3%: "already moved" guards. Distance is
 *    measured in % (not ATR): after a tight base the ATR is tiny, so an ATR-based limit would
 *    reject exactly the early breakouts we want.
 *  - maxBaseRangePct 4%: the preceding 30 minutes should be relatively calm (a base).
 * There is deliberately NO minimum on 15m/60m change: an early move may not show there yet.
 */
export const DEFAULT_SIGNAL_PARAMS = Object.freeze({
  minRet5: 0.25,
  maxRet5: 3.0,
  minRet1: -0.15,
  minRelVol5: 1.5,
  maxRet60: 6.0,
  maxMoveFromLow: 5.0,
  maxDistEma21Pct: 3.0,
  maxBaseRangePct: 4.0,
  maxSyntheticShare: 0.85,
  weights: { momentum: 20, acceleration: 15, volume: 20, volAccel: 5, breakout: 15, trend: 10, base: 5, cost: 10 }
});

/**
 * @param {object} f features from computeFeatures (reference market)
 * @param {object} exec execution market info { spreadPct, quoteVolume24h, active }
 * @param {object} opts { params, minScore, maxSpreadPct, minExecQuoteVolume }
 */
export function scoreCandidate(f, exec, opts = {}) {
  const p = { ...DEFAULT_SIGNAL_PARAMS, ...(opts.params || {}) };
  const w = p.weights;
  const rejections = [];
  const reject = (code, detail) => rejections.push({ code, detail });

  if (!f) return { score: 0, rejections: [{ code: "insufficient_data", detail: "not enough closed candles" }], components: {}, qualified: false };

  // ---- hard gates (each one is a precise, logged reason) ----
  if (exec) {
    if (exec.active === false) reject("pair_inactive", "execution pair inactive");
    if (!(exec.spreadPct >= 0)) reject("no_quote", "no valid bid/ask on execution pair");
    else if (exec.spreadPct > (opts.maxSpreadPct ?? 0.4)) reject("spread_too_wide", `spread ${fmt(exec.spreadPct, 3)}% > ${opts.maxSpreadPct ?? 0.4}%`);
    if ((exec.quoteVolume24h ?? 0) < (opts.minExecQuoteVolume ?? 0)) reject("illiquid_exec_pair", `24h ${fmt(exec.quoteVolume24h, 0)} < ${opts.minExecQuoteVolume}`);
  }
  if (f.syntheticShare > p.maxSyntheticShare) reject("inactive_market", `${Math.round(f.syntheticShare * 100)}% of last 60 min without trades`);
  if (!(f.ret5 >= p.minRet5)) reject("no_momentum", `5m ${fmt(f.ret5, 2)}% < ${p.minRet5}%`);
  if (f.ret5 > p.maxRet5) reject("burst_too_large", `5m ${fmt(f.ret5, 2)}% > ${p.maxRet5}% (likely climax)`);
  if (f.ret1 < p.minRet1) reject("last_minute_down", `1m ${fmt(f.ret1, 2)}%`);
  if (!(f.relVol5 >= p.minRelVol5)) reject("no_volume_expansion", `relVol5 x${fmt(f.relVol5, 2)} < x${p.minRelVol5}`);
  if (f.ret60 > p.maxRet60) reject("already_extended", `60m +${fmt(f.ret60, 2)}% > ${p.maxRet60}%`);
  if (f.moveFromLowPct > p.maxMoveFromLow) reject("already_extended", `+${fmt(f.moveFromLowPct, 2)}% from 30m low > ${p.maxMoveFromLow}%`);
  if (f.distEma21Pct > p.maxDistEma21Pct) reject("overstretched", `${fmt(f.distEma21Pct, 2)}% above EMA21 > ${p.maxDistEma21Pct}%`);
  if (f.baseRangePct > p.maxBaseRangePct) reject("no_base", `prior 30m range ${fmt(f.baseRangePct, 2)}% > ${p.maxBaseRangePct}% (already volatile)`);
  if (f.wickRejection) reject("false_breakout", "broke prior high intrabar but closed back below");
  if (f.fading) reject("reversal", `gave back ${Math.round(f.retraceShare * 100)}% of the 5m burst`);
  if (!(f.ema9SlopePct > 0)) reject("no_trend", `EMA9 slope ${fmt(f.ema9SlopePct, 3)}%`);

  // ---- score components (0..weight) ----
  const comp = {};
  // Momentum: reward 0.25..1.5% over 5 min, then taper - big bursts are late.
  const mom = ramp(f.ret5, 0.2, 1.2) * (f.ret5 > 2 ? ramp(f.ret5, 3, 2) : 1);
  comp.momentum = w.momentum * mom;
  comp.acceleration = w.acceleration * ramp(f.accel3, 0, 0.25);
  comp.volume = w.volume * ramp(Math.log2(Math.max(f.relVol5, 1e-6)), 0.5, 2.5); // x1.4 .. x5.7
  comp.volAccel = w.volAccel * ramp(f.volAccel, 1, 3);
  comp.breakout = w.breakout * (f.breakoutConfirmed ? 0.5 + 0.5 * ramp(f.breakoutPct, 0, 0.6) : f.rangePos60 >= 0.85 ? 0.3 : 0);
  comp.trend = w.trend * (0.5 * (f.emaGapPct > 0 ? 1 : ramp(f.emaGapPct, -0.2, 0)) + 0.5 * ramp(f.ema9SlopePct, 0, 0.3));
  comp.base = w.base * ramp(f.baseRangePct, 3, 0.5); // calmer base -> higher
  const spread = exec?.spreadPct ?? 0.3;
  comp.cost = w.cost * ramp(spread, 0.4, 0.05);
  // Extension penalty: approaching the "already moved" limits costs points.
  const ext = Math.max(ramp(f.ret60, p.maxRet60 * 0.5, p.maxRet60), ramp(f.moveFromLowPct, p.maxMoveFromLow * 0.5, p.maxMoveFromLow), ramp(f.distEma21Pct, p.maxDistEma21Pct * 0.5, p.maxDistEma21Pct));
  comp.extensionPenalty = -15 * ext;

  const score = Math.max(0, Math.min(100, Object.values(comp).reduce((a, b) => a + b, 0)));
  const minScore = opts.minScore ?? 62;
  if (score < minScore && !rejections.length) rejections.push({ code: "score_below_min", detail: `${fmt(score, 1)} < ${minScore}` });
  return { score, components: comp, rejections, qualified: rejections.length === 0 };
}

/** One-line human explanation. */
export function explain(result, f) {
  const parts = Object.entries(result.components)
    .filter(([, v]) => Math.abs(v) >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k} ${v >= 0 ? "+" : ""}${v.toFixed(1)}`);
  const facts = f ? `5m ${fmt(f.ret5, 2)}% | 3m ${fmt(f.ret3, 2)}% | 60m ${fmt(f.ret60, 2)}% | vol x${fmt(f.relVol5, 1)} | accel ${fmt(f.accel3, 3)}%/min | breakout ${f.breakoutConfirmed ? "yes " + fmt(f.breakoutPct, 2) + "%" : "no"}` : "";
  return `score ${result.score.toFixed(1)} [${parts.join(", ")}] ${facts}`;
}
