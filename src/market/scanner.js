// Multi-stage scanner.
//  Stage A (radar, every ~5 s): ONE tickers request for the whole market. Filters the
//           USDC universe (status, stable bases, spread, liquidity) and computes fast
//           1m/3m changes from in-memory ticker snapshots - no candles needed.
//  Stage B (deep analysis): 1-minute candles of the asset's most liquid reference market
//           (USD/EUR/USDC). Radar-flagged assets are analysed first; every other eligible
//           asset is still refreshed round-robin, so early movers are not discarded just
//           because their 15m/60m change is still small.
//  Stage C (ranking): explainable score + named rejection reasons (signals/scoring.js).
//  Stage D (entry confirmation) lives in strategy/entryConfirm.js.
import { computeFeatures } from "../signals/earlyMomentum.js";
import { scoreCandidate, explain } from "../signals/scoring.js";
import { PRIORITY } from "../api/scheduler.js";

export class Scanner {
  constructor({ cfg, market, logger, clock = { now: () => Date.now() }, signalParams = {} }) {
    this.cfg = cfg;
    this.market = market;
    this.log = logger;
    this.clock = clock;
    this.signalParams = signalParams;
    this.universe = []; // [{exec, ref, base, stageA:{ok, reasons}, radar:{...}}]
    this.results = new Map(); // base -> last stage B/C result
    this.queue = [];
    this.rr = 0;
    this.rejectionCounts = {};
  }

  /** Stage A. Requires tickers to be fresh in MarketData. */
  radar() {
    const now = this.clock.now();
    const out = [];
    for (const pair of this.market.executionUniverse()) {
      const exec = this.market.tickers.get(pair.symbol);
      const ref = this.market.referenceFor(pair.base);
      const refTk = this.market.tickers.get(ref);
      const reasons = [];
      if (!exec || !exec.valid) reasons.push({ code: "no_quote", detail: "no valid bid/ask" });
      else {
        if (exec.spreadPct > this.cfg.MAX_SPREAD_PCT) reasons.push({ code: "spread_too_wide", detail: `${exec.spreadPct.toFixed(3)}%` });
        if ((exec.quoteVolume24h || 0) < this.cfg.MIN_EXEC_QUOTE_VOLUME_24H) reasons.push({ code: "illiquid_exec_pair", detail: `24h ${Math.round(exec.quoteVolume24h || 0)} USDC` });
      }
      if (!refTk || (refTk.quoteVolume24h || 0) < this.cfg.MIN_REF_QUOTE_VOLUME_24H) reasons.push({ code: "illiquid_reference", detail: `${ref} 24h ${Math.round(refTk?.quoteVolume24h || 0)}` });
      const ch1 = this.market.snapshotChange(ref, 60000);
      const ch3 = this.market.snapshotChange(ref, 180000);
      const ch5 = this.market.snapshotChange(ref, 300000);
      const accel = Number.isFinite(ch1) && Number.isFinite(ch3) ? ch1 - (ch3 - ch1) / 2 : NaN; // last minute vs average of the 2 before
      const radarScore = (Number.isFinite(ch1) ? Math.max(0, ch1) * 3 : 0) + (Number.isFinite(ch3) ? Math.max(0, ch3) : 0) + (Number.isFinite(accel) ? Math.max(0, accel) * 2 : 0);
      const flagged = reasons.length === 0 && ((ch1 >= 0.12) || (ch3 >= 0.3) || (accel >= 0.1));
      out.push({ base: pair.base, exec: pair.symbol, ref, stageA: { ok: reasons.length === 0, reasons }, radar: { ch1, ch3, ch5, accel, radarScore, flagged }, at: now });
    }
    this.universe = out;
    // Deep-analysis queue: flagged assets first (by radar score), then stale ones round-robin.
    const eligible = out.filter((u) => u.stageA.ok);
    const flagged = eligible.filter((u) => u.radar.flagged).sort((a, b) => b.radar.radarScore - a.radar.radarScore);
    const stale = eligible.filter((u) => !u.radar.flagged && this.market.candleAge(u.ref) >= this.cfg.CANDLE_REFRESH_MS);
    if (stale.length) this.rr = this.rr % stale.length;
    const rotated = stale.slice(this.rr).concat(stale.slice(0, this.rr));
    this.rr += 1;
    const seen = new Set();
    this.queue = [...flagged.map((u) => ({ u, flagged: true })), ...rotated.map((u) => ({ u, flagged: false }))].filter(({ u }) => !seen.has(u.base) && seen.add(u.base));
    return out;
  }

  /**
   * Stage B + C for up to `max` queued assets.
   * @returns {Array} qualified candidates sorted by score
   */
  async deep(max) {
    const now = this.clock.now();
    const batch = this.queue.splice(0, max);
    for (const { u, flagged } of batch) {
      try {
        const candles = await this.market.closedCandles(u.ref, { maxAgeMs: flagged ? 15000 : this.cfg.CANDLE_REFRESH_MS, priority: flagged ? PRIORITY.DEEP - 1 : PRIORITY.DEEP });
        const f = computeFeatures(candles);
        const exec = this.market.tickers.get(u.exec);
        const res = scoreCandidate(f, exec ? { spreadPct: exec.spreadPct, quoteVolume24h: exec.quoteVolume24h, active: true } : null, {
          params: this.signalParams,
          minScore: this.cfg.MIN_SCORE,
          maxSpreadPct: this.cfg.MAX_SPREAD_PCT,
          minExecQuoteVolume: this.cfg.MIN_EXEC_QUOTE_VOLUME_24H
        });
        for (const r of res.rejections) this.rejectionCounts[r.code] = (this.rejectionCounts[r.code] || 0) + 1;
        this.results.set(u.base, { base: u.base, exec: u.exec, ref: u.ref, score: res.score, qualified: res.qualified, rejections: res.rejections, components: res.components, explanation: explain(res, f), features: f, flagged, at: now, execAsk: exec?.ask });
      } catch (e) {
        this.log.warn("deep analysis failed", { ref: u.ref, err: e.message });
      }
    }
    return this.candidates();
  }

  /** Qualified, recent candidates (best first). */
  candidates(maxAgeMs = this.cfg.SIGNAL_MAX_AGE_MS) {
    const now = this.clock.now();
    return [...this.results.values()].filter((r) => r.qualified && now - r.at <= maxAgeMs).sort((a, b) => b.score - a.score);
  }

  /** Top entries for logs/dashboard (qualified or not). */
  leaderboard(n = 8) {
    return [...this.results.values()].sort((a, b) => b.score - a.score).slice(0, n).map((r) => ({
      symbol: r.exec, ref: r.ref, score: Number(r.score.toFixed(1)), qualified: r.qualified, flagged: r.flagged,
      why: r.qualified ? r.explanation : r.rejections.map((x) => `${x.code}(${x.detail})`).join("; "),
      ageSec: Math.round((this.clock.now() - r.at) / 1000)
    }));
  }
}
