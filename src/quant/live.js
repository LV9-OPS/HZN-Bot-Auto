// Live/paper integration of the quant decision engine (ENTRY_MODE=quant).
// Every QUANT_CYCLE_MS (15 min): refresh 1h candles of each asset's reference market,
// run the decision engine on the last CLOSED bar, log every decision, and enter at most
// one position per cycle through the regular OrderManager (idempotent orders, stage-D
// confirmation, reconciliation). At each new closed bar it also updates trailing stops,
// time stops and signal exits of open quant positions. Stops themselves are checked
// on the bid every few seconds by the position monitor (software protection).
import fs from "node:fs";
import path from "node:path";
import { computeFeatureSet } from "./features.js";
import { decide } from "./decision.js";
import { signalExit } from "./strategies.js";
import { RISK_DEFAULTS } from "./risk.js";
import { confirmEntry } from "../strategy/entryConfirm.js";
import { PRIORITY } from "../api/scheduler.js";
import { appendLineDurable } from "../storage/atomicFile.js";
import { splitSymbol } from "../util/symbols.js";

const HOUR = 3600000;

export class QuantLive {
  constructor({ cfg, client, market, risk, store, orders, notifier, logger, clock = { now: () => Date.now() }, exchange }) {
    Object.assign(this, { cfg, client, market, risk, store, orders, notifier, log: logger, clock, exchange });
    this.cache = new Map(); // ref symbol -> { bars, fetchedAt }
    this.decisionsFile = path.join(cfg.dataDir, `decisions.${cfg.BOT_MODE}.jsonl`);
    this.lastSummary = null;
  }

  get state() {
    return this.store.state;
  }

  enabledStrategies() {
    const wanted = this.cfg.QUANT_STRATEGIES.map((s) => s.toLowerCase());
    const stats = this.validationStats();
    const disabled = this.state.strategyStatus || {};
    return {
      enabled: wanted.filter((s) => !(disabled[s]?.disabled)),
      stats,
      disabled: Object.entries(disabled).filter(([, v]) => v.disabled).map(([k]) => k)
    };
  }

