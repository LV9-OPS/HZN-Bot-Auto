// Small, dependency-free indicator helpers. All functions only look at the
// data they are given: callers pass closed candles up to "now" (no look-ahead).

export function emaSeries(values, period) {
  const out = new Array(values.length);
  if (!values.length) return out;
  const k = 2 / (period + 1);
  // seed with SMA of the first `period` values (or fewer)
  const seedN = Math.min(period, values.length);
  let e = 0;
  for (let i = 0; i < seedN; i++) e += values[i];
  e /= seedN;
  for (let i = 0; i < values.length; i++) {
    if (i < seedN) {
      out[i] = e;
      continue;
    }
    e = values[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function trueRanges(candles) {
  return candles.map((c, i) => {
    const prevClose = i > 0 ? candles[i - 1].close : c.open;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
}

export function avg(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : NaN;
}

/** Fill missing minutes with flat zero-volume candles so window lengths mean wall-clock time. */
export function fillGaps(candles, intervalMs = 60000) {
  if (candles.length < 2) return candles.slice();
  const out = [candles[0]];
  for (let i = 1; i < candles.length; i++) {
    const prev = out[out.length - 1];
    let t = prev.start + intervalMs;
    let guard = 0;
    while (t < candles[i].start && guard++ < 1440) {
      out.push({ start: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0, synthetic: true });
      t += intervalMs;
    }
    if (candles[i].start > prev.start) out.push(candles[i]);
  }
  return out;
}

/** Keep only candles fully closed at time `now` (start + interval <= now). */
export function closedOnly(candles, now, intervalMs = 60000) {
  return candles.filter((c) => c.start + intervalMs <= now);
}
