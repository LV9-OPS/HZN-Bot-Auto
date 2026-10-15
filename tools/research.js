// npm run research -- [--dir data/history-binance-1h] [--out docs/research-results.json]
// Full validation run: walk-forward (12m train / 3m test, rolling) for every candidate
// strategy, baselines (cash, BTC buy-and-hold, equal-weight buy-and-hold), metrics per
// regime, cost sensitivity and parameter sensitivity. Writes a JSON report and a
// strategy-validation file used by the live bot (only validated strategies may trade).
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, buildConfig } from "../src/config/index.js";
import { arg } from "../src/cli/common.js";
import { computeFeatureSet } from "../src/quant/features.js";
import { runBacktest, buyAndHold } from "../src/backtest/engine.js";
import { walkForward, PARAM_GRID } from "../src/backtest/walkforward.js";
import { computeMetrics, tStat } from "../src/backtest/metrics.js";

loadEnvFile();
const cfg = buildConfig({ ...process.env, BOT_MODE: "paper" });
const dir = path.resolve(arg("dir", path.join(cfg.dataDir, "history-binance-1h")));
const out = path.resolve(arg("out", path.join(cfg.dataDir, "research-results.json")));
const spreadOverride = arg("spread") ? Number(arg("spread")) : null;
const maxSpread = Number(arg("max-spread", cfg.MAX_SPREAD_PCT));

// Revolut X execution spreads (snapshot from npm run fetch-history), default 0.3%
let revx = {};
try {
  const m = JSON.parse(fs.readFileSync(path.join(cfg.dataDir, "history", "meta.json"), "utf8"));
  for (const a of m.assets) revx[a.base] = a.execSpreadPct;
} catch { /* none */ }

const assets = {};
const excluded = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && x !== "meta.json")) {
  const base = f.replace(".json", "");
  const spreadPct = spreadOverride ?? revx[base] ?? 0.3;
  if (base !== "BTC" && spreadPct > maxSpread) { excluded.push(`${base} (Revolut X spread ${spreadPct.toFixed(2)}%)`); continue; }
  const rows = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const bars = rows.map((r) => ({ t: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[6] ?? r[5] })).filter((b) => b.close > 0);
  if (bars.length < 24 * 120) { excluded.push(`${base} (history < 120 days)`); continue; }
  assets[base] = { bars, f: computeFeatureSet(bars), spreadPct };
}
console.log(`assets: ${Object.keys(assets).join(", ")}`);
console.log(`excluded: ${excluded.join(", ") || "none"}`);
const btc = assets.BTC.bars;
const start = btc[0].t + 120 * 86400000; // warm-up for EMA200 / 90-day vol percentile
const end = btc[btc.length - 1].t;
const base = { startCash: 10, budget: cfg.MAX_TRADING_BUDGET_QUOTE, takerFeePct: cfg.TAKER_FEE_PCT, slippagePct: cfg.EST_SLIPPAGE_PCT };

const t0 = Date.now();
const wf = walkForward({ assets, start, end, base, onProgress: (w) => process.stdout.write(`  window ${w.test[0]}..${w.test[1]} enabled=[${w.enabled}] oos ${w.oos.netReturnPct}% (${w.oos.trades} trades) equity ${w.equityAfter}\n`) });
const oosStart = Date.parse(wf.windows[0].test[0]);
const oosMetrics = computeMetrics({ trades: wf.oosTrades, curve: wf.oosCurve, startEquity: base.startCash, exposureHours: 0, totalHours: 0 });
const perStrategy = {};
for (const [s, tr] of Object.entries(wf.perStrategyTrades)) {
  const all = tr, sel = tr.filter((t) => t.passedTrain);
  const summ = (x) => ({ trades: x.length, winRate: x.length ? +(x.filter((t) => t.pnl > 0).length / x.length).toFixed(3) : null, meanNetPct: x.length ? +(x.reduce((a, t) => a + t.pnlPct, 0) / x.length).toFixed(3) : null, tStat: +(tStat(x) || 0).toFixed(2), netPnl: +x.reduce((a, t) => a + t.pnl, 0).toFixed(4), profitFactor: (() => { const w = x.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), l = -x.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0); return l > 0 ? +(w / l).toFixed(3) : null; })() });
  perStrategy[s] = { allWindows: summ(all), windowsPassingTrain: summ(sel) };
}
// Baselines over the same out-of-sample span
const baselines = {
  cash: { netReturnPct: 0, maxDrawdownPct: 0 },
  btcBuyHold: buyAndHold({ asset: assets.BTC, start: oosStart, end, startCash: 10, takerFeePct: base.takerFeePct, slippagePct: base.slippagePct })
};
const eqw = Object.entries(assets).map(([n, a]) => ({ n, m: buyAndHold({ asset: a, start: Math.max(oosStart, a.bars[0].t), end, startCash: 10 }) })).filter((x) => x.m);
baselines.equalWeightBuyHold = { meanNetReturnPct: +(eqw.reduce((s, x) => s + x.m.netReturnPct, 0) / eqw.length).toFixed(2), assets: eqw.length, note: "each asset bought at its first available bar in the OOS span" };

