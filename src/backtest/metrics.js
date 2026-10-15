// Performance metrics. Everything is net of fees, spread and slippage.

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const std = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

/** Daily returns from an hourly equity curve [{t, equity}]. */
export function dailyReturns(curve) {
  const byDay = new Map();
  for (const p of curve) byDay.set(Math.floor(p.t / 86400000), p.equity);
  const vals = [...byDay.values()];
  const r = [];
  for (let i = 1; i < vals.length; i++) r.push(vals[i] / vals[i - 1] - 1);
  return r;
}

export function monthlyReturns(curve) {
  const byMonth = new Map();
  for (const p of curve) {
    const d = new Date(p.t);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    if (!byMonth.has(k)) byMonth.set(k, { first: p.equity, last: p.equity });
    byMonth.get(k).last = p.equity;
  }
  const out = [];
  let prevLast = null;
  for (const [k, v] of byMonth) {
    const start = prevLast ?? v.first;
    out.push({ month: k, retPct: (v.last / start - 1) * 100 });
    prevLast = v.last;
  }
  return out;
}

export function maxDrawdownPct(curve) {
  let peak = -Infinity, mdd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    mdd = Math.max(mdd, (peak - p.equity) / peak);
  }
  return mdd * 100;
}

export function computeMetrics({ trades, curve, startEquity, exposureHours = 0, totalHours = 0, exposureSum = 0 }) {
  const pnl = trades.map((t) => t.pnl);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const dr = dailyReturns(curve);
  const downside = dr.filter((x) => x < 0);
  const endEquity = curve.length ? curve[curve.length - 1].equity : startEquity;
  const months = monthlyReturns(curve);
  const byRegime = {};
  const byStrategy = {};
  for (const t of trades) {
    for (const [key, bucket] of [[t.regime || "n/a", byRegime], [t.strategy || "n/a", byStrategy]]) {
      const b = (bucket[key] ||= { n: 0, wins: 0, pnl: 0, pnlPct: [] });
      b.n++; if (t.pnl > 0) b.wins++; b.pnl += t.pnl; b.pnlPct.push(t.pnlPct);
    }
  }
  const fin = (o) => Object.fromEntries(Object.entries(o).map(([k, b]) => [k, { trades: b.n, winRate: +(b.wins / b.n).toFixed(3), netPnl: +b.pnl.toFixed(4), meanTradePct: +mean(b.pnlPct).toFixed(3) }]));
  const sharpe = std(dr) > 0 ? (mean(dr) / std(dr)) * Math.sqrt(365) : NaN;
  const sortinoDen = Math.sqrt(mean(downside.map((x) => x * x)) || 0);
  return {
    startEquity,
    endEquity: +endEquity.toFixed(4),
    netReturnPct: +((endEquity / startEquity - 1) * 100).toFixed(3),
    trades: trades.length,
    winRate: trades.length ? +(wins.length / trades.length).toFixed(3) : null,
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(3) : wins.length ? Infinity : null,
    expectancyQuote: trades.length ? +mean(pnl).toFixed(5) : null,
    expectancyPct: trades.length ? +mean(trades.map((t) => t.pnlPct)).toFixed(3) : null,
    tradePctStd: trades.length > 1 ? +std(trades.map((t) => t.pnlPct)).toFixed(3) : null,
    sharpe: Number.isFinite(sharpe) ? +sharpe.toFixed(3) : null,
    sortino: sortinoDen > 0 ? +((mean(dr) / sortinoDen) * Math.sqrt(365)).toFixed(3) : null,
    maxDrawdownPct: +maxDrawdownPct(curve).toFixed(3),
    timeInMarketPct: totalHours ? +((exposureHours / totalHours) * 100).toFixed(2) : null,
    avgExposureQuote: totalHours ? +(exposureSum / totalHours).toFixed(4) : null,
    maxExposureQuote: trades.length ? +Math.max(...trades.map((t) => t.cost)).toFixed(4) : 0,
    totalCostsQuote: +trades.reduce((s, t) => s + (t.costs || 0), 0).toFixed(4),
    avgHoldHours: trades.length ? +mean(trades.map((t) => t.holdHours)).toFixed(1) : null,
    months: months.length,
    monthlyMeanPct: months.length ? +mean(months.map((m) => m.retPct)).toFixed(3) : null,
    monthsAbove5Pct: months.filter((m) => m.retPct >= 5).length,
    monthsBelowMinus3Pct: months.filter((m) => m.retPct <= -3).length,
    worstMonthPct: months.length ? +Math.min(...months.map((m) => m.retPct)).toFixed(3) : null,
    byRegime: fin(byRegime),
    byStrategy: fin(byStrategy)
  };
}

/** t-statistic of the mean trade return (rough significance check). */
export function tStat(trades) {
  const x = trades.map((t) => t.pnlPct);
  const s = std(x);
  return x.length > 1 && s > 0 ? mean(x) / (s / Math.sqrt(x.length)) : NaN;
}
