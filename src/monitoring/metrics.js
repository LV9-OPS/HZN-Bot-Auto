// Performance metrics derived from state (all net of fees).

export function performance(state, priceOf, cfg) {
  const s = state.stats;
  const open = Object.values(state.positions).filter((p) => p.status === "open" || p.status === "closing");
  let unrealized = 0;
  let exposure = 0;
  const byAsset = {};
  for (const p of open) {
    const tk = priceOf(p.symbol);
    const share = p.initialQty > 0 ? p.qty / p.initialQty : 1;
    const cost = p.costBasisQuote * share;
    exposure += cost;
    byAsset[p.symbol] = (byAsset[p.symbol] || 0) + cost;
    if (tk?.bid > 0) unrealized += p.qty * tk.bid * (1 - cfg.TAKER_FEE_PCT / 100) - cost;
  }
  const decided = s.wins + s.losses;
  return {
    realizedNetPnl: s.realizedNetPnl,
    unrealizedNetPnl: unrealized,
    totalNetPnl: s.realizedNetPnl + unrealized,
    totalFees: s.totalFees,
    trades: s.trades,
    winRate: decided ? s.wins / decided : null,
    avgWin: s.wins ? s.sumWin / s.wins : null,
    avgLoss: s.losses ? s.sumLoss / s.losses : null,
    maxDrawdown: s.maxDrawdown,
    exposure,
    exposureByAsset: byAsset,
    dailyRealized: state.daily.realizedNetPnl,
    dailyEntries: state.daily.entries
  };
}
