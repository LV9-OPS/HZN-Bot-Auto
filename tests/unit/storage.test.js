import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StateStore, StateCorruptError } from "../../src/storage/stateStore.js";
import { Journal } from "../../src/storage/journal.js";
import { tmpDir, nullLogger } from "../helpers.js";

const LEGACY = {
  day: "2026-10-02", realizedPnl: 0, trades: [],
  positions: [{ symbol: "XRP-USDC", orderId: "6c93d13e-0a73-e20e-00c0-00b7007fe875", entryPrice: 1.5494, quoteSize: 9.999999, baseSize: 6.45411, highWatermark: 1.5494, pending: false, openedAt: "2026-10-02T00:00:00.000Z", slot: 1, profitPlan: 1, targetReached: false, floorArmed: false }]
};

function withPosition(store) {
  store.state.positions.p1 = { id: "p1", symbol: "SOL-USDC", slot: 1, plan: { targetMultiple: 2, floorMultiple: 1, name: "X2->X1" }, status: "open", allocationQuote: 5, qty: 0.05, entryPrice: 100, costBasisQuote: 5, targetReached: true, notes: [], exits: [] };
}

test("state survives a restart, including targetReached / armed floor", () => {
  const dir = tmpDir();
  const a = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  a.load();
  withPosition(a);
  a.save();
  const b = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  const { state, source } = b.load();
  assert.equal(source, "main");
  assert.equal(state.positions.p1.targetReached, true);
});

test("a corrupted state file is recovered from the newest valid backup (never replaced by empty state)", () => {
  const dir = tmpDir();
  const a = new StateStore({ dataDir: dir, mode: "live", logger: nullLogger() });
  a.load();
  withPosition(a);
  a.save({ backup: true });
  fs.writeFileSync(path.join(dir, "state.live.json"), '{"schemaVersion":3, "positions": {"p1": tru'); // torn write
  const b = new StateStore({ dataDir: dir, mode: "live", logger: nullLogger() });
  const r = b.load();
  assert.equal(r.source, "backup");
  assert.ok(r.state.positions.p1, "position not forgotten");
  assert.ok(fs.readdirSync(dir).some((f) => f.includes(".corrupt-")), "corrupt file quarantined");
});

test("if state and all backups are corrupt the bot refuses to start", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "state.live.json"), "garbage");
  const b = new StateStore({ dataDir: dir, mode: "live", logger: nullLogger() });
  assert.throws(() => b.load(), StateCorruptError);
});

test("an invalid state is never written over a good one", () => {
  const dir = tmpDir();
  const a = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  a.load();
  withPosition(a);
  a.save();
  a.state.positions.p1.status = "bogus";
  assert.throws(() => a.save(), StateCorruptError);
  const b = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  assert.equal(b.load().state.positions.p1.status, "open");
});

test("an interrupted write (leftover temp file) does not affect the previous state", () => {
  const dir = tmpDir();
  const a = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  a.load();
  withPosition(a);
  a.save();
  fs.writeFileSync(path.join(dir, "state.paper.json.tmp-999-1"), "{partial");
  const b = new StateStore({ dataDir: dir, mode: "paper", logger: nullLogger() });
  assert.ok(b.load().state.positions.p1);
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes(".tmp-")));
});

test("legacy state.json (the XRP case) is migrated as needs_reconciliation, never dropped or trusted blindly", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(LEGACY));
  const s = new StateStore({ dataDir: dir, mode: "live", logger: nullLogger() });
  const { state, source } = s.load();
  assert.equal(source, "legacy");
  const p = Object.values(state.positions)[0];
  assert.equal(p.symbol, "XRP-USDC");
  assert.equal(p.status, "needs_reconciliation");
  assert.equal(p.entry.venueOrderId, LEGACY.positions[0].orderId);
  assert.equal(p.plan.name, "X2->X1");
  // paper mode ignores the legacy live file
  const pdir = tmpDir();
  fs.writeFileSync(path.join(pdir, "state.json"), JSON.stringify(LEGACY));
  assert.equal(new StateStore({ dataDir: pdir, mode: "paper", logger: nullLogger() }).load().source, "fresh");
});

test("order registry journal survives torn last lines", () => {
  const dir = tmpDir();
  const j = new Journal({ dataDir: dir, mode: "live" });
  j.recordOrderIntent({ clientOrderId: "c1", symbol: "SOL-USDC", side: "buy" });
  j.recordOrderUpdate({ clientOrderId: "c1", venueOrderId: "v1" });
  fs.appendFileSync(path.join(dir, "orders.live.jsonl"), '{"clientOrderId":"c2","ty');
  const m = j.loadOrders();
  assert.equal(m.get("c1").venueOrderId, "v1");
  assert.equal(m.has("c2"), false);
});
