import "dotenv/config";
import crypto from "node:crypto";
import { RevolutX } from "./revolut.js";
import { scan } from "./scanner.js";
import { notify } from "./discord.js";
import { loadState, saveState } from "./state.js";
import { assertSafety, canTrade, envNumber, quoteToBase, resetDailyState } from "./risk.js";
import { evaluate, exitDecision } from "./strategy.js";

const api = new RevolutX();
const { mode, maxTrade } = assertSafety();
const intervalMs = Math.max(15000, envNumber("SCAN_INTERVAL_MS", 15000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message, data) { console.log(new Date().toISOString(), message, data ?? ""); }

function orderData(result) {
  const data = result?.data ?? result;
  return Array.isArray(data) ? data[0] : data;
}

async function placeLimit(symbol, side, baseSize, price) {
  return api.placeOrder({
    client_order_id: crypto.randomUUID(),
    symbol,
    side,
    order_configuration: { limit: { base_size: String(baseSize), price: String(price) } }
  });
}

async function syncPendingEntry(state) {
  if (!state.position?.pending || !state.position.orderId) return false;
  try {
    const result = await api.getOrder(state.position.orderId);
    const order = orderData(result);
    const stateName = String(order?.state || order?.status || "").toLowerCase();
    if (["filled", "partially_filled"].includes(stateName)) {
      const filled = Number(order.filled_quantity || order.quantity || state.position.baseSize || 0);
      if (filled > 0) {
        state.position.pending = false;
        state.position.baseSize = filled;
        state.position.entryPrice = Number(order.average_price || order.avg_price || order.price || state.position.entryPrice);
        state.position.highWatermark = state.position.entryPrice;
        state.position.openedAt = new Date().toISOString();
        await saveState(state);
        await notify("HZN Bot Auto | LIVE ENTRY FILLED\n" + state.position.symbol + " | " + state.position.entryPrice);
        log("LIVE ENTRY FILLED", { symbol: state.position.symbol, price: state.position.entryPrice, baseSize: filled });
        return true;
      }
    }
    if (["cancelled", "canceled", "rejected", "expired"].includes(stateName)) {
      await notify("HZN Bot Auto | ENTRY FAILED\n" + state.position.symbol + " | " + stateName);
      state.position = null;
      await saveState(state);
      return true;
    }
  } catch (error) {
    log("ENTRY SYNC ERROR", { message: error.message });
  }
  return false;
}

async function checkPosition(state) {
  if (!state.position || state.position.pending) return false;
  const tickerResponse = await api.getTickers([state.position.symbol]);
  const ticker = (tickerResponse.data || [])[0];
  if (!ticker) return false;

  const bid = Number(ticker.bid || ticker.last_price);
  const decision = exitDecision(state.position, bid);
  state.position.highWatermark = decision.highWatermark;
  if (!decision.reason) return false;

  const symbol = state.position.symbol;
  const baseSize = Number(state.position.baseSize);
  const exitPrice = bid;

  if (mode === "paper") {
    const pnl = Number(state.position.quoteSize) * (decision.pnlPct / 100);
    state.realizedPnl += pnl;
    state.trades.push({ side: "SELL", symbol, price: exitPrice, pnl, reason: decision.reason, at: new Date().toISOString() });
    state.position = null;
    await saveState(state);
    log("PAPER EXIT", { symbol, price: exitPrice, pnlPct: decision.pnlPct, reason: decision.reason });
    await notify("HZN Bot Auto | PAPER EXIT\n" + symbol + " | " + decision.reason + " | PnL " + decision.pnlPct.toFixed(2) + "%");
    return true;
  }

  if (state.position.orderId) {
    try { await api.cancelOrder(state.position.orderId); } catch {}
  }

  const result = await placeLimit(symbol, "SELL", baseSize, exitPrice);
  const item = orderData(result);
  state.trades.push({ side: "SELL", symbol, price: exitPrice, reason: decision.reason, orderId: item?.venue_order_id || null, at: new Date().toISOString() });
  state.position = null;
  await saveState(state);
  await notify("HZN Bot Auto | LIVE EXIT ORDER\n" + symbol + " | " + decision.reason + " | " + exitPrice);
  log("LIVE EXIT ORDER", { symbol, price: exitPrice, reason: decision.reason, orderId: item?.venue_order_id || null });
  return true;
}

async function openPosition(state, candidate) {
  const signal = evaluate(candidate);
  if (!signal.signal || !canTrade(state)) return false;
  const symbol = signal.symbol;
  const price = signal.ask || signal.price;
  if (!price) return false;

  const pairsResponse = await api.getPairs();
  const pairs = pairsResponse.data || pairsResponse;
  const pairKey = Object.keys(pairs).find((k) => k.replace("/", "-") === symbol);
  const config = pairKey ? pairs[pairKey] : null;
  if (!config || config.status !== "active") return false;

  const baseSize = quoteToBase(maxTrade, price, config.base_step);
  if (!baseSize || baseSize < Number(config.min_order_size || 0)) {
    log("SKIP: order below exchange minimum", { symbol, baseSize, min: config.min_order_size });
    return false;
  }

  if (mode === "paper") {
    state.position = { symbol, entryPrice: price, quoteSize: maxTrade, baseSize, highWatermark: price, pending: false, openedAt: new Date().toISOString() };
    await saveState(state);
    log("PAPER ENTRY", { symbol, price, quoteSize: maxTrade, baseSize, score: signal.score });
    await notify("HZN Bot Auto | PAPER ENTRY\n" + symbol + " | " + price + " | score " + signal.score);
    return true;
  }

  const result = await placeLimit(symbol, "BUY", baseSize, price);
  const item = orderData(result);
  if (!item?.venue_order_id && !item?.id) throw new Error("Live order was accepted without an order id.");
  state.position = {
    symbol,
    orderId: item.venue_order_id || item.id,
    entryPrice: price,
    quoteSize: maxTrade,
    baseSize,
    highWatermark: price,
    pending: true,
    openedAt: new Date().toISOString()
  };
  await saveState(state);
  log("LIVE ENTRY ORDER", { symbol, price, baseSize, orderId: state.position.orderId });
  await notify("HZN Bot Auto | LIVE ENTRY ORDER\n" + symbol + " | " + price + " | order " + state.position.orderId);
  return true;
}

async function startupCheck() {
  if (mode !== "live") return;
  if (!api.configured) throw new Error("Live mode requires Revolut X API key and Ed25519 private key.");
  const balances = await api.getBalances();
  const active = await api.getActiveOrders({ limit: 100 });
  const balanceList = Array.isArray(balances.data || balances) ? (balances.data || balances) : [];
  const activeList = Array.isArray(active.data) ? active.data : [];
  log("LIVE AUTH OK", { balanceCurrencies: balanceList.map((x) => x.currency), activeOrders: activeList.length });
}

async function main() {
  let state = resetDailyState(await loadState());
  await saveState(state);
  await startupCheck();
  log("HZN Bot Auto started", {
    mode,
    maxTradeQuote: maxTrade,
    stopLossPct: envNumber("STOP_LOSS_PCT", 3),
    takeProfitPct: envNumber("TAKE_PROFIT_PCT", 10),
    trailingActivationPct: envNumber("TRAILING_ACTIVATION_PCT", 5),
    trailingStopPct: envNumber("TRAILING_STOP_PCT", 2)
  });

  while (true) {
    try {
      state = resetDailyState(state);
      if (mode === "live" && state.position?.pending) await syncPendingEntry(state);
      await checkPosition(state);
      if (!state.position && canTrade(state)) {
        const candidates = await scan();
        if (candidates[0]) await openPosition(state, candidates[0]);
        else log("No qualifying momentum candidate.");
      }
      await saveState(state);
    } catch (error) {
      log("LOOP ERROR", { message: error.message });
      try { await notify("HZN Bot Auto | ERROR\n" + error.message.slice(0, 1500)); } catch {}
    }
    await sleep(intervalMs);
  }
}

main().catch(async (error) => {
  console.error(error);
  try { await notify("HZN Bot Auto | FATAL\n" + error.message.slice(0, 1500)); } catch {}
  process.exitCode = 1;
});