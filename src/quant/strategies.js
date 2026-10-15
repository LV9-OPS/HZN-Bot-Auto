// Candidate strategies on 1-hour CLOSED bars. Each is a pure function returning an entry
// signal with an explainable heuristic score (NOT a calibrated probability), an ATR-based
// stop, an exit policy and the regimes it is allowed to trade in.
//
// Evidence base (see docs/RESEARCH_2016_2026.md):
//  - trend / time-series momentum: Liu & Tsyvinski (RFS 2021) report strong time-series
//    momentum in crypto; Hudson & Urquhart (2019) find technical rules profitable after
//    data-snooping corrections, but not for BTC out of sample.
//  - breakout: Donchian channel breakouts are the classic trend-following rule.
//  - pullback mean reversion in an uptrend: short-horizon reversal is documented in crypto
//    (Kitron & Wengrowicz 2026) but tiny at 15m and gone by 4h, i.e. NOT exploitable at spot
//    taker costs; tested here at 1h with larger dips only as a hypothesis.

export const STRATEGY_DEFAULTS = Object.freeze({
  trend: { rsiMax: 72, minRet168: 0, stopAtr: 3, trailAtr: 3, maxHoldBars: 24 * 10 },
  breakout: { volZ: 1.5, stopAtr: 2.5, trailAtr: 3, maxHoldBars: 24 * 7 },
  pullback: { rsiMax: 30, bbZ: -2, stopAtr: 2.5, targetToEma20: true, maxHoldBars: 36 }
});

const ok = (x) => Number.isFinite(x);

export const STRATEGIES = {
  /** Time-series momentum / trend following. */
  trend: {
    name: "trend",
    allowed: (r) => !r.extreme && !r.stress && r.trend === "up" && r.marketTrend !== "down",
    signal(f, i, p = STRATEGY_DEFAULTS.trend) {
      const c = f.close[i];
      const reasons = [];
      if (![f.ema20[i], f.ema50[i], f.ema200[i], f.rsi14[i], f.atr14[i], f.ret168[i]].every(ok)) return null;
      const aligned = f.ema20[i] > f.ema50[i] && f.ema50[i] > f.ema200[i] && c > f.ema20[i];
      const freshCross = f.ema20[i - 1] <= f.ema50[i - 1] || f.close[i - 1] <= f.ema20[i - 1]; // enter on (re)activation, not mid-run
      if (!aligned || !freshCross) return null;
      if (f.ret168[i] <= p.minRet168) return null;
      if (f.rsi14[i] > p.rsiMax) return null;
      reasons.push(`EMA20>EMA50>EMA200, close>EMA20 (re-entry)`, `7d +${f.ret168[i].toFixed(1)}%`, `RSI ${f.rsi14[i].toFixed(0)}`);
      const score = 50 + Math.min(25, f.ret168[i]) + (f.macdHist[i] > 0 ? 10 : 0) - Math.max(0, f.rsi14[i] - 60);
      return { strategy: "trend", score, stopPct: (p.stopAtr * f.atr14[i] / c) * 100, trailAtr: p.trailAtr, targetPct: 0, maxHoldBars: p.maxHoldBars, exitOnSignal: "ema20_below_ema50", reasons };
    }
  },

  /** Donchian 55-bar breakout with volume confirmation. */
  breakout: {
    name: "breakout",
    allowed: (r) => !r.extreme && !r.stress && r.trend !== "down" && r.marketTrend !== "down",
    signal(f, i, p = STRATEGY_DEFAULTS.breakout) {
      const c = f.close[i];
      if (![f.hi55[i - 1], f.atr14[i], f.volZ[i], f.ema200[i]].every(ok)) return null;
      if (!(c > f.hi55[i - 1])) return null; // close above the PREVIOUS 55-bar high
      if (f.close[i - 1] > f.hi55[i - 2]) return null; // only the first breakout bar
      if (!(f.volZ[i] >= p.volZ)) return null;
      if (c < f.ema200[i]) return null;
      const ext = ((c - f.hi55[i - 1]) / f.atr14[i]);
      if (ext > 1.5) return null; // already far above the level: false-breakout / chase risk
      const reasons = [`close > 55h high`, `volume x${f.volZ[i].toFixed(1)}`, `${ext.toFixed(2)} ATR above level`];
      const score = 50 + Math.min(20, (f.volZ[i] - 1) * 10) + (f.macdHist[i] > 0 ? 10 : 0) - ext * 10;
      return { strategy: "breakout", score, stopPct: (p.stopAtr * f.atr14[i] / c) * 100, trailAtr: p.trailAtr, targetPct: 0, maxHoldBars: p.maxHoldBars, exitOnSignal: "close_below_ema20", reasons };
    }
  },

  /** Oversold pullback inside an uptrend; target = return to the 20-bar mean. */
  pullback: {
    name: "pullback",
    allowed: (r) => !r.extreme && !r.stress && r.trend === "up" && r.vol !== "high",
    signal(f, i, p = STRATEGY_DEFAULTS.pullback) {
      const c = f.close[i];
      if (![f.rsi14[i], f.bbMid[i], f.bbStd[i], f.atr14[i], f.ema200[i]].every(ok) || f.bbStd[i] <= 0) return null;
      const z = (c - f.bbMid[i]) / f.bbStd[i];
      if (!(f.rsi14[i] <= p.rsiMax && z <= p.bbZ)) return null;
      if (c < f.ema200[i]) return null;
      const targetPct = ((f.bbMid[i] - c) / c) * 100;
      const reasons = [`RSI ${f.rsi14[i].toFixed(0)}`, `Bollinger z ${z.toFixed(2)}`, `above EMA200`, `mean +${targetPct.toFixed(2)}%`];
      const score = 50 + Math.min(25, (p.rsiMax - f.rsi14[i]) * 2) + Math.min(15, (-z - 2) * 10);
      return { strategy: "pullback", score, stopPct: (p.stopAtr * f.atr14[i] / c) * 100, trailAtr: 0, targetPct, maxHoldBars: p.maxHoldBars, exitOnSignal: null, reasons };
    }
  }
};

/** Exit-on-signal rules evaluated at bar close. */
export function signalExit(rule, f, i) {
  if (rule === "ema20_below_ema50") return f.ema20[i] < f.ema50[i];
  if (rule === "close_below_ema20") return f.close[i] < f.ema20[i];
  return false;
}
