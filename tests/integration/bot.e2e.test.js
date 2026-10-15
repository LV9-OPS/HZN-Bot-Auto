// End-to-end paper run: fake Revolut X HTTP API (public endpoints) + real Bot,
// scanner, scheduler, paper exchange, state store and reconciliation.
import test from "node:test";
import assert from "node:assert/strict";
import { Bot } from "../../src/bot.js";
import { makeCfg, genCandles, nullLogger } from "../helpers.js";

class OffsetClock {
  constructor() { this.offset = 0; }
  now() { return Date.now() + this.offset; }
  advance(ms) { this.offset += ms; }
}

/** Scripted market served through a fake fetch. */
class FakeRevx {
  constructor(clock) {
    this.clock = clock;
    this.prices = { "SOL-USDC": 100, "SOL-USD": 100, "XRP-USDC": 1.3, "XRP-USD": 1.3 };
    this.spread = 0.001;
    this.calls = [];
    this.candles = {};
  }
  setPrice(sym, p) { this.prices[sym] = p; }
  pairs() {
    const mk = (b, q) => ({ base: b, quote: q, base_step: "0.0001", quote_step: "0.0001", min_order_size: "0.0001", max_order_size: "100000", min_order_size_quote: "0.1", max_order_size_quote: "1000000", status: "active" });
    return { data: { "SOL/USDC": mk("SOL", "USDC"), "SOL/USD": mk("SOL", "USD"), "XRP/USDC": mk("XRP", "USDC"), "XRP/USD": mk("XRP", "USD") } };
  }
  ticker(sym) {
    const p = this.prices[sym];
    const bid = p * (1 - this.spread / 2), ask = p * (1 + this.spread / 2);
    return { symbol: sym.replace("-", "/"), bid: bid.toFixed(4), ask: ask.toFixed(4), mid: p.toFixed(4), last_price: p.toFixed(4), index_price: p.toFixed(4), quote_volume_24h: sym.endsWith("USD") ? "2000000" : "150000", volume_24h: "1000", high_24h: (p * 1.05).toFixed(4), low_24h: (p * 0.95).toFixed(4), price_change_24h: "0" };
  }
  fetch = async (url) => {
    const u = new URL(url);
    this.calls.push(u.pathname);
    const ok = (body) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith("/public/configuration/pairs")) return ok(this.pairs());
    if (u.pathname.endsWith("/public/tickers")) return ok({ data: Object.keys(this.prices).map((s) => this.ticker(s)), metadata: { timestamp: this.clock.now() } });
    const m = u.pathname.match(/public\/candles\/([A-Z]+-[A-Z]+)/);
    if (m) return ok({ data: (this.candles[m[1]] || []).map((c) => ({ ...c, open: String(c.open), high: String(c.high), low: String(c.low), close: String(c.close), volume: String(c.volume) })) });
    const ob = u.pathname.match(/order-book\/([A-Z]+-[A-Z]+)/);
    if (ob) {
      const t = this.ticker(ob[1]);
      return ok({ data: { asks: [{ price: t.ask, quantity: "1000" }], bids: [{ price: t.bid, quantity: "1000" }] } });
    }
    return { ok: false, status: 404, headers: { get: () => null }, text: async () => "nf" };
  };
}

function setupBot(dataDir) {
  const clock = new OffsetClock();
  const cfg = makeCfg({ DATA_DIR: dataDir, API_PUBLIC_PER_SEC: "1", SYMBOL_COOLDOWN_MIN: "0" });
  const fake = new FakeRevx(clock);
  const minute = Math.floor(clock.now() / 60000) * 60000;
  const start = minute - 150 * 60000;
  // SOL-USD: quiet base then an early move ending at the last closed minute
  const sol = genCandles({ n: 150, start, price: 100, tail: [{ ret: 0.08, vol: 1.8 }, { ret: 0.15, vol: 2.5 }, { ret: 0.25, vol: 3.5 }, { ret: 0.35, vol: 4.5 }] });
  fake.candles["SOL-USD"] = sol;
  fake.candles["XRP-USD"] = genCandles({ n: 150, start, price: 1.3, seed: 3 });
  const last = sol[sol.length - 1].close;
  fake.setPrice("SOL-USD", last);
  fake.setPrice("SOL-USDC", last);
  const bot = new Bot({ cfg, logger: nullLogger(), fetchImpl: fake.fetch, discordFetch: async () => ({ ok: true, status: 204 }), clock, sleep: async (ms) => clock.advance(ms) });
  return { bot, fake, clock, cfg };
}

