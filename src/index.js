import { scan } from "./scanner.js";

const MODE = process.env.BOT_MODE || "paper";
const MAX_TRADE_QUOTE = Number(process.env.MAX_TRADE_QUOTE || 10);
const TAKE_PROFIT_PCT = Number(process.env.TAKE_PROFIT_PCT || 10);
const STOP_LOSS_PCT = Number(process.env.STOP_LOSS_PCT || 3);

function log(message, data = undefined) {
  console.log(new Date().toISOString(), message, data ?? "");
}

function assertSafety() {
  if (MAX_TRADE_QUOTE > 10) {
    throw new Error("Safety limit exceeded: MAX_TRADE_QUOTE cannot exceed 10.");
  }
  if (MODE !== "paper") {
    throw new Error("Live execution is disabled in v0.1.0. Use BOT_MODE=paper.");
  }
}

async function main() {
  assertSafety();
  log("HZN Bot Auto starting", {
    mode: MODE,
    maxTradeQuote: MAX_TRADE_QUOTE,
    stopLossPct: STOP_LOSS_PCT,
    takeProfitPct: TAKE_PROFIT_PCT
  });

  const candidates = await scan();
  if (!candidates.length) {
    log("No qualifying momentum candidates.");
    return;
  }

  for (const { ticker, metrics } of candidates.slice(0, 5)) {
    log("PAPER SIGNAL", {
      symbol: ticker.symbol,
      price: ticker.last_price,
      momentum24hPct: Number(metrics.change24h.toFixed(2)),
      score: metrics.score,
      simulatedOrderQuote: MAX_TRADE_QUOTE,
      stopLossPct: STOP_LOSS_PCT,
      takeProfitPct: TAKE_PROFIT_PCT
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
