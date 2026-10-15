import test from "node:test";
import assert from "node:assert/strict";
import { StateStore } from "../../src/storage/stateStore.js";
import { Journal } from "../../src/storage/journal.js";
import { RiskManager } from "../../src/risk/riskManager.js";
import { OrderManager } from "../../src/execution/orderManager.js";
import { PaperExchange } from "../../src/execution/exchanges.js";
import { makeCfg, ManualClock, StubMarket, captureNotifier, nullLogger } from "../helpers.js";

export function harness(over = {}) {
  const cfg = makeCfg(over);
  const clock = new ManualClock();
  const store = new StateStore({ dataDir: cfg.dataDir, mode: "paper", logger: nullLogger() });
  store.load();
  store.state.reconciliation.ok = true;
  const journal = new Journal({ dataDir: cfg.dataDir, mode: "paper" });
  const market = new StubMarket(clock);
  market.setPair("SOL-USDC");
  market.setTicker("SOL-USDC", 100, 100.1);
  const exchange = new PaperExchange({ store, getTicker: (s) => market.freshTicker(s), cfg, clock });
  const risk = new RiskManager({ cfg, clock });
  const notifier = captureNotifier();
  const om = new OrderManager({ cfg, store, journal, exchange, market, risk, notifier, logger: nullLogger(), clock, sleep: async (ms) => clock.advance(ms) });
  return { cfg, clock, store, journal, market, exchange, risk, notifier, om };
}

const ORDER = { type: "limit", timeInForce: "ioc", baseSize: "0.0499", price: "100.25" };
const plan = { targetMultiple: 2, floorMultiple: 1, name: "X2->X1" };
const open = (h, order = ORDER) => h.om.openPosition({ symbol: "SOL-USDC", slot: 1, plan, allocationQuote: 5, order, signal: { score: 70, explanation: "test" } });

test("entry: intent persisted before sending, filled position uses actual fill price, qty and fee", async () => {
  const h = harness();
  const p = await open(h);
  assert.equal(p.status, "open");
  assert.ok(Math.abs(p.entryPrice - 100.1 * 1.0005) < 1e-9, "fill = ask + slippage");
  assert.equal(p.qty, 0.0499);
  assert.ok(p.entryFeeQuote > 0);
  assert.ok(Math.abs(p.costBasisQuote - (p.qty * p.entryPrice + p.entryFeeQuote)) < 1e-9);
  assert.ok(h.journal.loadOrders().has(p.entry.clientOrderId), "client_order_id in durable registry");
  const types = h.notifier.messages.map((m) => m.type);
  assert.ok(types.indexOf("orderSubmitted") < types.indexOf("entryFilled"), "submitted is reported before filled");
});

test("entry IOC not filled (limit below ask) -> no position, nothing invented", async () => {
  const h = harness();
  const p = await open(h, { ...ORDER, price: "99" });
  assert.equal(p.status, "failed");
  assert.equal(Object.keys(h.store.state.positions).length, 0);
  assert.ok(h.notifier.messages.some((m) => m.type === "entryNotFilled"));
});

test("exchange rejection -> position failed, notified", async () => {
  const h = harness();
  h.exchange.faults.placeOrder = "reject";
  const p = await open(h);
  assert.equal(p.status, "failed");
  assert.ok(h.notifier.messages.some((m) => m.type === "orderFailed"));
});

test("timeout AFTER the exchange accepted: order is found by client_order_id, no duplicate order", async () => {
  const h = harness();
  h.exchange.faults.placeOrder = "timeout_after_accept";
  const p = await open(h);
  h.exchange.faults.placeOrder = null;
  assert.equal(p.status, "open", "resolved via lookup");
  const orders = Object.values(h.store.state.paper.orders);
  assert.equal(orders.length, 1, "exactly one order on the exchange");
});