test("paper end-to-end: early mover -> confirmed entry -> stop-loss exit -> restart keeps state", async () => {
  const { bot, fake, clock, cfg } = setupBot(makeCfg().dataDir);
  const rep = await bot.init();
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.equal(bot.state.reconciliation.ok, true);

  for (let i = 0; i < 4 && !Object.keys(bot.state.positions).length; i++) {
    clock.advance(1100);
    await bot.scanCycle();
  }
  const positions = Object.values(bot.state.positions);
  assert.equal(positions.length, 1, "one entry: " + JSON.stringify(bot.scanner.leaderboard(3)));
  const p = positions[0];
  assert.equal(p.symbol, "SOL-USDC");
  assert.equal(p.slot, 1);
  assert.equal(p.status, "open");
  assert.ok(p.costBasisQuote <= 5 + 1e-9, "slot 1 allocation 5 USDC");
  assert.equal(p.plan.name, "X2->X1");

  // price falls 4% -> stop-loss on bid
  fake.setPrice("SOL-USDC", p.entryPrice * 0.96);
  clock.advance(2100);
  await bot.monitorPositions();
  assert.equal(Object.keys(bot.state.positions).length, 0, "exited");
  const closed = bot.state.history.at(-1);
  assert.equal(closed.exitReason, "STOP_LOSS");
  assert.ok(closed.realizedNetPnl < 0);
  assert.ok(bot.state.stats.totalFees > 0);
  const quote = bot.state.paper.balances.USDC;
  assert.ok(quote < 10 && quote > 9.7, `paper USDC ${quote}`);
  await bot.stop("test");

  // restart on the same data dir
  const again = setupBot(cfg.dataDir);
  await again.bot.init();
  assert.equal(again.bot.state.history.length, bot.state.history.length);
  assert.ok(Math.abs(again.bot.state.paper.balances.USDC - quote) < 1e-12);
  await again.bot.stop("test");
});

test("open position and armed floor survive a crash/restart and are reconciled before trading", async () => {
  const { bot, fake, clock, cfg } = setupBot(makeCfg().dataDir);
  await bot.init();
  for (let i = 0; i < 4 && !Object.keys(bot.state.positions).length; i++) { clock.advance(1100); await bot.scanCycle(); }
  const p = Object.values(bot.state.positions)[0];
  assert.ok(p);
  fake.setPrice("SOL-USDC", p.entryPrice * 2.05); // X2 reached
  clock.advance(2100);
  await bot.monitorPositions();
  assert.equal(bot.state.positions[p.id].targetReached, true);
  // simulate crash: no graceful stop, new process
  const again = setupBot(cfg.dataDir);
  again.fake.setPrice("SOL-USDC", p.entryPrice * 1.5);
  await again.bot.init();
  const q = again.bot.state.positions[p.id];
  assert.equal(q.targetReached, true, "armed floor persisted");
  assert.equal(again.bot.state.reconciliation.ok, true);
  // retrace to X1 (entry) -> exit
  again.fake.setPrice("SOL-USDC", p.entryPrice * 0.999);
  again.clock.advance(2100);
  await again.bot.monitorPositions();
  assert.equal(again.bot.state.history.at(-1).exitReason, "X2_RETRACE_TO_X1");
  await again.bot.stop("test");
});

test("a second bot instance on the same data is refused", async () => {
  const { acquireLock } = await import("../../src/monitoring/instanceLock.js");
  const dir = makeCfg().dataDir;
  const a = acquireLock(dir, "paper");
  assert.throws(() => acquireLock(dir, "paper"), /Another HZN bot instance/);
  a.release();
  const b = acquireLock(dir, "paper");
  b.release();
});

test("scan cycles never overlap (task guard) even when a cycle is slower than its interval", async () => {
  const { bot } = setupBot(makeCfg().dataDir);
  await bot.init();
  let concurrent = 0;
  let maxConcurrent = 0;
  let runs = 0;
  bot.scanCycle = async () => {
    concurrent++;
    runs++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 300));
    concurrent--;
  };
  bot.radarIntervalMs = 1; // pathological interval
  bot.sleep = (ms) => new Promise((r) => setTimeout(r, 20));
  const loop = bot.run();
  await new Promise((r) => setTimeout(r, 1000));
  await bot.stop("test");
  await loop;
  assert.ok(runs >= 2);
  assert.equal(maxConcurrent, 1);
});

test("exchange downtime: no price -> no exit at an invented price, critical alert after the outage threshold", async () => {
  const { bot, fake, clock } = setupBot(makeCfg().dataDir);
  await bot.init();
  for (let i = 0; i < 4 && !Object.keys(bot.state.positions).length; i++) { clock.advance(1100); await bot.scanCycle(); }
  const p = Object.values(bot.state.positions)[0];
  assert.ok(p);
  const sent = [];
  const orig = bot.notifier.send.bind(bot.notifier);
  bot.notifier.send = (t, o) => { sent.push(t); return orig(t, o); };
  const realFetch = fake.fetch;
  bot.client.fetch = async () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => "down" });
  bot.client.sleep = async () => {};
  clock.advance(130000);
  await bot.monitorPositions();
  assert.ok(bot.state.positions[p.id], "position untouched");
  assert.ok(sent.some((t) => t.includes("Aucun prix fiable")), "critical alert sent");
  assert.ok(!bot.apiHealthy() || bot.client.consecutiveFailures >= 1);
  bot.client.fetch = realFetch;
  await bot.stop("test");
});
