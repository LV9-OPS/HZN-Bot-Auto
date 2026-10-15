import test from "node:test";
import assert from "node:assert/strict";
import { runReplay } from "../../tools/replay.js";
import { makeCfg, genCandles } from "../helpers.js";

test("replay fills entries at the NEXT minute's open (no look-ahead) and applies costs", () => {
  const cfg = makeCfg();
  const start = Date.UTC(2026, 9, 1);
  const c = genCandles({ n: 160, start, price: 100, tail: [{ ret: 0.08, vol: 1.8 }, { ret: 0.15, vol: 2.5 }, { ret: 0.25, vol: 3.5 }, { ret: 0.35, vol: 4.5 }, { ret: -2, vol: 2 }, { ret: -2, vol: 2 }, { ret: 0, vol: 1 }, { ret: 0, vol: 1 }, { ret: 0, vol: 1 }, { ret: 0, vol: 1 }] });
  const meta = { assets: [{ base: "SOL", exec: "SOL-USDC", ref: "SOL-USD", execSpreadPct: 0.1 }] };
  const r = runReplay({ series: { "SOL-USD": c }, meta, cfg, minScore: 62 });
  assert.ok(r.signals >= 1, "signal found");
  assert.equal(r.trades, 1);
  const t = r.tradeList[0];
  const signalIdx = c.length - 7; // last tail candle of the early move
  const entryCandle = c[signalIdx + 1];
  assert.ok(Math.abs(t.entry - entryCandle.open * (1 + 0.0005 + 0.0005)) < 1e-9, "entry at next open + half spread + slippage");
  assert.equal(t.reason, "STOP_LOSS");
  assert.ok(t.pnl < -0.15, "loss includes the gap, fees and spread");
});
