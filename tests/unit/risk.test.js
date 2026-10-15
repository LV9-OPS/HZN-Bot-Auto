import test from "node:test";
import assert from "node:assert/strict";
import { RiskManager } from "../../src/risk/riskManager.js";
import { emptyState } from "../../src/storage/schema.js";
import { buildConfig } from "../../src/config/index.js";
import { makeCfg, ManualClock } from "../helpers.js";

const clock = new ManualClock();
const cfg = makeCfg();
const risk = new RiskManager({ cfg, clock });
const fresh = () => {
  const s = emptyState("paper");
  s.reconciliation.ok = true;
  return s;
};
const addPos = (s, slot, symbol, extra = {}) => {
  const id = "p" + slot;
  s.positions[id] = { id, symbol, slot, plan: cfg.plans[slot - 1], status: "open", allocationQuote: cfg.SLOT_ALLOCATIONS[slot - 1], costBasisQuote: cfg.SLOT_ALLOCATIONS[slot - 1], qty: 1, entryPrice: 1, targetReached: false, notes: [], exits: [], ...extra };
};

test("budget is capped at 10 USDC regardless of configuration", () => {
  assert.throws(() => buildConfig({ MAX_TRADING_BUDGET_QUOTE: "50" }), /above maximum 10/);
  assert.throws(() => buildConfig({ SLOT_ALLOCATIONS: "6,3,2" }), /exceeds MAX_TRADING_BUDGET_QUOTE/);
});

test("5/3/2 allocation by slot and lowest free slot first", () => {
  const s = fresh();
  assert.equal(risk.freeSlot(s), 1);
  assert.equal(risk.allocation(s, 1, 100).amount, 5);
  addPos(s, 1, "SOL-USDC");
  assert.equal(risk.freeSlot(s), 2);
  assert.equal(risk.allocation(s, 2, 100).amount, 3);
  addPos(s, 2, "XRP-USDC");
  assert.equal(risk.allocation(s, 3, 100).amount, 2);
  addPos(s, 3, "ETH-USDC");
  assert.equal(risk.freeSlot(s), null);
  assert.equal(risk.entryGate(s).ok, false);
  assert.ok(risk.entryGate(s).reasons.some((r) => r.code === "max_positions"));
});

test("allocation never exceeds remaining budget or available balance", () => {
  const s = fresh();
  addPos(s, 2, "XRP-USDC", { costBasisQuote: 8 }); // e.g. an adopted bigger holding
  assert.ok(Math.abs(risk.remainingBudget(s) - 2) < 1e-9);
  assert.equal(risk.allocation(s, 1, 100).amount, 2);
  const low = risk.allocation(fresh(), 1, 0.5);
  assert.equal(low.ok, false);
  assert.equal(low.reason.code, "insufficient_balance");
});

test("daily loss limit blocks new entries", () => {
  const s = fresh();
  risk.rollDay(s);
  risk.recordClose(s, { netPnl: -1.6, fees: 0.01, symbol: "SOL-USDC" });
  const g = risk.entryGate(s);
  assert.equal(g.ok, false);
  assert.ok(g.reasons.some((r) => r.code === "daily_loss_limit"));
});

test("daily trade limit and symbol cooldown", () => {
  const s = fresh();
  for (let i = 0; i < cfg.MAX_TRADES_PER_DAY; i++) risk.recordEntry(s);
  assert.ok(risk.entryGate(s).reasons.some((r) => r.code === "daily_trade_limit"));
  const s2 = fresh();
  risk.recordClose(s2, { netPnl: 0.1, fees: 0, symbol: "SOL-USDC" });
  assert.equal(risk.symbolGate(s2, "SOL-USDC").ok, false);
  clock.advance(61 * 60000);
  assert.equal(risk.symbolGate(s2, "SOL-USDC").ok, true);
});

test("no duplicate entry on a held symbol", () => {
  const s = fresh();
  addPos(s, 1, "SOL-USDC");
  assert.ok(risk.symbolGate(s, "SOL-USDC").reasons.some((r) => r.code === "already_held"));
});

test("critical discrepancy, missing reconciliation and emergency stop block entries", () => {
  const s = fresh();
  s.discrepancies.push({ kind: "balance_below_position", severity: "critical", resolved: false, symbol: "XRP-USDC" });
  assert.ok(risk.entryGate(s).reasons.some((r) => r.code === "critical_discrepancy"));
  const s2 = fresh();
  s2.reconciliation.ok = false;
  assert.ok(risk.entryGate(s2).reasons.some((r) => r.code === "not_reconciled"));
  const s3 = fresh();
  s3.emergencyStop = true;
  assert.ok(risk.entryGate(s3).reasons.some((r) => r.code === "emergency_stop"));
});

test("live mode requires explicit confirmation phrase and credentials", () => {
  assert.throws(() => buildConfig({ BOT_MODE: "live" }), /LIVE_TRADING_CONFIRMATION/);
});

test("stats track wins, losses, fees and drawdown net of fees", () => {
  const s = fresh();
  risk.recordClose(s, { netPnl: 0.5, fees: 0.01, symbol: "A-USDC" });
  risk.recordClose(s, { netPnl: -0.3, fees: 0.01, symbol: "B-USDC" });
  risk.recordClose(s, { netPnl: -0.2, fees: 0.01, symbol: "C-USDC" });
  assert.equal(s.stats.wins, 1);
  assert.equal(s.stats.losses, 2);
  assert.ok(Math.abs(s.stats.totalFees - 0.03) < 1e-12);
  assert.ok(Math.abs(s.stats.maxDrawdown - 0.5) < 1e-12);
});
