import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StateStore } from "../../src/storage/stateStore.js";
import { Journal } from "../../src/storage/journal.js";
import { RiskManager } from "../../src/risk/riskManager.js";
import { OrderManager } from "../../src/execution/orderManager.js";
import { Reconciler } from "../../src/reconciliation/reconciler.js";
import { ApiError } from "../../src/api/errors.js";
import { makeCfg, ManualClock, StubMarket, captureNotifier, nullLogger } from "../helpers.js";

/** In-memory Revolut X account. */
class FakeExchange {
  constructor() {
    this.balances = new Map();
    this.active = [];
    this.history = [];
    this.cancelled = [];
    this.fail = null;
  }
  setBalance(cur, total, reserved = 0) {
    this.balances.set(cur, { currency: cur, available: total - reserved, reserved, staked: 0, total });
  }
  async getBalances() {
    if (this.fail === "balances_malformed") throw new ApiError("malformed", "balances payload has no data array");
    if (this.fail === "down") throw new ApiError("server", "503");
    return new Map(this.balances);
  }
  async getActiveOrders() { return this.active.slice(); }
  async getHistoricalOrders() { return this.history.slice(); }
  async getOrder(id) {
    const o = [...this.history, ...this.active].find((x) => x.venueOrderId === id);
    if (!o) throw new ApiError("not_found", "nf", { status: 404 });
    return o;
  }
  async placeOrder() { throw new Error("not used"); }
  async cancelOrder(id) { this.cancelled.push(id); this.active = this.active.filter((o) => o.venueOrderId !== id); return true; }
}

const order = (o) => ({ venueOrderId: o.id, clientOrderId: o.cid || "", symbol: o.symbol, side: o.side, type: o.type || "limit", status: o.status || "filled", quantity: o.qty, filledQuantity: o.filled ?? o.qty, avgFillPrice: o.price, filledAmount: (o.filled ?? o.qty) * o.price, totalFee: o.fee ?? 0, feeCurrency: "USDC", createdAt: o.at, price: o.price });

function setup({ mode = "live", legacy = null } = {}) {
  const cfg = makeCfg();
  const clock = new ManualClock();
  if (legacy) fs.writeFileSync(path.join(cfg.dataDir, "state.json"), JSON.stringify(legacy));
  const store = new StateStore({ dataDir: cfg.dataDir, mode, logger: nullLogger() });
  store.load();
  const journal = new Journal({ dataDir: cfg.dataDir, mode });
  const market = new StubMarket(clock);
  for (const s of ["XRP-USDC", "SOL-USDC", "ETH-USDC"]) market.setPair(s);
  market.setTicker("XRP-USDC", 1.31, 1.312);
  market.setTicker("SOL-USDC", 100, 100.1);
  market.setTicker("ETH-USDC", 2400, 2401);
  const ex = new FakeExchange();
  ex.setBalance("USDC", 10);
  const risk = new RiskManager({ cfg, clock });
  const notifier = captureNotifier();
  const orders = new OrderManager({ cfg, store, journal, exchange: ex, market, risk, notifier, logger: nullLogger(), clock, sleep: async () => {} });
  const candles = [];
  const client = { getCandles: async () => candles };
  const rec = new Reconciler({ cfg, store, journal, exchange: ex, market, orders, notifier, logger: nullLogger(), client, clock });
  return { cfg, clock, store, journal, market, ex, risk, notifier, orders, rec, candles };
}

const openPos = (h, over = {}) => {
  const p = { id: "p1", symbol: "SOL-USDC", slot: 1, plan: h.cfg.plans[0], origin: "bot", status: "open", allocationQuote: 5, qty: 0.0499, initialQty: 0.0499, entryPrice: 100, costBasisQuote: 4.995, entryFeeQuote: 0.0045, targetReached: false, peakBid: null, openedAt: new Date(h.clock.now() - 3600000).toISOString(), entry: { clientOrderId: "c-entry", venueOrderId: "v-entry", status: "filled" }, exits: [], pendingExit: null, realizedNetPnl: 0, protection: { type: "software", nativeOrderIds: [] }, notes: [], ...over };
  h.store.state.positions[p.id] = p;
  h.store.save();
  return p;
};