// Parameter + cost sensitivity on the full period (in-sample, for robustness only)
const sensitivity = {};
for (const s of Object.keys(PARAM_GRID)) {
  sensitivity[s] = PARAM_GRID[s].map((p) => {
    // drawdown halt disabled here: we want the raw sensitivity of each parameter set over the full period
    const m = runBacktest({ ...base, assets, start, end, enabled: [s], strategyParams: { [s]: p }, riskParams: { maxDrawdownPct: 100 } }).metrics;
    return { params: p, trades: m.trades, netReturnPct: m.netReturnPct, sharpe: m.sharpe, pf: m.profitFactor, maxDD: m.maxDrawdownPct };
  });
}
const costSensitivity = {};
for (const sp of [0.1, 0.2, 0.4]) {
  const a2 = Object.fromEntries(Object.entries(assets).map(([n, a]) => [n, { ...a, spreadPct: sp }]));
  costSensitivity[`spread_${sp}`] = Object.fromEntries(Object.keys(PARAM_GRID).map((s) => {
    const m = runBacktest({ ...base, assets: a2, start, end, enabled: [s], strategyParams: { [s]: PARAM_GRID[s][1] }, riskParams: { maxDrawdownPct: 100 } }).metrics;
    return [s, { netReturnPct: m.netReturnPct, pf: m.profitFactor, trades: m.trades }];
  }));
}

// Validation verdict: a strategy may trade live only with robust OUT-OF-SAMPLE evidence
const verdict = {};
for (const [s, r] of Object.entries(perStrategy)) {
  const x = r.windowsPassingTrain;
  const validated = x.trades >= 30 && x.meanNetPct > 0 && x.profitFactor > 1.1 && x.tStat >= 2;
  verdict[s] = { validated, meanNetPct: x.meanNetPct, n: x.trades, profitFactor: x.profitFactor, tStat: x.tStat, rule: "OOS trades>=30, mean net>0, PF>1.1, t>=2" };
}
const report = {
  generatedAt: new Date().toISOString(), runtimeSec: Math.round((Date.now() - t0) / 1000), data: { source: dir, from: new Date(start).toISOString(), to: new Date(end).toISOString(), assets: Object.keys(assets), excluded },
  assumptions: { startCash: 10, budget: base.budget, takerFeePct: base.takerFeePct, slippagePct: base.slippagePct, spreads: Object.fromEntries(Object.entries(assets).map(([n, a]) => [n, a.spreadPct])), bars: "1h Binance spot (price reference) - execution costs modelled with Revolut X spreads/fees" },
  walkForward: { windows: wf.windows, oos: oosMetrics }, perStrategy, baselines, sensitivity, costSensitivity, verdict
};
fs.writeFileSync(out, JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(cfg.dataDir, "strategy-validation.json"), JSON.stringify({ generatedAt: report.generatedAt, verdict }, null, 2));
const { byRegime, byStrategy, ...head } = oosMetrics;
console.log("\nOUT-OF-SAMPLE (walk-forward, combined):", JSON.stringify(head));
console.log("by regime:", JSON.stringify(byRegime));
console.log("per strategy:", JSON.stringify(perStrategy));
console.log("baselines:", JSON.stringify({ btc: baselines.btcBuyHold && { ret: baselines.btcBuyHold.netReturnPct, dd: baselines.btcBuyHold.maxDrawdownPct, sharpe: baselines.btcBuyHold.sharpe }, eqw: baselines.equalWeightBuyHold }));
console.log("verdict:", JSON.stringify(verdict));
console.log(`report: ${out} (${report.runtimeSec}s)`);
process.exit(0);