  validationStats() {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.cfg.dataDir, "strategy-validation.json"), "utf8"));
      return v.verdict || {};
    } catch {
      return {};
    }
  }

  async bars(ref) {
    const now = this.clock.now();
    const c = this.cache.get(ref);
    const lastClosed = Math.floor(now / HOUR) * HOUR - HOUR;
    if (c && c.bars.length && c.bars[c.bars.length - 1].t >= lastClosed) return c.bars;
    const since = c?.bars?.length ? c.bars[c.bars.length - 1].t : now - 130 * 86400000;
    const raw = await this.client.getCandles(ref, { interval: 60, since, until: now }, PRIORITY.DEEP);
    const merged = new Map((c?.bars || []).map((b) => [b.t, b]));
    for (const k of raw) if (k.start + HOUR <= now) merged.set(k.start, { t: k.start, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume * k.close });
    const bars = [...merged.values()].sort((a, b) => a.t - b.t).slice(-24 * 130);
    this.cache.set(ref, { bars, fetchedAt: now });
    return bars;
  }

  logDecision(d) {
    try {
      appendLineDurable(this.decisionsFile, JSON.stringify(d));
    } catch { /* best effort */ }
  }

  portfolioSnapshot(quoteAvailable) {
    const s = this.state;
    this.risk.rollDay(s);
    const active = this.risk.activePositions(s);
    const deployed = this.risk.deployedQuote(s);
    let marks = 0;
    for (const p of active) {
      const tk = this.market.freshTicker(p.symbol, 120000);
      marks += tk?.bid && p.qty ? p.qty * tk.bid : p.costBasisQuote || 0;
    }
    const equity = Math.min(this.risk.budget() + (s.stats.realizedNetPnl || 0), quoteAvailable + marks);
    const ls = this.risk.lossStreak(s);
    return {
      equity, peakEquity: 0, cash: quoteAvailable, deployed, budget: this.risk.budget(), freeSlot: this.risk.freeSlot(s),
      monthStartEquity: s.monthly?.startEquity || this.risk.budget(), monthPnl: s.monthly?.realizedNetPnl || 0,
      dayStartEquity: this.risk.budget(), dayPnl: s.daily.realizedNetPnl,
      lossStreak: ls.n, lastLossAt: ls.lastAt, emergency: Boolean(this.cfg.EMERGENCY_STOP || s.emergencyStop),
      positions: active.map((p) => ({ asset: splitSymbol(p.symbol).base }))
    };
  }

  /** One decision cycle. */
  async cycle() {
    const now = this.clock.now();
    await this.market.refreshPairs();
    await this.market.refreshAllTickers(PRIORITY.RADAR);
    const universe = this.market.executionUniverse();
    const btcRef = this.market.referenceFor("BTC");
    const btcBars = await this.bars(btcRef);
    const btcF = computeFeatureSet(btcBars);
    const featureCache = new Map([["BTC", { bars: btcBars, f: btcF }]]);
    const { enabled, stats, disabled } = this.enabledStrategies();

    // manage open quant positions at the new closed bar
    await this.manageOpen(featureCache);

    const gate = this.risk.entryGate(this.state, { apiHealthy: true });
    const balances = await this.exchange.getBalances();
    const quoteAvailable = balances.get(this.cfg.QUOTE_CURRENCY)?.available ?? 0;
    const pf = this.portfolioSnapshot(quoteAvailable);
    const rp = { ...RISK_DEFAULTS, riskPerTradePct: this.cfg.RISK_PER_TRADE_PCT, maxPositions: this.cfg.MAX_OPEN_POSITIONS, slotAllocations: this.cfg.SLOT_ALLOCATIONS, minPositionQuote: this.cfg.MIN_POSITION_QUOTE, maxCorrelation: this.cfg.MAX_CORRELATION, monthlyLossPct: this.cfg.MONTHLY_LOSS_PCT, monthlyLimitAction: this.cfg.MONTHLY_LIMIT_ACTION, maxDrawdownPct: this.cfg.MAX_DRAWDOWN_PCT, lossStreakPause: this.cfg.LOSS_STREAK_PAUSE || 999, lossStreakPauseHours: this.cfg.LOSS_STREAK_PAUSE_HOURS };
    const summary = { at: new Date(now).toISOString(), kind: "cycle", enabled, disabled, validated: Object.entries(stats).filter(([, v]) => v.validated).map(([k]) => k), gate: gate.ok ? "ok" : gate.reasons.map((r) => r.code), rejections: {}, candidates: [] };
    const cands = [];
    const returnsCache = new Map();
    for (const pair of universe) {
      const base = pair.base;
      try {
        const ref = this.market.referenceFor(base);
        const bars = base === "BTC" ? btcBars : await this.bars(ref);
        if (bars.length < 24 * 100) { summary.rejections.insufficient_history = (summary.rejections.insufficient_history || 0) + 1; continue; }
        const f = base === "BTC" ? btcF : computeFeatureSet(bars);
        featureCache.set(base, { bars, f });
        returnsCache.set(base, f.ret1.slice(-24 * 30));
        const i = bars.length - 1;
        const tk = this.market.tickers.get(pair.symbol);
        const d = decide({
          asset: base, f, i, market: { f: btcF, i: btcBars.length - 1 }, now, barTime: bars[i].t + HOUR, maxBarAgeMs: 2 * HOUR,
          exec: { spreadPct: tk?.spreadPct ?? NaN, takerFeePct: this.cfg.TAKER_FEE_PCT, slippagePct: this.cfg.EST_SLIPPAGE_PCT },
          pf, enabled, stats, requireValidated: this.cfg.QUANT_REQUIRE_VALIDATION, riskParams: rp,
          returnsFor: (a) => returnsCache.get(a) || (featureCache.get(a)?.f.ret1.slice(-24 * 30) ?? [])
        });
        d.symbol = pair.symbol;
        d.reference = ref;
        if (d.action === "enter") cands.push(d);
        else summary.rejections[d.rejection] = (summary.rejections[d.rejection] || 0) + 1;
        if (d.action === "enter" || (d.steps.signals && d.steps.signals.length)) this.logDecision(d);
      } catch (e) {
        summary.rejections.data_error = (summary.rejections.data_error || 0) + 1;
        this.log.warn("quant decision failed", { base, err: e.message });
      }
    }
    summary.candidates = cands.map((c) => ({ symbol: c.symbol, strategy: c.signal.strategy, score: +c.signal.score.toFixed(1), quote: c.quote }));
    this.logDecision(summary);
    this.lastSummary = summary;
    if (!cands.length || !gate.ok) return summary;

    const best = cands.sort((a, b) => b.signal.score - a.signal.score)[0];
    const sg = this.risk.symbolGate(this.state, best.symbol);
    if (!sg.ok) return summary;
    // Stage D on fresh execution data
    await this.market.refreshTickers([best.symbol], PRIORITY.ORDER);
    let book = null;
    try { book = await this.client.getOrderBook(best.symbol, 20, PRIORITY.ORDER); } catch { /* optional */ }
    const tk = this.market.freshTicker(best.symbol);
    const conf = confirmEntry({ signal: { symbol: best.symbol, createdAt: now, execAskAtSignal: tk?.ask }, ticker: tk, book, pair: this.market.pair(best.symbol), allocationQuote: best.quote, now: this.clock.now(), cfg: { ...this.cfg, STOP_LOSS_PCT: best.signal.stopPct } });
    if (!conf.ok) {
      this.logDecision({ at: new Date().toISOString(), kind: "stage_d_reject", symbol: best.symbol, reasons: conf.reasons });
      return summary;
    }
    const slot = this.risk.freeSlot(this.state);
    const plan = { mode: "quant", strategy: best.signal.strategy, name: `${best.signal.strategy} ATRx${(best.signal.stopPct).toFixed(1)}%`, stopPrice: tk.ask * (1 - best.signal.stopPct / 100), targetPrice: best.signal.targetPct > 0 ? tk.ask * (1 + best.signal.targetPct / 100) : 0, trailAtr: best.signal.trailAtr, maxHoldBars: best.signal.maxHoldBars, exitOnSignal: best.signal.exitOnSignal, reference: best.reference };
    this.notifier.entryDecision({ candidate: { exec: best.symbol, explanation: `${best.signal.strategy} | régime ${best.steps.regime.label} | ${best.signal.reasons.join(", ")} | ${best.steps.expectation.calibrated ? "espérance OOS " + best.steps.expectation.meanNetPct + "%" : "score heuristique (non calibré)"}` }, slot, plan, allocation: best.quote, order: conf.order, costs: conf.costs });
    await this.orders.openPosition({
      symbol: best.symbol, slot, plan, allocationQuote: best.quote, order: conf.order,
      signal: { score: best.signal.score, explanation: `${best.signal.strategy}: ${best.signal.reasons.join(", ")}`, reference: best.reference, decisionPrice: tk.ask, quant: { stopPct: best.signal.stopPct, targetPct: best.signal.targetPct, regime: best.steps.regime.label } }
    });
    return summary;
  }

  /** Trailing stop / time stop / signal exit at each new closed 1h bar. */
  async manageOpen(featureCache) {
    for (const p of Object.values(this.state.positions)) {
      if (p.plan?.mode !== "quant" || p.status !== "open") continue;
      const base = splitSymbol(p.symbol).base;
      let fc = featureCache.get(base);
      if (!fc) {
        const bars = await this.bars(p.plan.reference || this.market.referenceFor(base));
        fc = { bars, f: computeFeatureSet(bars) };
        featureCache.set(base, fc);
      }
      const i = fc.bars.length - 1;
      const lastBar = fc.bars[i].t;
      if (p.plan.lastBarProcessed === lastBar) continue;
      p.plan.lastBarProcessed = lastBar;
      // Reference market (USD/EUR) is converted to the execution pair by ratio to keep levels in USDC.
      const tk = this.market.freshTicker(p.symbol, 120000);
      const ratio = tk?.mid && fc.f.close[i] ? tk.mid / fc.f.close[i] : NaN;
      const closeExec = fc.f.close[i] * ratio;
      if (Number.isFinite(closeExec)) p.plan.highestClose = Math.max(p.plan.highestClose || p.entryPrice, closeExec);
      if (p.plan.trailAtr > 0 && Number.isFinite(ratio) && Number.isFinite(fc.f.atr14[i])) {
        const trail = p.plan.highestClose - p.plan.trailAtr * fc.f.atr14[i] * ratio;
        if (trail > p.plan.stopPrice) {
          p.plan.stopPrice = trail;
          p.plan.trailed = true;
          this.orders.logPos(p, "trailing_stop_raised", { stopPrice: trail });
        }
      }
      const heldBars = Math.floor((this.clock.now() - Date.parse(p.openedAt)) / HOUR);
      let reason = null;
      if (p.plan.maxHoldBars > 0 && heldBars >= p.plan.maxHoldBars) reason = "TIME_EXIT";
      else if (p.plan.exitOnSignal && signalExit(p.plan.exitOnSignal, fc.f, i)) reason = "SIGNAL_EXIT";
      this.store.save({ backup: true });
      if (reason) {
        this.orders.logPos(p, "exit_trigger", { reason });
        this.notifier.exitTriggered(p, reason, tk?.bid ?? NaN);
        await this.orders.exitPosition(p, reason);
      }
    }
  }
}
