// npm run replay -- [--dir data/history] [--min-score 62] [--json out.json]
// Event-driven historical replay WITHOUT look-ahead:
//  - features at minute t use only candles closed at t
//  - entries fill at the OPEN of minute t+1, at ask = open*(1+spread/2+slippage), taker fee charged
//  - exits are checked on later candles with bid = price*(1-spread/2); a stop is filled at
//    min(stop, candle open) minus slippage (gaps are not filled at the stop price)
//  - capital: 10 USDC budget, slots 5/3/2, one position per asset, same profit plans as live
// It also reports forward returns after each signal (5/15/60 min) versus the unconditional
// baseline, which measures whether the scanner actually detects early movement.
import fs from "node:fs";
import path from "node:path";
import { computeFeatures } from "../src/signals/earlyMomentum.js";
import { scoreCandidate, DEFAULT_SIGNAL_PARAMS } from "../src/signals/scoring.js";
import { evaluateExit } from "../src/strategy/profitPlan.js";
import { arg } from "../src/cli/common.js";

export function runReplay({ series, meta, cfg, params = {}, minScore = 62, cooldownMin = 60, window = 200 }) {
  const fee = cfg.TAKER_FEE_PCT / 100;
  const slip = cfg.EST_SLIPPAGE_PCT / 100;
  const slots = cfg.SLOT_ALLOCATIONS.slice(0, cfg.MAX_OPEN_POSITIONS);
  const assets = meta.assets.filter((a) => series[a.ref]?.length > 120);
  const idx = Object.fromEntries(assets.map((a) => [a.ref, new Map(series[a.ref].map((c, i) => [c.start, i]))]));
  const times = [...new Set(assets.flatMap((a) => series[a.ref].map((c) => c.start)))].sort((a, b) => a - b);
  let cash = cfg.MAX_TRADING_BUDGET_QUOTE;
  const open = new Map(); // ref -> position
  const pending = []; // signals to fill next minute
  const trades = [];
  const signals = [];
  const cooldown = {};
  let equityPeak = 0;
  let realized = 0;
  let maxDD = 0;
  const rejectionCounts = {};

  for (const t of times) {
    // 1) fill pending entries at this minute's open
    for (const s of pending.splice(0)) {
      const a = s.asset;
      const i = idx[a.ref].get(t);
      if (i === undefined || open.has(a.ref)) continue;
      const usedSlots = new Set([...open.values()].map((p) => p.slot));
      const slot = [1, 2, 3].slice(0, slots.length).find((x) => !usedSlots.has(x));
      if (!slot) continue;
      const alloc = Math.min(slots[slot - 1], cash);
      if (alloc < cfg.MIN_POSITION_QUOTE) continue;
      const c = series[a.ref][i];
      const spread = (a.execSpreadPct ?? 0.2) / 100;
      const px = c.open * (1 + spread / 2 + slip);
      const qty = alloc / (1 + fee) / px;
      const cost = qty * px * (1 + fee);
      cash -= cost;
      open.set(a.ref, { asset: a, slot, plan: cfg.plans[slot - 1], entryPrice: px, qty, cost, openedAt: t, targetReached: false, peakBid: 0, score: s.score });
    }
    // 2) exits on this minute's candle (position opened at an earlier open)
    for (const [ref, p] of [...open]) {
      const i = idx[ref].get(t);
      if (i === undefined) continue;
      const c = series[ref][i];
      const spread = (p.asset.execSpreadPct ?? 0.2) / 100;
      const bidOf = (x) => x * (1 - spread / 2);
      // check worst case first (low), then high for target arming, then close
      const order = [bidOf(c.open), bidOf(c.low), bidOf(c.high), bidOf(c.close)];
      for (const bid of order) {
        const d = evaluateExit(p, { bid, reliable: true }, { stopLossPct: cfg.STOP_LOSS_PCT });
        if (d.updates.targetReached) p.targetReached = true;
        if (d.action === "exit") {
          const level = d.reason === "STOP_LOSS" ? d.levels.stopPrice : d.levels.floorPrice;
          const fillBid = Math.min(level, bidOf(c.open) < level ? bidOf(c.open) : level) * (1 - slip);
          const proceeds = p.qty * fillBid * (1 - fee);
          const pnl = proceeds - p.cost;
          cash += proceeds;
          realized += pnl;
          trades.push({ ref, exec: p.asset.exec, slot: p.slot, entry: p.entryPrice, exit: fillBid, reason: d.reason, pnl, holdMin: (t - p.openedAt) / 60000, score: p.score, openedAt: new Date(p.openedAt).toISOString() });
          open.delete(ref);
          cooldown[ref] = t + cooldownMin * 60000;
          break;
        }
      }
    }
    equityPeak = Math.max(equityPeak, realized);
    maxDD = Math.max(maxDD, equityPeak - realized);
    // 3) signals at the close of minute t
    for (const a of assets) {
      const i = idx[a.ref].get(t);
      if (i === undefined || i < 80) continue;
      const hist = series[a.ref].slice(Math.max(0, i - window + 1), i + 1);
      const f = computeFeatures(hist);
      const res = scoreCandidate(f, { spreadPct: a.execSpreadPct ?? 0.2, quoteVolume24h: Infinity, active: true }, { params, minScore, maxSpreadPct: cfg.MAX_SPREAD_PCT, minExecQuoteVolume: 0 });
      for (const r of res.rejections) rejectionCounts[r.code] = (rejectionCounts[r.code] || 0) + 1;
      if (!res.qualified) continue;
      const fwd = (k) => (series[a.ref][i + k] ? ((series[a.ref][i + k].close - f.close) / f.close) * 100 : null);
      signals.push({ ref: a.ref, t, score: res.score, ret5: f.ret5, ret60: f.ret60, relVol5: f.relVol5, fwd5: fwd(5), fwd15: fwd(15), fwd60: fwd(60) });
      if (!open.has(a.ref) && !(cooldown[a.ref] > t)) pending.push({ asset: a, score: res.score });
    }
    // keep only the best pending signal per minute (the live bot enters at most one per cycle)
    if (pending.length > 1) {
      pending.sort((x, y) => y.score - x.score);
      pending.splice(1);
    }
  }
  // mark open positions to market at the end (not counted as realized)
  let unrealized = 0;
  for (const [ref, p] of open) {
    const last = series[ref][series[ref].length - 1];
    unrealized += p.qty * last.close * (1 - (p.asset.execSpreadPct ?? 0.2) / 200) * (1 - fee) - p.cost;
  }
  // baseline forward returns (unconditional) for comparison
  const base = { fwd5: [], fwd15: [], fwd60: [] };
  for (const a of assets) {
    const s = series[a.ref];
    for (let i = 80; i + 60 < s.length; i += 7) {
      base.fwd5.push(((s[i + 5].close - s[i].close) / s[i].close) * 100);
      base.fwd15.push(((s[i + 15].close - s[i].close) / s[i].close) * 100);
      base.fwd60.push(((s[i + 60].close - s[i].close) / s[i].close) * 100);
    }
  }
  const stat = (arr) => {
    const v = arr.filter((x) => x !== null && Number.isFinite(x));
    if (!v.length) return { n: 0 };
    const sorted = [...v].sort((a, b) => a - b);
    return { n: v.length, mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4), median: +sorted[Math.floor(v.length / 2)].toFixed(4), pctPositive: +((v.filter((x) => x > 0).length / v.length) * 100).toFixed(1) };
  };
  const wins = trades.filter((x) => x.pnl > 0);
  const losses = trades.filter((x) => x.pnl <= 0);
  return {
    period: times.length ? { from: new Date(times[0]).toISOString(), to: new Date(times[times.length - 1]).toISOString(), minutes: times.length } : null,
    assets: assets.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? +(wins.length / trades.length).toFixed(3) : null,
    realizedNetPnl: +realized.toFixed(4),
    unrealizedAtEnd: +unrealized.toFixed(4),
    stillOpen: open.size,
    avgWin: wins.length ? +(wins.reduce((s, x) => s + x.pnl, 0) / wins.length).toFixed(4) : null,
    avgLoss: losses.length ? +(losses.reduce((s, x) => s + x.pnl, 0) / losses.length).toFixed(4) : null,
    maxDrawdown: +maxDD.toFixed(4),
    exitReasons: trades.reduce((m, x) => ((m[x.reason] = (m[x.reason] || 0) + 1), m), {}),
    avgHoldMin: trades.length ? +(trades.reduce((s, x) => s + x.holdMin, 0) / trades.length).toFixed(1) : null,
    signals: signals.length,
    signalForward: { fwd5: stat(signals.map((s) => s.fwd5)), fwd15: stat(signals.map((s) => s.fwd15)), fwd60: stat(signals.map((s) => s.fwd60)) },
    baselineForward: { fwd5: stat(base.fwd5), fwd15: stat(base.fwd15), fwd60: stat(base.fwd60) },
    signalRet60AtEntry: stat(signals.map((s) => s.ret60)),
    topRejections: Object.entries(rejectionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10),
    tradeList: trades.slice(-50)
  };
}

export function loadHistory(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const series = {};
  for (const a of meta.assets) {
    const f = path.join(dir, `${a.ref}.json`);
    if (!fs.existsSync(f)) continue;
    series[a.ref] = JSON.parse(fs.readFileSync(f, "utf8")).map(([start, open, high, low, close, volume]) => ({ start, open, high, low, close, volume }));
  }
  return { meta, series };
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("tools/replay.js")) {
  const { loadEnvFile, buildConfig } = await import("../src/config/index.js");
  loadEnvFile();
  const cfg = buildConfig({ ...process.env, BOT_MODE: "paper" });
  const dir = path.resolve(arg("dir", path.join(cfg.dataDir, "history")));
  const { meta, series } = loadHistory(dir);
  const minScore = Number(arg("min-score", cfg.MIN_SCORE));
  const t0 = Date.now();
  const r = runReplay({ series, meta, cfg, minScore, params: DEFAULT_SIGNAL_PARAMS, cooldownMin: cfg.SYMBOL_COOLDOWN_MIN });
  const { tradeList, ...summary } = r;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`replay took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (arg("json")) fs.writeFileSync(arg("json"), JSON.stringify(r, null, 2));
}
