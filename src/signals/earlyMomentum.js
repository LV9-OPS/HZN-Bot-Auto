// Stage B - early-movement features from CLOSED 1-minute candles.
// The goal is to describe the transition "quiet -> price + volume picking up",
// not to find whatever already rose the most.
import { emaSeries, trueRanges, avg, fillGaps } from "./indicators.js";
import { pct } from "../util/num.js";

export const MIN_CANDLES = 75;

const slice = (arr, from, to) => arr.slice(Math.max(0, from), Math.max(0, to + 1)); // inclusive indices

/**
 * @param {Array} rawCandles closed 1m candles (oldest first)
 * @returns {object|null} features, or null when there is not enough data
 */
export function computeFeatures(rawCandles) {
  const candles = fillGaps(rawCandles);
  if (candles.length < MIN_CANDLES) return null;
  const c = candles.map((k) => k.close);
  const h = candles.map((k) => k.high);
  const l = candles.map((k) => k.low);
  const v = candles.map((k) => k.volume);
  const t = candles.length - 1;
  const last = candles[t];
  const tiny = 1e-12;

  const r = (k) => pct(c[t], c[t - k]);
  const ret1 = r(1), ret3 = r(3), ret5 = r(5), ret15 = r(15), ret60 = r(60);
  const prevRet3 = pct(c[t - 3], c[t - 6]);
  const prevRet5 = pct(c[t - 5], c[t - 10]);
  const accel3 = ret3 / 3 - prevRet3 / 3; // %/min slope increase
  const accel5 = ret5 - prevRet5;

  // Volume vs a 60-minute baseline that EXCLUDES the last 5 minutes.
  const baseVol = slice(v, t - 65, t - 6);
  const baseMean = avg(baseVol);
  const baseActiveShare = baseVol.filter((x) => x > 0).length / Math.max(1, baseVol.length);
  const recent5 = avg(slice(v, t - 4, t));
  const relVol5 = baseMean > tiny ? recent5 / baseMean : recent5 > 0 ? 10 : 0;
  const relVol1 = baseMean > tiny ? v[t] / baseMean : v[t] > 0 ? 10 : 0;
  const prior3 = avg(slice(v, t - 5, t - 3));
  const last3 = avg(slice(v, t - 2, t));
  const volAccel = prior3 > tiny ? last3 / prior3 : last3 > 0 ? 10 : 0;
  const recentQuoteVolume = slice(candles, t - 4, t).reduce((s, k) => s + k.volume * k.close, 0);

  // Stability before the move: range and drift of minutes t-35..t-6.
  const baseHigh = Math.max(...slice(h, t - 35, t - 6));
  const baseLow = Math.min(...slice(l, t - 35, t - 6));
  const baseRangePct = pct(baseHigh, baseLow);
  const baseDriftPct = pct(c[t - 6], c[t - 35]);

  // Volatility expansion
  const tr = trueRanges(candles);
  const atrBase = avg(slice(tr, t - 35, t - 6));
  const atr5 = avg(slice(tr, t - 4, t));
  const atr14 = avg(slice(tr, t - 13, t));
  const volExpansion = atrBase > tiny ? atr5 / atrBase : atr5 > 0 ? 10 : 1;

  // Breakout above the previous 30-minute high (current candle excluded).
  const priorHigh = Math.max(...slice(h, t - 30, t - 1));
  const breakoutPct = pct(c[t], priorHigh);
  const range = last.high - last.low;
  const closeLocation = range > 0 ? (last.close - last.low) / range : 1;
  const upperWickShare = range > 0 ? (last.high - Math.max(last.open, last.close)) / range : 0;
  const breakoutConfirmed = c[t] > priorHigh && closeLocation >= 0.5;
  const wickRejection = h[t] > priorHigh && c[t] <= priorHigh; // poked above, closed back below
  const high5 = Math.max(...slice(h, t - 4, t));
  const moveUp5 = high5 - c[t - 5];
  const retraceShare = moveUp5 > 0 ? (high5 - c[t]) / moveUp5 : 0; // how much of the burst was given back
  const fading = moveUp5 > 0 && retraceShare > 0.5 && ret5 > 0;

  // Position in the 60-minute range
  const hi60 = Math.max(...slice(h, t - 59, t));
  const lo60 = Math.min(...slice(l, t - 59, t));
  const rangePos60 = hi60 > lo60 ? (c[t] - lo60) / (hi60 - lo60) : 0.5;

  // Trend
  const ema9 = emaSeries(c, 9);
  const ema21 = emaSeries(c, 21);
  const emaGapPct = pct(ema9[t], ema21[t]);
  const ema9SlopePct = pct(ema9[t], ema9[t - 3]);
  const ema21SlopePct = pct(ema21[t], ema21[t - 5]);

  // Extension (has most of the move already happened?)
  const low30 = Math.min(...slice(l, t - 30, t));
  const moveFromLowPct = pct(c[t], low30);
  const distEma21Atr = atr14 > tiny ? (c[t] - ema21[t]) / atr14 : 0; // informational: huge right after a tight base
  const distEma21Pct = pct(c[t], ema21[t]);

  return {
    at: last.start,
    close: c[t],
    ret1, ret3, ret5, ret15, ret60, prevRet3, prevRet5, accel3, accel5,
    baseMeanVolume: baseMean, baseActiveShare, relVol1, relVol5, volAccel, recentQuoteVolume,
    baseRangePct, baseDriftPct,
    atr14Pct: (atr14 / c[t]) * 100, volExpansion,
    priorHigh, breakoutPct, breakoutConfirmed, wickRejection, closeLocation, upperWickShare, retraceShare, fading,
    rangePos60,
    emaGapPct, ema9SlopePct, ema21SlopePct,
    moveFromLowPct, distEma21Atr, distEma21Pct,
    syntheticShare: candles.slice(-60).filter((k) => k.synthetic || k.volume === 0).length / 60
  };
}
