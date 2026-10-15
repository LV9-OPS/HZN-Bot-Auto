// npm run adopt -- XRP-USDC [--entry 1.5494] [--slot 1] [--yes]
// Hand an existing holding to the bot. Entry price and quantity are rebuilt from
// your FILLED buy orders on Revolut X (most recent first). --entry overrides the
// price only if you know it better (recorded as a manual note). The bot must be stopped.
import fs from "node:fs";
import path from "node:path";
import { setup, arg, positional } from "./common.js";
import { StateStore } from "../storage/stateStore.js";
import { acquireLock } from "../monitoring/instanceLock.js";
import { splitSymbol } from "../util/symbols.js";
import { RiskManager } from "../risk/riskManager.js";

const { cfg, logger, client } = setup({ overrides: { BOT_MODE: "paper" }, level: "warn" });
const symbol = String(positional(0) || "").toUpperCase().replace("/", "-");
if (!/^[A-Z0-9]+-USDC$/.test(symbol)) {
  console.error("usage: npm run adopt -- XRP-USDC [--entry PRICE] [--slot N] [--yes]");
  process.exit(1);
}
if (!client.authenticated) { console.error("Credentials required."); process.exit(1); }
const lock = acquireLock(cfg.dataDir, "live"); // refuses if the live bot is running
try {
  const store = new StateStore({ dataDir: cfg.dataDir, mode: "live", logger: logger.child("state") });
  store.load();
  const state = store.state;
  if (Object.values(state.positions).some((p) => p.symbol === symbol)) throw new Error(`${symbol} is already tracked (${Object.values(state.positions).find((p) => p.symbol === symbol).status}).`);
  const { base } = splitSymbol(symbol);
  const balances = await client.getBalances();
  const bal = balances.get(base);
  if (!bal || !(bal.total > 0)) throw new Error(`No ${base} balance on Revolut X.`);
  const hist = await client.getHistoricalOrders({ symbols: [symbol], startDate: Date.now() - 30 * 86400000, endDate: Date.now() });
  const buys = hist.filter((o) => o.side === "buy" && o.filledQuantity > 0).sort((a, b) => b.createdAt - a.createdAt);
  let need = bal.total;
  const used = [];
  for (const o of buys) {
    if (need <= 1e-12) break;
    const take = Math.min(o.filledQuantity, need);
    used.push({ o, take });
    need -= take;
  }
  const coveredQty = bal.total - Math.max(0, need);
  const notional = used.reduce((s, u) => s + u.take * u.o.avgFillPrice, 0);
  let entry = coveredQty > 0 ? notional / coveredQty : NaN;
  const manualEntry = arg("entry") ? Number(arg("entry")) : null;
  if (manualEntry) entry = manualEntry;
  if (!(entry > 0)) throw new Error(`No filled ${symbol} buys found in the last 30 days; pass --entry PRICE explicitly.`);
  if (need > bal.total * 0.01 && !manualEntry) throw new Error(`Only ${coveredQty} of ${bal.total} ${base} explained by buys in 30 days; pass --entry PRICE explicitly.`);
  const risk = new RiskManager({ cfg });
  const slot = Number(arg("slot", 0)) || risk.freeSlot(state);
  if (!slot || Object.values(state.positions).some((p) => p.slot === slot && ["opening", "open", "closing", "needs_reconciliation"].includes(p.status))) throw new Error("No free slot (or requested slot is used).");
  const cost = bal.total * entry * (1 + cfg.TAKER_FEE_PCT / 100);
  if (risk.deployedQuote(state) + cost > risk.budget() + 1e-9) console.warn(`WARNING: adopting ${cost.toFixed(2)} USDC exceeds the remaining bot budget (${risk.remainingBudget(state).toFixed(2)}). New entries will stay blocked until it is closed.`);
  const plan = cfg.plans[slot - 1];
  console.log(`\nAdopt ${bal.total} ${base} as slot ${slot} (${plan.name}), entry ${entry} (${manualEntry ? "manual" : "from " + used.length + " buy order(s)"}), stop ${(entry * (1 - cfg.STOP_LOSS_PCT / 100)).toPrecision(6)}, target ${(entry * plan.targetMultiple).toPrecision(6)}.`);
  if (!arg("yes")) { console.log("Re-run with --yes to confirm."); process.exit(0); }
  const id = `adopted-${Date.now()}-${symbol}`;
  state.positions[id] = {
    id, symbol, slot, plan, origin: "adopted", status: "open", allocationQuote: Math.max(0.01, cost), qty: bal.total, initialQty: bal.total, entryPrice: entry,
    costBasisQuote: cost, entryFeeQuote: bal.total * entry * cfg.TAKER_FEE_PCT / 100, targetReached: false, targetReachedAt: null, peakBid: null,
    openedAt: new Date(used[used.length - 1]?.o.createdAt || Date.now()).toISOString(), createdAt: new Date().toISOString(),
    entry: { clientOrderId: used[0]?.o.clientOrderId || null, venueOrderId: used[0]?.o.venueOrderId || null, status: "filled", adopted: true },
    exits: [], pendingExit: null, exitReason: null, realizedNetPnl: 0, proceedsQuote: 0,
    protection: { type: "software", nativeOrderIds: [] }, notes: [manualEntry ? `entry price set manually to ${entry}` : "adopted from exchange buy history"], lastBid: null, lastPriceAt: null
  };
  state.unmanagedHoldings = (state.unmanagedHoldings || []).filter((h) => h.currency !== base);
  store.save({ backup: true });
  console.log(`Adopted. The bot will manage ${symbol} on its next start (target state will be checked against candles at reconciliation).`);
} catch (e) {
  console.error("adopt failed:", e.message);
  process.exitCode = 1;
} finally {
  lock.release();
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