test("timeout BEFORE the exchange received the order: stays 'opening' until proven absent, then failed", async () => {
  const h = harness();
  h.exchange.faults.placeOrder = "timeout_before";
  const p = await open(h);
  assert.equal(p.status, "opening");
  assert.equal(h.risk.entryGate(h.store.state).ok, true, "other slots still usable");
  assert.ok(h.risk.deployedQuote(h.store.state) >= 5, "allocation stays reserved while unknown");
  for (let i = 0; i < 3; i++) {
    h.clock.advance(70000);
    await h.om.resolveOpening(h.store.state.positions[p.id] || p);
  }
  assert.equal(h.store.state.positions[p.id], undefined);
  assert.equal(h.store.state.history.at(-1).exitReason, "entry_not_found");
});

test("HTTP 429 on placement is treated as unknown and verified before any retry", async () => {
  const h = harness();
  h.exchange.faults.placeOrder = "rate_limit";
  const p = await open(h);
  assert.equal(p.entry.status, "unknown");
  assert.equal(p.status, "opening", "not re-sent, waiting for verification");
  assert.equal(Object.values(h.store.state.paper.orders).length, 0);
  h.exchange.faults.placeOrder = null;
  for (let i = 0; i < 3; i++) { h.clock.advance(70000); await h.om.resolveOpening(h.store.state.positions[p.id] || p); }
  assert.equal(Object.values(h.store.state.paper.orders).length, 0, "never re-submitted automatically");
});

test("partial entry fill: position sized to the filled quantity", async () => {
  const h = harness();
  const orig = h.exchange.placeOrder.bind(h.exchange);
  h.exchange.placeOrder = async (req) => {
    const r = await orig(req);
    const o = h.store.state.paper.orders[r.venueOrderId];
    // simulate exchange filling only 40%
    const refund = (o.filledQuantity * 0.6) * o.avgFillPrice * (1 + h.cfg.TAKER_FEE_PCT / 100);
    h.store.state.paper.balances.USDC += refund;
    h.store.state.paper.balances.SOL -= o.filledQuantity * 0.6;
    o.filledQuantity *= 0.4;
    o.filledAmount = o.filledQuantity * o.avgFillPrice;
    o.totalFee = o.filledAmount * h.cfg.TAKER_FEE_PCT / 100;
    o.status = "cancelled"; // IOC remainder cancelled
    return r;
  };
  const p = await open(h);
  assert.equal(p.status, "open");
  assert.ok(Math.abs(p.qty - 0.0499 * 0.4) < 1e-12);
  assert.equal(p.partialEntry, true);
});

test("stop-loss exit: one sell order, fees in net PnL, position archived, budget freed", async () => {
  const h = harness();
  const p = await open(h);
  h.market.setTicker("SOL-USDC", 96.5, 96.6);
  const r = await h.om.exitPosition(p, "STOP_LOSS");
  assert.ok(r.closed || r.submitted);
  assert.equal(h.store.state.positions[p.id], undefined);
  const closed = h.store.state.history.at(-1);
  assert.equal(closed.status, "closed");
  const sell = closed.exits[0];
  const expected = sell.filledQty * sell.avgPrice - sell.feeQuote - closed.costBasisQuote;
  assert.ok(Math.abs(closed.realizedNetPnl - expected) < 1e-9);
  assert.ok(closed.realizedNetPnl < 0);
  assert.ok(h.store.state.stats.totalFees > 0);
  assert.equal(h.risk.deployedQuote(h.store.state), 0);
  assert.equal(h.store.state.daily.realizedNetPnl, closed.realizedNetPnl);
});

