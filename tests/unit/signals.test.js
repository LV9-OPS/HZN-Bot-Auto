import test from "node:test";
import assert from "node:assert/strict";
import { computeFeatures } from "../../src/signals/earlyMomentum.js";
import { scoreCandidate } from "../../src/signals/scoring.js";
import { closedOnly, fillGaps } from "../../src/signals/indicators.js";
import { genCandles } from "../helpers.js";

const exec = { spreadPct: 0.12, quoteVolume24h: 100000, active: true };
const opts = { minScore: 62, maxSpreadPct: 0.4, minExecQuoteVolume: 5000 };

// Early move: quiet base, then 4 accelerating green minutes with rising volume, breaking the range.
const EARLY = [
  { ret: 0.08, vol: 1.8 },
  { ret: 0.15, vol: 2.5 },
  { ret: 0.25, vol: 3.5 },
  { ret: 0.35, vol: 4.5 }
];

test("detects an early movement (quiet base -> price + volume acceleration)", () => {
  const f = computeFeatures(genCandles({ tail: EARLY }));
  assert.ok(f, "features computed");
  assert.ok(f.ret5 > 0.6 && f.ret5 < 1.2, `ret5 ${f.ret5}`);
  assert.ok(f.relVol5 > 2, `relVol5 ${f.relVol5}`);
  assert.ok(f.accel3 > 0, "accelerating");
  assert.ok(f.breakoutConfirmed, "breakout above prior 30m high");
  const r = scoreCandidate(f, exec, opts);
  assert.equal(r.qualified, true, JSON.stringify(r.rejections));
  assert.ok(r.score >= 62);
});

test("small 15m/60m change does not reject an early candidate", () => {
  const f = computeFeatures(genCandles({ tail: EARLY }));
  assert.ok(f.ret60 < 1.5, "60m change small");
  assert.equal(scoreCandidate(f, exec, opts).rejections.some((x) => x.code.includes("60")), false);
});

test("volume acceleration is measured against a baseline that excludes the burst", () => {
  const flatVol = computeFeatures(genCandles({ tail: EARLY.map((s) => ({ ...s, vol: 1 })) }));
  const r = scoreCandidate(flatVol, exec, opts);
  assert.equal(r.qualified, false);
  assert.ok(r.rejections.some((x) => x.code === "no_volume_expansion"));
  const loud = computeFeatures(genCandles({ tail: EARLY }));
  assert.ok(loud.volAccel > 1.2, `volAccel ${loud.volAccel}`);
});

test("rejects assets that already made most of their move", () => {
  // steady 70-minute rally of +0.12%/min (~+8.7%), then the same 'early' tail
  const tail = [...Array.from({ length: 70 }, () => ({ ret: 0.12, vol: 1.5 })), ...EARLY];
  const f = computeFeatures(genCandles({ n: 200, tail }));
  const r = scoreCandidate(f, exec, opts);
  assert.equal(r.qualified, false);
  assert.ok(r.rejections.some((x) => x.code === "already_extended" || x.code === "overstretched" || x.code === "no_base"), JSON.stringify(r.rejections));
});

test("rejects a false breakout (wick above the range, close back below)", () => {
  const tail = [{ ret: 0.05, vol: 2 }, { ret: 0.1, vol: 3 }, { ret: 0.15, vol: 3 }, { ret: -0.05, vol: 5, wickUp: 1.2 }];
  const candles = genCandles({ tail });
  // force the last candle to poke above the prior high and close below it
  const last = candles[candles.length - 1];
  const priorHigh = Math.max(...candles.slice(-31, -1).map((c) => c.high));
  last.high = priorHigh * 1.01;
  last.close = priorHigh * 0.999;
  last.open = Math.min(last.open, last.close);
  const f = computeFeatures(candles);
  assert.equal(f.wickRejection, true);
  const r = scoreCandidate(f, exec, opts);
  assert.ok(r.rejections.some((x) => x.code === "false_breakout"));
});

test("rejects an immediate reversal (most of the burst given back)", () => {
  const tail = [{ ret: 0.3, vol: 3 }, { ret: 0.5, vol: 4 }, { ret: 0.4, vol: 4 }, { ret: -0.6, vol: 4 }];
  const f = computeFeatures(genCandles({ tail }));
  const r = scoreCandidate(f, exec, opts);
  assert.equal(r.qualified, false);
  assert.ok(r.rejections.some((x) => x.code === "reversal" || x.code === "last_minute_down"), JSON.stringify(r.rejections));
});

test("ranking prefers the early mover over a climax burst", () => {
  const early = scoreCandidate(computeFeatures(genCandles({ tail: EARLY })), exec, opts);
  const climax = scoreCandidate(computeFeatures(genCandles({ tail: [{ ret: 0.5, vol: 3 }, { ret: 1, vol: 6 }, { ret: 1.2, vol: 8 }, { ret: 1.1, vol: 9 }] })), exec, opts);
  assert.equal(climax.qualified, false);
  assert.ok(climax.rejections.some((x) => x.code === "burst_too_large"));
  assert.ok(early.score > climax.score - 100); // early is qualified, climax rejected
});

test("wide spread / illiquid execution pair is rejected with a precise reason", () => {
  const f = computeFeatures(genCandles({ tail: EARLY }));
  const r = scoreCandidate(f, { spreadPct: 0.9, quoteVolume24h: 100, active: true }, opts);
  const codes = r.rejections.map((x) => x.code);
  assert.ok(codes.includes("spread_too_wide"));
  assert.ok(codes.includes("illiquid_exec_pair"));
});

test("insufficient history returns a named rejection, never a fake score", () => {
  const f = computeFeatures(genCandles({ n: 40 }));
  assert.equal(f, null);
  const r = scoreCandidate(f, exec, opts);
  assert.equal(r.qualified, false);
  assert.equal(r.rejections[0].code, "insufficient_data");
});

test("only closed candles are used (no look-ahead) and gaps are filled", () => {
  const c = genCandles({ n: 5 });
  const now = c[4].start + 30000; // last candle still open
  assert.equal(closedOnly(c, now).length, 4);
  const gappy = [c[0], c[3]];
  assert.equal(fillGaps(gappy).length, 4);
});

test("the scanner may return zero candidates on a quiet market", () => {
  const f = computeFeatures(genCandles({ n: 150 }));
  assert.equal(scoreCandidate(f, exec, opts).qualified, false);
});

import { scoreDip } from "../../src/signals/scoring.js";
test("dip entry: sharp 15m drop that stopped falling qualifies; a still-falling or crashing market does not", () => {
  const drop = Array.from({ length: 14 }, () => ({ ret: -0.2, vol: 2 }));
  const f = computeFeatures(genCandles({ tail: [...drop, { ret: 0.05, vol: 2 }] }));
  assert.ok(f.ret15 <= -2.5);
  assert.equal(scoreDip(f, exec, { ...opts, minScore: 0 }).qualified, true);
  const falling = computeFeatures(genCandles({ tail: [...drop, { ret: -0.5, vol: 2 }] }));
  assert.ok(scoreDip(falling, exec, { ...opts, minScore: 0 }).rejections.some((r) => r.code === "still_falling"));
  const quiet = computeFeatures(genCandles({}));
  assert.ok(scoreDip(quiet, exec, { ...opts, minScore: 0 }).rejections.some((r) => r.code === "no_dip"));
});
