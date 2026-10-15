// Numeric helpers. Exchange values arrive as decimal strings; we parse them
// strictly so that malformed data is detected instead of silently becoming 0.

/** Parse a finite number. Returns NaN for missing/garbage input (never 0 by accident). */
export function toNum(value) {
  if (value === null || value === undefined || value === "") return NaN;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : NaN;
}

export function isPos(n) {
  return Number.isFinite(n) && n > 0;
}

/** Number of decimals in a step string like "0.0001" or "1e-8". */
export function stepDecimals(step) {
  const s = String(step);
  if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]) + ((s.split(/e-/i)[0].split(".")[1] || "").length);
  return (s.split(".")[1] || "").replace(/0+$/, "").length;
}

/** Floor a value to a step and format it as a string with the step's precision. */
export function floorToStep(value, step) {
  const st = toNum(step);
  if (!isPos(st)) throw new Error("floorToStep: invalid step " + step);
  if (!Number.isFinite(value) || value <= 0) return "0";
  const decimals = stepDecimals(step);
  const units = Math.floor(value / st + 1e-9);
  return (units * st).toFixed(decimals);
}

/** Ceil a value to a step. */
export function ceilToStep(value, step) {
  const st = toNum(step);
  if (!isPos(st)) throw new Error("ceilToStep: invalid step " + step);
  const decimals = stepDecimals(step);
  const units = Math.ceil(value / st - 1e-9);
  return (units * st).toFixed(decimals);
}

/** Count decimals in a price string as published by the exchange ("1.3154" -> 4). */
export function priceDecimals(str) {
  const s = String(str ?? "");
  if (!s.includes(".")) return 0;
  return s.split(".")[1].length;
}

export function roundTo(value, decimals) {
  return Number(value.toFixed(decimals));
}

export function pct(a, b) {
  // percentage change from b to a
  return b > 0 ? ((a - b) / b) * 100 : NaN;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Linear ramp: 0 at lo, 1 at hi (works for lo > hi as an inverse ramp). */
export function ramp(x, lo, hi) {
  if (!Number.isFinite(x)) return 0;
  if (lo === hi) return x >= hi ? 1 : 0;
  return clamp((x - lo) / (hi - lo), 0, 1);
}

export function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function fmt(n, d = 4) {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) > 0 && Math.abs(n) < 0.001) return n.toPrecision(4);
  return n.toFixed(d);
}
