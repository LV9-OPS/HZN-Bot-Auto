function num(v) { return Number(v || 0); }
const feePct = () => num(process.env.ESTIMATED_FEE_PCT || 0.09);
export function evaluate(candidate) {
  const m = candidate.metrics;
  const checks = { change15m: m.change15m >= 2, change60m: m.change60m >= 4, change24h: m.change24h >= 1, spread: m.spread <= 1, volume: m.quoteVolume >= 100000 };
  const passed = Object.values(checks).filter(Boolean).length;
  const entryScore = m.score + (checks.change15m ? 10 : 0) + (checks.change60m ? 10 : 0);
  return { symbol: candidate.ticker.symbol.replace("/", "-"), price: num(candidate.ticker.last_price), bid: num(candidate.ticker.bid), ask: num(candidate.ticker.ask), score: entryScore, passed, checks, signal: passed >= 5 && entryScore >= 80 };
}
export function netTargetPrice(position) {
  const targetNetPct = num(process.env.NET_PROFIT_TARGET_PCT || 10);
  const exitFeePct = feePct();
  const entryFeeQuote = num(position.entryFeeQuote) || num(position.quoteSize) * feePct() / 100;
  const cost = num(position.quoteSize) + entryFeeQuote;
  const baseSize = num(position.baseSize);
  if (!baseSize) return 0;
  return (cost * (1 + targetNetPct / 100)) / (baseSize * (1 - exitFeePct / 100));
}
export function exitDecision(position, price) {
  const pnlPct = ((price - position.entryPrice) / position.entryPrice) * 100;
  const newHigh = Math.max(position.highWatermark || position.entryPrice, price);
  const activation = num(process.env.TRAILING_ACTIVATION_PCT || 5);
  const trail = num(process.env.TRAILING_STOP_PCT || 2);
  const targetPct = num(process.env.TAKE_PROFIT_PCT || 10);
  const targetPrice = position.entryPrice * (1 + targetPct / 100);
  let reason = null;
  if (pnlPct <= -num(process.env.STOP_LOSS_PCT || 3)) reason = "STOP_LOSS";
  else if (targetPrice > 0 && price >= targetPrice) reason = "TAKE_PROFIT";
  else if (pnlPct >= activation && price <= newHigh * (1 - trail / 100)) reason = "TRAILING_STOP";
  return { reason, pnlPct, highWatermark: newHigh, targetPrice, estimatedFeePct: feePct(), targetPct };
}