test("duplicate exit prevention: concurrent/repeated exit calls send exactly one sell", async () => {
  const h = harness();
  const p = await open(h);
  h.market.setTicker("SOL-USDC", 96.5, 96.6);
  h.exchange.faults.placeOrder = "timeout_after_accept"; // accepted but response lost
  const [a, b] = await Promise.all([h.om.exitPosition(p, "STOP_LOSS"), h.om.exitPosition(p, "STOP_LOSS")]);
  assert.ok(a.skipped === "busy" || b.skipped === "busy");
  h.exchange.faults.placeOrder = null;
  await h.om.exitPosition(h.store.state.positions[p.id] || p, "STOP_LOSS"); // resolves the in-flight one instead of re-sending
  const sells = Object.values(h.store.state.paper.orders).filter((o) => o.side === "sell");
  assert.equal(sells.length, 1);
  assert.equal(h.store.state.positions[p.id], undefined, "closed from the single sell");
});

test("exit never sells more than the available exchange balance", async () => {
  const h = harness();
  const p = await open(h);
  h.store.state.paper.balances.SOL = 0.02; // e.g. user moved some coins out
  h.market.setTicker("SOL-USDC", 96.5, 96.6);
  await h.om.exitPosition(p, "STOP_LOSS");
  const sell = Object.values(h.store.state.paper.orders).find((o) => o.side === "sell");
  assert.equal(sell.quantity, 0.02);
  const still = h.store.state.positions[p.id];
  assert.ok(still && Math.abs(still.qty - 0.0299) < 1e-9, "remaining quantity still tracked");
});

test("IOC exit not filled falls back to a market order after the configured attempts", async () => {
  const h = harness({ EXIT_MAX_IOC_ATTEMPTS: "2" });
  const p = await open(h);
  h.market.setTicker("SOL-USDC", 96.5, 96.6);
  const orig = h.exchange.placeOrder.bind(h.exchange);
  h.exchange.placeOrder = async (req) => (req.type === "limit" ? orig({ ...req, price: "1000" }) : orig(req)); // limit unfillable
  await h.om.exitPosition(p, "STOP_LOSS");
  await h.om.exitPosition(h.store.state.positions[p.id], "STOP_LOSS");
  assert.ok(h.store.state.positions[p.id], "still open after 2 IOC misses");
  await h.om.exitPosition(h.store.state.positions[p.id], "STOP_LOSS");
  assert.equal(h.store.state.positions[p.id], undefined);
  const types = Object.values(h.store.state.paper.orders).filter((o) => o.side === "sell").map((o) => o.type);
  assert.deepEqual(types, ["limit", "limit", "market"]);
});

test("insufficient quote balance is rejected by the exchange model and leaves no position", async () => {
  const h = harness();
  h.store.state.paper.balances.USDC = 1;
  const p = await open(h);
  assert.equal(p.status, "failed");
});

test("three rejected exits lock the position (ERROR_LOCKED) and block new entries", async () => {
  const h = harness();
  const p = await open(h);
  h.market.setTicker("SOL-USDC", 96.5, 96.6);
  h.exchange.faults.placeOrder = "reject";
  for (let i = 0; i < 3; i++) await h.om.exitPosition(h.store.state.positions[p.id], "STOP_LOSS");
  const q = h.store.state.positions[p.id];
  assert.equal(q.status, "error_locked");
  assert.ok(h.risk.entryGate(h.store.state).reasons.some((r) => r.code === "position_error_locked"));
  assert.ok(q.log.some((e) => e.event === "error_locked"), "audit trail kept on the position");
});

test("monthly loss limit (3% of month-start equity) blocks entries for the rest of the month", async () => {
  const h = harness();
  h.risk.rollDay(h.store.state);
  h.risk.recordClose(h.store.state, { netPnl: -0.31, fees: 0.01, symbol: "SOL-USDC" });
  assert.ok(h.risk.entryGate(h.store.state).reasons.some((r) => r.code === "monthly_loss_limit"));
});

test("realised entry slippage vs decision price is recorded", async () => {
  const h = harness();
  const p = await h.om.openPosition({ symbol: "SOL-USDC", slot: 1, plan, allocationQuote: 5, order: ORDER, signal: { score: 70, explanation: "t", decisionPrice: 100.1 } });
  assert.ok(Number.isFinite(p.entry.slippagePct));
  assert.ok(p.entry.slippagePct > 0);
});
