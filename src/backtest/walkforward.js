// Walk-forward validation: parameters are chosen on a training window only, then frozen and
// evaluated on the following unseen test window. Windows roll forward; only the
// concatenated OUT-OF-SAMPLE results are used to judge a strategy.
import { runBacktest } from "./engine.js";

export const PARAM_GRID = {
  trend: [
    { rsiMax: 72, minRet168: 0, stopAtr: 3, trailAtr: 3, maxHoldBars: 240 },
    { rsiMax: 72, minRet168: 0, stopAtr: 4, trailAtr: 4, maxHoldBars: 240 },
    { rsiMax: 80, minRet168: 2, stopAtr: 3, trailAtr: 3, maxHoldBars: 240 },
    { rsiMax: 80, minRet168: 2, stopAtr: 4, trailAtr: 4, maxHoldBars: 480 }
  ],
  breakout: [
    { volZ: 1.5, stopAtr: 2.5, trailAtr: 3, maxHoldBars: 168 },
    { volZ: 2.0, stopAtr: 2.5, trailAtr: 3, maxHoldBars: 168 },
    { volZ: 1.5, stopAtr: 3.5, trailAtr: 4, maxHoldBars: 336 },
    { volZ: 2.0, stopAtr: 3.5, trailAtr: 4, maxHoldBars: 336 }
  ],
  pullback: [
    { rsiMax: 30, bbZ: -2, stopAtr: 2.5, maxHoldBars: 36 },
    { rsiMax: 25, bbZ: -2.2, stopAtr: 2.5, maxHoldBars: 36 },
    { rsiMax: 30, bbZ: -2, stopAtr: 3.5, maxHoldBars: 72 },
    { rsiMax: 25, bbZ: -2.2, stopAtr: 3.5, maxHoldBars: 72 }
  ]
};

const MONTH = 30.44 * 86400000;

export function makeWindows(start, end, trainMonths = 12, testMonths = 3) {
  const out = [];
  for (let s = start; s + (trainMonths + testMonths) * MONTH <= end + 7 * 86400000; s += testMonths * MONTH) {
    const trainEnd = s + trainMonths * MONTH;
    out.push({ trainStart: s, trainEnd, testStart: trainEnd, testEnd: Math.min(end, trainEnd + testMonths * MONTH) });
  }
  return out;
}

/**
 * @returns {{windows: object[], oosTrades: object[], oosEquity: number[], perStrategy: object}}
 */
export function walkForward({ assets, start, end, strategies = ["trend", "breakout", "pullback"], base, minTrainTrades = 8, onProgress }) {
  const windows = makeWindows(start, end);
  const res = { windows: [], oosTrades: [], perStrategyTrades: Object.fromEntries(strategies.map((s) => [s, []])), oosCurve: [] };
  let equity = base.startCash;
  for (const w of windows) {
    const chosen = {};
    const trainInfo = {};
    for (const s of strategies) {
      let best = null;
      for (const params of PARAM_GRID[s]) {
        const r = runBacktest({ ...base, assets, start: w.trainStart, end: w.trainEnd, enabled: [s], strategyParams: { [s]: params } });
        const m = r.metrics;
        const score = m.trades >= minTrainTrades && Number.isFinite(m.sharpe) ? m.sharpe : -Infinity;
        if (!best || score > best.score) best = { params, score, m };
      }
      const pass = best.score > 0 && best.m.profitFactor > 1;
      trainInfo[s] = { pass, sharpe: best.m.sharpe, pf: best.m.profitFactor, trades: best.m.trades, params: best.params };
      if (pass) chosen[s] = best.params;
      // per-strategy OOS (evaluated even if it failed training, to measure what selection is worth)
      const oosS = runBacktest({ ...base, assets, start: w.testStart, end: w.testEnd, enabled: [s], strategyParams: { [s]: best.params } });
      res.perStrategyTrades[s].push(...oosS.trades.map((t) => ({ ...t, passedTrain: pass })));
    }
    const enabled = Object.keys(chosen);
    let oos = null;
    if (enabled.length) {
      oos = runBacktest({ ...base, startCash: equity, assets, start: w.testStart, end: w.testEnd, enabled, strategyParams: chosen });
      res.oosTrades.push(...oos.trades);
      res.oosCurve.push(...oos.curve);
      equity = oos.metrics.endEquity;
    } else {
      // no strategy passed training -> stay in cash for this window (a valid decision)
      res.oosCurve.push({ t: w.testStart, equity }, { t: w.testEnd - 3600000, equity });
    }
    res.windows.push({ train: [new Date(w.trainStart).toISOString().slice(0, 10), new Date(w.trainEnd).toISOString().slice(0, 10)], test: [new Date(w.testStart).toISOString().slice(0, 10), new Date(w.testEnd).toISOString().slice(0, 10)], trainInfo, enabled, oos: oos ? { trades: oos.metrics.trades, netReturnPct: oos.metrics.netReturnPct, maxDD: oos.metrics.maxDrawdownPct } : { trades: 0, netReturnPct: 0, note: "cash" }, equityAfter: +equity.toFixed(4) });
    onProgress?.(res.windows.at(-1));
  }
  return res;
}
