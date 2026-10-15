// Feature engineering on CLOSED bars (oldest first). Every function returns values
// aligned with the input index and only uses data up to that index (no look-ahead).

export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let e = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { out[i] = e; continue; }
    if (!Number.isFinite(e)) {
      if (i + 1 >= period) {
        let s = 0;
        for (let j = i - period + 1; j <= i; j++) s += values[j];
        e = s / period;
      }
    } else e = v * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < values.length; i++) {
    s += values[i];
    if (i >= period) s -= values[i - period];
    if (i >= period - 1) out[i] = s / period;
  }
  return out;
}

/** Wilder RSI. */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  let g = 0, l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const up = Math.max(0, d), dn = Math.max(0, -d);
    if (i <= period) {
      g += up; l += dn;
      if (i === period) { g /= period; l /= period; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    } else {
      g = (g * (period - 1) + up) / period;
      l = (l * (period - 1) + dn) / period;
      out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
    }
  }
  return out;
}

export function atr(bars, period = 14) {
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  const out = new Array(bars.length).fill(NaN);
  let a = NaN;
  for (let i = 0; i < tr.length; i++) {
    if (i === period - 1) { a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period; out[i] = a; }
    else if (i >= period) { a = (a * (period - 1) + tr[i]) / period; out[i] = a; }
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = closes.map((_, i) => f[i] - s[i]);
  const firstValid = line.findIndex(Number.isFinite);
  const sig = new Array(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const tail = ema(line.slice(firstValid), signal);
    for (let i = 0; i < tail.length; i++) sig[firstValid + i] = tail[i];
  }
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

/** Rolling standard deviation of log returns (per bar). */
export function realizedVol(closes, period) {
  const out = new Array(closes.length).fill(NaN);
  const r = closes.map((c, i) => (i === 0 ? 0 : Math.log(c / closes[i - 1])));
  for (let i = period; i < closes.length; i++) {
    let m = 0;
    for (let j = i - period + 1; j <= i; j++) m += r[j];
    m /= period;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (r[j] - m) ** 2;
    out[i] = Math.sqrt(v / (period - 1));
  }
  return out;
}

export function rollingMax(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let m = -Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.max(m, values[j]);
    out[i] = m;
  }
  return out;
}

export function rollingMin(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let m = Infinity;
    for (let j = i - period + 1; j <= i; j++) m = Math.min(m, values[j]);
    out[i] = m;
  }
  return out;
}

/** Percentile rank of value[i] within the trailing window (0..1). */
export function rollingPercentile(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    let below = 0, n = 0;
    for (let j = i - period + 1; j <= i; j++) if (Number.isFinite(values[j])) { n++; if (values[j] <= v) below++; }
    out[i] = n ? below / n : NaN;
  }
  return out;
}

/**
 * Compute the full feature set for a bar series. Returns column arrays.
 * Bars: [{t, open, high, low, close, volume}] closed, regular timeframe.
 */
export function computeFeatureSet(bars) {
  const c = bars.map((b) => b.close);
  const v = bars.map((b) => b.volume);
  const m = macd(c);
  const vol24 = realizedVol(c, 24);
  const volMean = sma(v, 24 * 7);
  return {
    close: c,
    ema20: ema(c, 20),
    ema50: ema(c, 50),
    ema200: ema(c, 200),
    rsi14: rsi(c, 14),
    atr14: atr(bars, 14),
    macdHist: m.hist,
    vol24,
    volPct90d: rollingPercentile(vol24, 24 * 90),
    hi55: rollingMax(bars.map((b) => b.high), 55),
    lo20: rollingMin(bars.map((b) => b.low), 20),
    bbMid: sma(c, 20),
    bbStd: c.map((_, i) => {
      if (i < 19) return NaN;
      let s = 0, q = 0;
      for (let j = i - 19; j <= i; j++) { s += c[j]; q += c[j] * c[j]; }
      const mu = s / 20;
      return Math.sqrt(Math.max(0, q / 20 - mu * mu));
    }),
    volZ: v.map((x, i) => (Number.isFinite(volMean[i]) && volMean[i] > 0 ? x / volMean[i] : NaN)),
    ret24: c.map((x, i) => (i >= 24 ? (x / c[i - 24] - 1) * 100 : NaN)),
    ret168: c.map((x, i) => (i >= 168 ? (x / c[i - 168] - 1) * 100 : NaN)),
    ret1: c.map((x, i) => (i >= 1 ? (x / c[i - 1] - 1) * 100 : NaN))
  };
}
