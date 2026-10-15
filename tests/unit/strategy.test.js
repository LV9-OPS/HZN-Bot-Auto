import test from "node:test";
import assert from "node:assert/strict";
import { evaluateExit, planLevels } from "../../src/strategy/profitPlan.js";
import { confirmEntry } from "../../src/strategy/entryConfirm.js";
import { floorToStep, ceilToStep, stepDecimals } from "../../src/util/num.js";
import { makeCfg } from "../helpers.js";

const X2 = { targetMultiple: 2, floorMultiple: 1, name: "X2->X1" };
const X3 = { targetMultiple: 3, floorMultiple: 2, name: "X3->X2" };
const pos = (plan, extra = {}) => ({ entryPrice: 1, plan, targetReached: false, peakBid: null, ...extra });
const ok = (bid) => ({ bid, reliable: true });
const SL = { stopLossPct: 3 };

test("stop-loss level is 3% below entry and evaluated on the bid", () => {
  const lv = planLevels(pos(X2), 3);
  assert.equal(lv.stopPrice.toFixed(4), "0.9700");
  assert.equal(evaluateExit(pos(X2), ok(0.9701), SL).action, "hold");
  const d = evaluateExit(pos(X2), ok(0.97), SL);
  assert.equal(d.action, "exit");
  assert.equal(d.reason, "STOP_LOSS");
});

test("X2 means 2x the entry price (not +2%)", () => {
  assert.equal(evaluateExit(pos(X2), ok(1.02), SL).updates.targetReached, undefined);
  const d = evaluateExit(pos(X2), ok(2.0), SL);
  assert.equal(d.updates.targetReached, true);
  assert.equal(d.action, "hold", "reaching the target does not sell");
});

test("plan 1: after X2, retracement to X1 exits; above X1 holds", () => {
  const p = pos(X2, { targetReached: true });
  assert.equal(evaluateExit(p, ok(1.5), SL).action, "hold");
  assert.equal(evaluateExit(p, ok(1.0001), SL).action, "hold");
  const d = evaluateExit(p, ok(1.0), SL);
  assert.equal(d.action, "exit");
  assert.equal(d.reason, "X2_RETRACE_TO_X1");
});

test("plans 2/3: after X3, retracement to X2 exits", () => {
  const p = pos(X3);
  assert.equal(evaluateExit(p, ok(2.9), SL).updates.targetReached, undefined);
  const hit = evaluateExit(p, ok(3.0), SL);
  assert.equal(hit.updates.targetReached, true);
  const armed = pos(X3, { targetReached: true });
  assert.equal(evaluateExit(armed, ok(2.5), SL).action, "hold");
  const d = evaluateExit(armed, ok(1.99), SL);
  assert.equal(d.reason, "X3_RETRACE_TO_X2");
});

test("once the target is reached the -3% stop no longer applies (floor replaces it)", () => {
  const armed = pos(X3, { targetReached: true });
  assert.equal(evaluateExit(armed, ok(0.5), SL).reason, "X3_RETRACE_TO_X2");
});

test("no decision without a reliable price (never invents a price)", () => {
  const d = evaluateExit(pos(X2), { reliable: false, bid: 0.5 }, SL);
  assert.equal(d.action, "hold");
  assert.ok(d.events.includes("no_reliable_price"));
});

// ---------------------------------------------------------------- precision
test("quantity precision floors to the exchange step without float artefacts", () => {
  assert.equal(floorToStep(6.454119999, "0.00001"), "6.45411");
  assert.equal(floorToStep(0.3, "0.1"), "0.3");
  assert.equal(floorToStep(1282051.28, "1"), "1282051");
  assert.equal(ceilToStep(1.31801, "0.0001"), "1.3181");
  assert.equal(stepDecimals("0.000001"), 6);
  assert.equal(stepDecimals("1e-8"), 8);
});

// ---------------------------------------------------------------- stage D
const cfg = makeCfg();
const pair = { symbol: "SOL-USDC", status: "active", baseStep: "0.0001", minOrderSize: 0.0001, minOrderSizeQuote: 0.1, maxOrderSize: 1e6 };
const now = 1_000_000;
const fresh = (bid, ask) => ({ bid, ask, mid: (bid + ask) / 2, spreadPct: ((ask - bid) / ((bid + ask) / 2)) * 100, ts: now, valid: true, bidRaw: bid.toFixed(3), askRaw: ask.toFixed(3) });
const signal = { symbol: "SOL-USDC", createdAt: now - 3000, execAskAtSignal: 100.1 };

test("stage D accepts a fresh, tight, affordable entry and sizes it within the allocation", () => {
  const r = confirmEntry({ signal, ticker: fresh(100, 100.1), pair, allocationQuote: 5, now, cfg });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  const notional = Number(r.order.baseSize) * Number(r.order.price) * (1 + cfg.TAKER_FEE_PCT / 100);
  assert.ok(notional <= 5 + 1e-9, `notional ${notional}`);
  assert.equal(r.order.timeInForce, "ioc");
  assert.match(r.order.baseSize, /^\d+\.\d{4}$/);
});

test("stage D rejects a stale signal", () => {
  const r = confirmEntry({ signal: { ...signal, createdAt: now - 60000 }, ticker: fresh(100, 100.1), pair, allocationQuote: 5, now, cfg });
  assert.ok(r.reasons.some((x) => x.code === "stale_signal"));
});

test("stage D rejects when price ran away from the signal", () => {
  const r = confirmEntry({ signal, ticker: fresh(101, 101.1), pair, allocationQuote: 5, now, cfg });
  assert.ok(r.reasons.some((x) => x.code === "price_ran_away"));
});

test("stage D rejects when the spread widened", () => {
  const r = confirmEntry({ signal, ticker: fresh(99.5, 100.1), pair, allocationQuote: 5, now, cfg });
  assert.ok(r.reasons.some((x) => x.code === "spread_too_wide"));
});

test("stage D rejects when costs are too high relative to the stop distance", () => {
  const strict = makeCfg({ MAX_COST_TO_STOP_RATIO: "0.05" });
  const r = confirmEntry({ signal, ticker: fresh(100, 100.1), pair, allocationQuote: 5, now, cfg: strict });
  assert.ok(r.reasons.some((x) => x.code === "costs_too_high"));
});

test("stage D enforces exchange minimums and exit placeability", () => {
  const r = confirmEntry({ signal, ticker: fresh(100, 100.1), pair: { ...pair, minOrderSizeQuote: 4.9 }, allocationQuote: 5, now, cfg });
  assert.ok(r.reasons.some((x) => x.code === "exit_not_placeable"));
  const r2 = confirmEntry({ signal, ticker: fresh(100, 100.1), pair: { ...pair, minOrderSize: 1 }, allocationQuote: 5, now, cfg });
  assert.ok(r2.reasons.some((x) => x.code === "below_min_order"));
});

test("stage D rejects a book too thin for the order", () => {
  const book = { asks: [{ price: 100.1, qty: 0.001 }] };
  const r = confirmEntry({ signal, ticker: fresh(100, 100.1), book, pair, allocationQuote: 5, now, cfg });
  assert.ok(r.reasons.some((x) => x.code === "thin_book"));
});

test("stage D rejects an inactive pair / missing quote", () => {
  const r = confirmEntry({ signal, ticker: null, pair, allocationQuote: 5, now, cfg });
  assert.equal(r.ok, false);
  const r2 = confirmEntry({ signal, ticker: fresh(100, 100.1), pair: { ...pair, status: "inactive" }, allocationQuote: 5, now, cfg });
  assert.ok(r2.reasons.some((x) => x.code === "pair_inactive"));
});