test("startup reconciliation with matching balances succeeds and allows entries", async () => {
  const h = setup();
  openPos(h);
  h.ex.setBalance("SOL", 0.0499);
  const r = await h.rec.run({ full: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(h.store.state.reconciliation.ok, true);
});

test("malformed or failing balance API never deletes a local position", async () => {
  const h = setup();
  openPos(h);
  h.ex.fail = "balances_malformed";
  const r = await h.rec.run({ full: true });
  assert.equal(r.ok, false);
  assert.ok(h.store.state.positions.p1, "position kept");
  assert.equal(h.store.state.reconciliation.ok, false, "entries blocked");
  h.ex.fail = "down";
  await h.rec.run({});
  assert.ok(h.store.state.positions.p1);
});

test("exchange balance below the local position -> needs_reconciliation after confirmation, entries blocked, never deleted", async () => {
  const h = setup();
  openPos(h);
  h.ex.setBalance("SOL", 0);
  await h.rec.run({ full: true });
  assert.equal(h.store.state.positions.p1.status, "open", "first observation is only a warning");
  await h.rec.run({ full: true });
  const p = h.store.state.positions.p1;
  assert.equal(p.status, "needs_reconciliation");
  assert.equal(h.risk.entryGate(h.store.state).ok, false);
  assert.ok(h.notifier.messages.some((m) => m.type === "reconciliation"));
});

test("a sell that filled while the bot was down is applied (no forgotten exit, no duplicate sell)", async () => {
  const h = setup();
  openPos(h);
  h.ex.setBalance("SOL", 0);
  h.ex.history.push(order({ id: "v-sell", cid: "c-sell", symbol: "SOL-USDC", side: "sell", qty: 0.0499, price: 97, fee: 0.004, at: h.clock.now() - 60000 }));
  h.journal.recordOrderIntent({ clientOrderId: "c-sell", symbol: "SOL-USDC", side: "sell" });
  await h.rec.run({ full: true });
  assert.equal(h.store.state.positions.p1, undefined);
  const closed = h.store.state.history.at(-1);
  assert.equal(closed.status, "closed");
  assert.ok(closed.realizedNetPnl < 0);
});

test("missing local position is rebuilt from the bot's own fills (registry proves ownership)", async () => {
  const h = setup();
  h.journal.recordOrderIntent({ clientOrderId: "c-buy", symbol: "XRP-USDC", side: "buy", slot: 1 });
  h.ex.history.push(order({ id: "v-buy", cid: "c-buy", symbol: "XRP-USDC", side: "buy", qty: 6.45411, price: 1.5494, at: h.clock.now() - 86400000 }));
  h.ex.setBalance("XRP", 6.45411);
  await h.rec.run({ full: true });
  const p = Object.values(h.store.state.positions)[0];
  assert.ok(p, "position recreated");
  assert.equal(p.symbol, "XRP-USDC");
  assert.equal(p.origin, "recovered");
  assert.ok(Math.abs(p.entryPrice - 1.5494) < 1e-12);
  assert.equal(p.slot, 1);
  assert.equal(p.status, "open");
});

test("holdings NOT bought by the bot are reported as unmanaged and never adopted or sold", async () => {
  const h = setup();
  h.ex.setBalance("ETH", 0.01); // ~24 USDC, bought manually
  h.ex.history.push(order({ id: "v-manual", cid: "someone-else", symbol: "ETH-USDC", side: "buy", qty: 0.01, price: 2300, at: h.clock.now() - 86400000 }));
  const r = await h.rec.run({ full: true });
  assert.equal(Object.keys(h.store.state.positions).length, 0);
  assert.equal(h.store.state.unmanagedHoldings[0].currency, "ETH");
  assert.equal(r.ok, true, "unmanaged holdings do not block trading");
  assert.equal(h.risk.deployedQuote(h.store.state), 0, "not counted in the bot budget");
});

test("dust balances are ignored", async () => {
  const h = setup();
  h.ex.setBalance("XRP", 0.1); // 0.13 USDC
  await h.rec.run({ full: true });
  assert.equal(h.store.state.unmanagedHoldings.length, 0);
  assert.equal(Object.keys(h.store.state.positions).length, 0);
});

test("legacy XRP position is verified against its exchange order and resumed with exchange facts", async () => {
  const legacy = { positions: [{ symbol: "XRP-USDC", orderId: "6c93d13e", entryPrice: 1.5494, quoteSize: 9.999999, baseSize: 6.45411, slot: 1, profitPlan: 1, openedAt: "2026-10-02T00:00:00.000Z", targetReached: false }] };
  const h = setup({ legacy });
  h.ex.history.push(order({ id: "6c93d13e", cid: "old", symbol: "XRP-USDC", side: "buy", qty: 6.45411, price: 1.5493, fee: 0.009, at: Date.parse("2026-10-02T09:00:00Z") }));
  h.ex.setBalance("XRP", 6.45411);
  const r = await h.rec.run({ full: true });
  const p = Object.values(h.store.state.positions)[0];
  assert.equal(p.status, "open", JSON.stringify(r));
  assert.equal(p.origin, "legacy-verified");
  assert.equal(p.entryPrice, 1.5493, "entry price taken from the exchange, not the local file");
  assert.equal(r.ok, true);
});

test("legacy position whose entry order cannot be found stays blocked (no invented price)", async () => {
  const legacy = { positions: [{ symbol: "XRP-USDC", orderId: "unknown-id", entryPrice: 1.5494, quoteSize: 10, baseSize: 6.45411, slot: 1 }] };
  const h = setup({ legacy });
  h.ex.setBalance("XRP", 6.45411);
  const r = await h.rec.run({ full: true });
  const p = Object.values(h.store.state.positions)[0];
  assert.equal(p.status, "needs_reconciliation");
  assert.equal(r.ok, false);
  assert.equal(h.risk.entryGate(h.store.state).ok, false);
});

test("target-reached state is reconstructed from candles for a recovered position", async () => {
  const h = setup();
  h.journal.recordOrderIntent({ clientOrderId: "c-buy", symbol: "XRP-USDC", side: "buy", slot: 1 });
  h.ex.history.push(order({ id: "v-buy", cid: "c-buy", symbol: "XRP-USDC", side: "buy", qty: 5, price: 0.6, at: h.clock.now() - 86400000 }));
  h.ex.setBalance("XRP", 5);
  h.candles.push({ start: h.clock.now() - 3600000, open: 1.1, high: 1.25, low: 1.1, close: 1.2, volume: 1 }); // 2.08x
  await h.rec.run({ full: true });
  const p = Object.values(h.store.state.positions)[0];
  assert.equal(p.targetReached, true);
});

test("orphaned bot BUY order is cancelled; foreign orders are never touched", async () => {
  const h = setup();
  h.journal.recordOrderIntent({ clientOrderId: "c-orphan", symbol: "SOL-USDC", side: "buy" });
  h.ex.active.push(order({ id: "v-orphan", cid: "c-orphan", symbol: "SOL-USDC", side: "buy", qty: 0.05, filled: 0, price: 99, status: "new", at: h.clock.now() }));
  h.ex.active.push(order({ id: "v-user", cid: "user-order", symbol: "ETH-USDC", side: "sell", qty: 0.01, filled: 0, price: 3000, status: "new", at: h.clock.now() }));
  await h.rec.run({ full: true });
  assert.deepEqual(h.ex.cancelled, ["v-orphan"]);
});

test("a user-placed native TP/SL order on a held asset is detected as extra protection", async () => {
  const h = setup();
  openPos(h);
  h.ex.setBalance("SOL", 0.0499, 0.0499);
  h.ex.active.push({ ...order({ id: "v-sl", cid: "app", symbol: "SOL-USDC", side: "sell", type: "tpsl", qty: 0.0499, filled: 0, price: 97, status: "new", at: h.clock.now() }), trigger: { stopLoss: { trigger_price: "97" } } });
  await h.rec.run({ full: true });
  assert.deepEqual(h.store.state.positions.p1.protection.nativeOrderIds, ["v-sl"]);
});

test("concurrent reconciliation runs do not overlap", async () => {
  const h = setup();
  const [a, b] = await Promise.all([h.rec.run({ full: true }), h.rec.run({ full: true })]);
  assert.ok(a.skipped || b.skipped);
});
