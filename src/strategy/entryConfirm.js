// Stage D - last check right before an order is sent, on FRESH data.
import { floorToStep, toNum, fmt, priceDecimals, ceilToStep } from "../util/num.js";

/**
 * @param {object} a
 *  signal: { symbol, createdAt, execAskAtSignal }
 *  ticker: fresh execution ticker { bid, ask, spreadPct, ts, valid, askRaw, bidRaw }
 *  book: optional order book { asks:[{price,qty}] }
 *  pair: pair config
 *  allocationQuote: USDC to deploy
 *  now, cfg
 * @returns {{ ok: boolean, reasons: object[], order?: object, costs?: object }}
 */
export function confirmEntry({ signal, ticker, book, pair, allocationQuote, now, cfg }) {
  const reasons = [];
  const no = (code, detail) => reasons.push({ code, detail });

  if (now - signal.createdAt > cfg.SIGNAL_MAX_AGE_MS) no("stale_signal", `signal age ${Math.round((now - signal.createdAt) / 1000)}s > ${cfg.SIGNAL_MAX_AGE_MS / 1000}s`);
  if (!ticker || !ticker.valid) {
    no("no_quote", "no valid fresh bid/ask");
    return { ok: false, reasons };
  }
  if (now - ticker.ts > cfg.PRICE_MAX_AGE_MS) no("stale_quote", `quote age ${Math.round((now - ticker.ts) / 1000)}s`);
  if (!pair || pair.status !== "active") no("pair_inactive", "pair not active");
  if (ticker.spreadPct > cfg.MAX_SPREAD_PCT) no("spread_too_wide", `spread ${fmt(ticker.spreadPct, 3)}% > ${cfg.MAX_SPREAD_PCT}%`);
  const chase = ((ticker.ask - signal.execAskAtSignal) / signal.execAskAtSignal) * 100;
  if (chase > cfg.MAX_CHASE_PCT) no("price_ran_away", `ask +${fmt(chase, 2)}% since signal > ${cfg.MAX_CHASE_PCT}%`);

  // Expected round-trip execution cost vs the risk we take (stop distance).
  const roundTripCostPct = 2 * cfg.TAKER_FEE_PCT + ticker.spreadPct + 2 * cfg.EST_SLIPPAGE_PCT;
  const maxCost = cfg.MAX_COST_TO_STOP_RATIO * cfg.STOP_LOSS_PCT;
  if (roundTripCostPct > maxCost) no("costs_too_high", `round-trip cost ${fmt(roundTripCostPct, 2)}% > ${fmt(maxCost, 2)}% (${cfg.MAX_COST_TO_STOP_RATIO} x stop)`);
  if (cfg.EXIT_MODE === "scalp" && cfg.SCALP_TAKE_PROFIT_PCT > 0 && roundTripCostPct > 0.5 * cfg.SCALP_TAKE_PROFIT_PCT) no("costs_vs_target", `round-trip cost ${fmt(roundTripCostPct, 2)}% > half of the +${cfg.SCALP_TAKE_PROFIT_PCT}% target`);

  if (!pair) return { ok: false, reasons };
  // Size the order: allocation includes the entry fee, limit at ask + slippage allowance.
  const decimals = Math.max(priceDecimals(ticker.askRaw), priceDecimals(ticker.bidRaw), 2);
  const tick = 10 ** -decimals;
  const limitPrice = Number(ceilToStep(ticker.ask * (1 + cfg.ENTRY_LIMIT_SLIPPAGE_PCT / 100), tick.toFixed(decimals)));
  const spendable = allocationQuote / (1 + cfg.TAKER_FEE_PCT / 100);
  const baseSize = floorToStep(spendable / limitPrice, pair.baseStep);
  const baseNum = toNum(baseSize);
  if (!(baseNum > 0)) no("size_zero", "allocation too small for one base step");
  if (pair.minOrderSize > 0 && baseNum < pair.minOrderSize) no("below_min_order", `${baseSize} < min ${pair.minOrderSize}`);
  if (pair.minOrderSizeQuote > 0 && baseNum * ticker.ask < pair.minOrderSizeQuote) no("below_min_notional", `${fmt(baseNum * ticker.ask, 4)} < min ${pair.minOrderSizeQuote}`);
  if (pair.maxOrderSize > 0 && baseNum > pair.maxOrderSize) no("above_max_order", `${baseSize} > max ${pair.maxOrderSize}`);
  // The protective exit must be placeable: at the stop price the position must still meet exchange minimums.
  const stopPrice = ticker.ask * (1 - cfg.STOP_LOSS_PCT / 100);
  if (pair.minOrderSizeQuote > 0 && baseNum * stopPrice < pair.minOrderSizeQuote * 1.05) no("exit_not_placeable", "position would be below min notional at the stop price");
  // Worst-case notional must stay within the allocation.
  if (baseNum * limitPrice * (1 + cfg.TAKER_FEE_PCT / 100) > allocationQuote + 1e-9) no("exceeds_allocation", "sizing error");

  // Order-book depth: our size must be covered within the slippage allowance.
  if (book && Array.isArray(book.asks) && book.asks.length) {
    let need = baseNum;
    for (const lvl of book.asks) {
      if (lvl.price > limitPrice) break;
      need -= lvl.qty;
      if (need <= 0) break;
    }
    if (need > 0) no("thin_book", `only ${fmt(baseNum - need, 6)} of ${baseSize} available up to ${limitPrice}`);
  }

  return {
    ok: reasons.length === 0,
    reasons,
    order: { symbol: signal.symbol, side: "buy", type: "limit", timeInForce: "ioc", baseSize, price: limitPrice.toFixed(decimals) },
    costs: { roundTripCostPct, spreadPct: ticker.spreadPct, chasePct: chase }
  };
}
