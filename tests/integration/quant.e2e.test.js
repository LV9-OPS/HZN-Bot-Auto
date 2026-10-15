// Quant mode end-to-end on a fake Revolut X API: 1h reference candles, decision engine,
// validation gate, decision log, paper execution.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Bot } from "../../src/bot.js";
import { makeCfg, nullLogger, rng } from "../helpers.js";

function hourly(n, drift, noise, seed, endT) {
  const r = rng(seed);
  const bars = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const ret = drift + (r() - 0.5) * 2 * noise;
    const o = p, c = p * (1 + ret);
    bars.push({ start: endT - (n - i) * 3600000, open: o, high: Math.max(o, c) * 1.002, low: Math.min(o, c) * 0.998, close: c, volume: 50 + r() * 20 });
    p = c;
  }
  return bars;
}

function fakeApi(clock, candles, last) {
  const mk = (b, q) => ({ base: b, quote: q, base_step: "0.0001", quote_step: "0.0001", min_order_size: "0.0001", max_order_size: "100000", min_order_size_quote: "0.1", max_order_size_quote: "1000000", status: "active" });
  const pairs = { "BTC/USD": mk("BTC", "USD"), "SOL/USD": mk("SOL", "USD"), "SOL/USDC": mk("SOL", "USDC"), "BTC/USDC": mk("BTC", "USDC") };
  const tick = (sym, p) => ({ symbol: sym, bid: (p * 0.9995).toFixed(4), ask: (p * 1.0005).toFixed(4), mid: p.toFixed(4), last_price: p.toFixed(4), quote_volume_24h: sym.endsWith("USD") ? "5000000" : "200000", volume_24h: "1" });
  return async (url) => {
    const u = new URL(url);
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith("/configuration/pairs")) return ok({ data: pairs });
    if (u.pathname.endsWith("/tickers")) return ok({ data: [tick("BTC/USD", last.BTC), tick("BTC/USDC", last.BTC), tick("SOL/USD", last.SOL), tick("SOL/USDC", last.SOL)], metadata: { timestamp: clock.now() } });
    const m = u.pathname.match(/candles\/([A-Z]+-[A-Z]+)/);
    if (m) return ok({ data: (candles[m[1]] || []).map((c) => ({ ...c, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: String(c.volume) })) });
    if (u.pathname.includes("order-book")) return ok({ data: { asks: [{ price: (last.SOL * 1.0005).toFixed(4), quantity: "1000" }], bids: [] } });
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => "nf" };
  };
}

async function setup({ validated, breakout = false }) {
  const cfg0 = makeCfg();
  const cfg = makeCfg({ DATA_DIR: cfg0.dataDir, ENTRY_MODE: "quant", QUANT_STRATEGIES: "trend,breakout,pullback", SYMBOL_COOLDOWN_MIN: "0" });
  if (validated) fs.writeFileSync(path.join(cfg.dataDir, "strategy-validation.json"), JSON.stringify({ verdict: { trend: { validated: true, meanNetPct: 0.8, n: 40 }, breakout: { validated: true, meanNetPct: 0.5, n: 35 }, pullback: { validated: true, meanNetPct: 0.3, n: 50 } } }));
  const clock = { offset: 0, now() { return Date.now() + this.offset; } };
  const endT = Math.floor(Date.now() / 3600000) * 3600000;
  const btc = hourly(3000, 0.0012, 0.012, 1, endT);
  const sol = hourly(3000, 0.0015, 0.015, 2, endT);
  if (breakout) {
    // last closed bar: first close above the previous 55-bar high, on strong volume, not overextended
    const prevHigh = Math.max(...sol.slice(-56, -1).map((b) => b.high));
    for (const b of sol.slice(-56, -1)) { b.high = Math.min(b.high, prevHigh); b.close = Math.min(b.close, prevHigh * 0.995); b.open = Math.min(b.open, prevHigh * 0.995); }
    for (const b of sol.slice(-6, -1)) { b.open = prevHigh * 0.996; b.close = prevHigh * 0.997; b.high = prevHigh * 0.999; b.low = prevHigh * 0.994; }
    const last = sol.at(-1);
    last.open = prevHigh * 0.998; last.close = prevHigh * 1.006; last.high = last.close * 1.001; last.low = last.open * 0.999; last.volume = 400;
  }
  const last = { BTC: btc.at(-1).close, SOL: sol.at(-1).close };
  const fetchImpl = fakeApi(clock, { "BTC-USD": btc, "SOL-USD": sol }, last);
  const bot = new Bot({ cfg, logger: nullLogger(), fetchImpl, discordFetch: async () => ({ ok: true, status: 204 }), clock, sleep: async (ms) => { clock.offset += ms; } });
  await bot.init();
  return { bot, cfg };
}

test("quant mode: without out-of-sample validation the bot refuses to trade and logs why", async () => {
  const { bot, cfg } = await setup({ validated: false });
  await bot.quantCycle();
  assert.equal(Object.keys(bot.state.positions).length, 0);
  const log = fs.readFileSync(path.join(cfg.dataDir, "decisions.paper.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const cycle = log.find((d) => d.kind === "cycle");
  assert.ok(cycle, "cycle summary logged");
  assert.deepEqual(cycle.validated, []);
  await bot.stop("test");
});

test("quant mode: with validated strategies the full pipeline can enter a paper position with an ATR stop", async () => {
  const { bot } = await setup({ validated: true, breakout: true });
  await bot.quantCycle();
  const sum = bot.quant.lastSummary;
  assert.ok(sum, "cycle ran");
  const pos = Object.values(bot.state.positions);
  assert.equal(pos.length, 1, JSON.stringify(sum));
  const p = pos[0];
  assert.equal(p.symbol, "SOL-USDC");
  assert.equal(p.plan.mode, "quant");
  assert.equal(p.plan.strategy, "breakout");
  assert.ok(p.plan.stopPrice > 0 && p.plan.stopPrice < p.entryPrice, "ATR stop below the real fill");
  assert.ok(p.costBasisQuote <= 5 + 1e-9, "slot 1 cap");
  assert.ok(p.costBasisQuote * (1 - p.plan.stopPrice / p.entryPrice) <= 0.1 + 0.03, "planned loss ~ 1% of equity");
  assert.ok(p.log.some((e) => e.event === "entry_filled"));
  await bot.stop("test");
});
