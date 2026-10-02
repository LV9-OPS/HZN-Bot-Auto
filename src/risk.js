export function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
export function assertSafety() {
  const mode = process.env.BOT_MODE || "paper";
  const maxTrade = envNumber("MAX_TRADE_QUOTE", 10);
  const maxPositions = Math.max(1, Math.floor(envNumber("MAX_OPEN_POSITIONS", 1)));
  if (!["paper", "live"].includes(mode)) throw new Error("BOT_MODE must be paper or live.");
  if (maxTrade <= 0 || maxTrade > 10) throw new Error("MAX_TRADE_QUOTE must be > 0 and <= 10.");
  if (maxPositions !== 1) throw new Error("v1 supports exactly one open position.");
  if (envNumber("STOP_LOSS_PCT", 3) <= 0) throw new Error("STOP_LOSS_PCT must be positive.");
  if (envNumber("TAKE_PROFIT_PCT", 10) <= 0) throw new Error("TAKE_PROFIT_PCT must be positive.");
  if (envNumber("TRAILING_ACTIVATION_PCT", 5) <= 0) throw new Error("TRAILING_ACTIVATION_PCT must be positive.");
  if (envNumber("MAX_DAILY_LOSS_QUOTE", 2) <= 0) throw new Error("MAX_DAILY_LOSS_QUOTE must be positive.");
  return { mode, maxTrade, maxPositions };
}
export function dayKey() { return new Date().toISOString().slice(0, 10); }
export function resetDailyState(state) {
  const today = dayKey();
  if (state.day !== today) { state.day = today; state.realizedPnl = 0; state.trades = []; }
  return state;
}
export function canTrade(state) { return state.realizedPnl > -envNumber("MAX_DAILY_LOSS_QUOTE", 2); }
export function roundDown(value, step) {
  if (!step || step <= 0) return value;
  const decimals = Math.max(0, (String(step).split(".")[1] || "").length);
  const factor = 10 ** decimals;
  return Math.floor(value * factor + 1e-12) / factor;
}
export function quoteToBase(quote, price, baseStep) { return roundDown(quote / price, Number(baseStep)); }