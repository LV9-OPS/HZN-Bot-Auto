// Orchestrator: wires components and runs the non-overlapping task loop.
import fs from "node:fs";
import path from "node:path";
import { RequestScheduler, PRIORITY } from "./api/scheduler.js";
import { RevolutXClient } from "./api/revolutx.js";
import { MarketData } from "./market/marketData.js";
import { Scanner } from "./market/scanner.js";
import { StateStore } from "./storage/stateStore.js";
import { Journal } from "./storage/journal.js";
import { RiskManager } from "./risk/riskManager.js";
import { OrderManager } from "./execution/orderManager.js";
import { LiveExchange, PaperExchange } from "./execution/exchanges.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import { DiscordNotifier } from "./notifications/discord.js";
import { evaluateExit, planLevels } from "./strategy/profitPlan.js";
import { confirmEntry } from "./strategy/entryConfirm.js";
import { performance } from "./monitoring/metrics.js";
import { writeFileAtomic } from "./storage/atomicFile.js";
import { dayKey, sleep as realSleep } from "./util/time.js";
import { fmt } from "./util/num.js";
import { registerSecret } from "./monitoring/redact.js";

export class Bot {
  constructor({ cfg, logger, fetchImpl = globalThis.fetch, discordFetch = globalThis.fetch, clock = { now: () => Date.now() }, sleep = realSleep, exchangeOverride = null, clientOverride = null }) {
    this.cfg = cfg;
    this.logger = logger;
    this.log = logger.child ? logger.child("bot") : logger;
    this.clock = clock;
    this.sleep = sleep;
    this.mode = cfg.BOT_MODE;
    this.startedAt = clock.now();
    if (cfg.DISCORD_WEBHOOK_URL) registerSecret(cfg.DISCORD_WEBHOOK_URL);

    this.scheduler = RequestScheduler.fromConfig(cfg, { clock, logger: this.#child("api") });
    this.client = clientOverride || new RevolutXClient({ cfg, scheduler: this.scheduler, logger: this.#child("api"), fetchImpl, clock, sleepImpl: sleep });
    this.market = new MarketData({ client: this.client, cfg, logger: this.#child("market"), clock });
    this.scanner = new Scanner({ cfg, market: this.market, logger: this.#child("scanner"), clock });
    this.store = new StateStore({ dataDir: cfg.dataDir, mode: this.mode, logger: this.#child("state") });
    this.journal = new Journal({ dataDir: cfg.dataDir, mode: this.mode });
    this.risk = new RiskManager({ cfg, clock });
    this.notifier = new DiscordNotifier({ webhookUrl: cfg.DISCORD_WEBHOOK_URL, mode: this.mode, cfg, logger: this.#child("discord"), fetchImpl: discordFetch, priceOf: (s) => this.market.freshTicker(s, 120000), clock });
    this.exchangeOverride = exchangeOverride;

    const origPause = this.scheduler.pauseGroup.bind(this.scheduler);
    this.scheduler.pauseGroup = (group, ms, reason) => {
      origPause(group, ms, reason);
      this.notifier.rateLimited(group, ms);
      this.lastRateLimitAt = this.clock.now();
    };

    this.tasks = {};
    this.stopping = false;
    this.radarIntervalMs = cfg.RADAR_INTERVAL_MS;
    this.lastPriceOk = new Map();
    this.lastDailySummaryDay = null;
    this.lastLeaderboardLogAt = 0;
    this.lastRateLimitAt = 0;
  }

  #child(name) {
    return this.logger.child ? this.logger.child(name) : this.logger;
  }

  get state() {
    return this.store.state;
  }

  // ------------------------------------------------------------------ startup
  async init() {
    const loaded = this.store.load();
    this.log.info(`state loaded from ${loaded.source}`, { positions: Object.keys(this.state.positions).length });
    if (loaded.source === "backup") this.notifier.critical("État restauré depuis une sauvegarde : réconciliation complète forcée avant toute entrée.", "state-backup");
    this.state.reconciliation.ok = false; // always re-earn trust at startup

    this.exchange = this.exchangeOverride || (this.mode === "live" ? new LiveExchange({ client: this.client }) : new PaperExchange({ store: this.store, getTicker: (s) => this.market.freshTicker(s), cfg: this.cfg, clock: this.clock }));
    this.orders = new OrderManager({ cfg: this.cfg, store: this.store, journal: this.journal, exchange: this.exchange, market: this.market, risk: this.risk, notifier: this.notifier, logger: this.#child("orders"), clock: this.clock, sleep: this.sleep });
    this.reconciler = new Reconciler({ cfg: this.cfg, store: this.store, journal: this.journal, exchange: this.exchange, market: this.market, orders: this.orders, notifier: this.notifier, logger: this.#child("reconcile"), client: this.client, clock: this.clock });

    // Diagnostics
    let auth = "non configurée (données publiques)";
    if (this.client.authenticated) {
      try {
        await this.client.getBalances(PRIORITY.ORDER);
        auth = "OK";
        this.notifier.authResult(true);
      } catch (e) {
        auth = "ÉCHEC: " + e.message;
        this.notifier.authResult(false, e.message);
        if (this.mode === "live") throw new Error("Live mode: Revolut X authentication failed: " + e.message);
      }
    }
    await this.market.refreshPairs(true);
    await this.market.refreshAllTickers(PRIORITY.RECONCILE);
    const universe = this.market.executionUniverse();
    this.log.info(`universe: ${universe.length} active ${this.cfg.QUOTE_CURRENCY} pairs`, { pairs: universe.map((p) => p.symbol) });

    const rep = await this.reconciler.run({ full: true });
    this.log.info("startup reconciliation", rep);
    this.notifier.startup({ mode: this.mode, config: this.cfg, auth, reconcile: rep.ok ? "OK" : "PROBLÈMES — entrées bloquées (" + [...rep.errors, ...rep.warnings].join("; ").slice(0, 300) + ")", positions: Object.keys(this.state.positions).length });
    return rep;
  }

  // ------------------------------------------------------------------ loop
  async run() {
    const t = (name, every, fn) => (this.tasks[name] = { every, fn, last: 0, running: false });
    t("positions", () => (this.client.authenticated ? this.cfg.POSITION_INTERVAL_MS : Math.max(3000, this.cfg.POSITION_INTERVAL_MS)), () => this.monitorPositions());
    t("radar", () => this.radarIntervalMs, () => this.scanCycle());
    t("reconcile", () => this.cfg.RECONCILE_INTERVAL_MS, () => this.reconcileCycle(false));
    t("history", () => this.cfg.HISTORY_SYNC_INTERVAL_MS, () => this.reconcileCycle(true));
    t("status", () => 5000, () => this.writeStatus());
    t("daily", () => 60000, () => this.dailyCheck());
    t("control", () => 1000, () => this.controlFiles());
    this.tasks.reconcile.last = this.clock.now();
    this.tasks.history.last = this.clock.now();

    while (!this.stopping) {
      const now = this.clock.now();
      for (const [name, task] of Object.entries(this.tasks)) {
        if (task.running || now - task.last < task.every()) continue;
        task.running = true; // no overlapping runs of the same task
        task.last = now;
        task
          .fn()
          .catch((e) => {
            this.log.error(`task ${name} failed`, { err: e.message, kind: e.kind });
            this.notifier.error(e, name);
          })
          .finally(() => {
            task.running = false;
          });
      }
      await this.sleep(250);
    }
  }

  async stop(reason = "stop requested") {
    if (this.stopping) return;
    this.stopping = true;
    this.log.info("shutting down", { reason });
    // let in-flight tasks (e.g. an order being confirmed) finish
    const end = Date.now() + 15000;
    while (Object.values(this.tasks).some((t) => t.running) && Date.now() < end) await realSleep(100);
    try { this.store.save({ backup: true }); } catch (e) { this.log.error("final save failed", { err: e.message }); }
    this.writeStatus().catch(() => {});
    this.notifier.send(`Arrêt du bot (${reason}). Positions ouvertes : ${Object.values(this.state?.positions || {}).filter((p) => p.status === "open").length} — ⚠️ plus aucune surveillance du stop-loss tant que le bot est arrêté.`, { key: "shutdown" });
    await this.notifier.flush(5000);
    this.scheduler.close();
  }

  apiHealthy() {
    const recentlyLimited = this.clock.now() - this.lastRateLimitAt < 60000;
    return this.client.consecutiveFailures < 3 && !recentlyLimited;
  }

  // ------------------------------------------------------------------ positions
  async monitorPositions() {
    const positions = Object.values(this.state.positions);
    if (!positions.length) return;
    const symbols = [...new Set(positions.map((p) => p.symbol))].filter((s) => this.market.pair(s));
    try {
      await this.market.refreshTickers(symbols, PRIORITY.POSITION);
    } catch (e) {
      this.log.warn("position price refresh failed", { err: e.message });
    }
    for (const p of positions) {
      if (!this.state.positions[p.id]) continue;
      try {
        if (p.status === "opening") {
          if (this.clock.now() - (p.entry.lastCheckAt || 0) > 10000) {
            p.entry.lastCheckAt = this.clock.now();
            await this.orders.resolveOpening(p);
          }
          continue;
        }
        if (p.pendingExit) {
          await this.orders.resolveExit(p);
          continue;
        }
        if (p.status === "needs_reconciliation") {
          // Facts unverified: never traded automatically, but a price collapse is escalated.
          const pr = this.market.reliableBid(p.symbol);
          if (p.entryPrice > 0 && pr.reliable && pr.bid <= p.entryPrice * (1 - this.cfg.STOP_LOSS_PCT / 100)) {
            this.notifier.critical(`${p.symbol} (position à réconcilier, non gérée automatiquement) est sous son niveau de stop : bid ${fmt(pr.bid, 6)} <= ${fmt(p.entryPrice * (1 - this.cfg.STOP_LOSS_PCT / 100), 6)}. Action manuelle requise.`, `nr-stop-${p.id}`);
          }
          continue;
        }
        if (p.status !== "open" && p.status !== "closing") continue;

        const pair = this.market.pair(p.symbol);
        const price = this.market.reliableBid(p.symbol);
        if (price.reliable) {
          this.lastPriceOk.set(p.id, this.clock.now());
          p.lastBid = price.bid;
          p.lastPriceAt = new Date(price.ts).toISOString();
        } else {
          const since = this.clock.now() - (this.lastPriceOk.get(p.id) || this.startedAt);
          if (since > this.cfg.EMERGENCY_DATA_OUTAGE_MS) this.notifier.critical(`Aucun prix fiable pour ${p.symbol} depuis ${Math.round(since / 1000)}s (${price.reason}). Stop-loss NON évaluable : aucune sortie au prix inventé. Position conservée.`, `noprice-${p.id}`);
        }

        // Emergency policy: delisted / inactive pair
        if (pair && pair.status !== "active" && this.cfg.EMERGENCY_EXIT_ON_DELIST && p.status === "open") {
          if (price.reliable) {
            this.notifier.emergency(`${p.symbol} n'est plus actif sur Revolut X : sortie d'urgence au bid ${fmt(price.bid, 6)}.`);
            await this.orders.exitPosition(p, "EMERGENCY_PAIR_INACTIVE", { emergency: true });
          } else {
            this.notifier.emergency(`${p.symbol} n'est plus actif et aucun prix fiable : position conservée, intervention manuelle requise.`);
          }
          continue;
        }

        if (p.status === "closing") {
          await this.orders.exitPosition(p, p.exitReason || "RESUME_EXIT");
          continue;
        }
        const d = evaluateExit(p, price, { stopLossPct: this.cfg.STOP_LOSS_PCT });
        let changed = false;
        if (d.updates.peakBid && d.updates.peakBid !== p.peakBid) { p.peakBid = d.updates.peakBid; }
        if (d.updates.targetReached) {
          p.targetReached = true;
          p.targetReachedAt = d.updates.targetReachedAt;
          changed = true;
        }
        if (changed) {
          this.store.save({ backup: true }); // persisted BEFORE any further action: survives restarts
          this.notifier.targetReached(p);
          this.journal.event("target_reached", { id: p.id, symbol: p.symbol, bid: price.bid });
        }
        if (d.action === "exit") {
          this.log.warn(`exit trigger ${p.symbol}: ${d.reason}`, { bid: price.bid, entry: p.entryPrice, levels: d.levels });
          this.notifier.exitTriggered(p, d.reason, price.bid);
          this.journal.event("exit_trigger", { id: p.id, symbol: p.symbol, reason: d.reason, bid: price.bid });
          await this.orders.exitPosition(p, d.reason);
        }
      } catch (e) {
        this.log.error(`position ${p.symbol} handling failed`, { err: e.message });
        this.notifier.error(e, `position ${p.symbol}`);
      }
    }
  }

  // ------------------------------------------------------------------ scanning & entries
  async scanCycle() {
    try {
      await this.market.refreshPairs();
      await this.market.refreshAllTickers(PRIORITY.RADAR);
    } catch (e) {
      this.log.warn("radar ticker refresh failed", { err: e.message });
      return;
    }
    this.scanner.radar();
    // Adaptive cadence: back off when the request queue is building up.
    const group = this.client.marketGroup;
    const backlog = this.scheduler.queueDepth(group) + (this.client.authenticated ? this.scheduler.queueDepth("candles") : 0);
    if (backlog > 6 && this.radarIntervalMs < 60000) {
      this.radarIntervalMs = Math.min(60000, Math.round(this.radarIntervalMs * 1.5));
      this.log.warn(`API backlog ${backlog}: radar interval raised to ${this.radarIntervalMs}ms to respect rate limits`);
    } else if (backlog === 0 && this.radarIntervalMs > this.cfg.RADAR_INTERVAL_MS) {
      this.radarIntervalMs = Math.max(this.cfg.RADAR_INTERVAL_MS, Math.round(this.radarIntervalMs / 1.25));
    }
    const deepPerCycle = this.client.authenticated ? 6 : 1;
    const candidates = await this.scanner.deep(deepPerCycle);
    for (const [code, n] of Object.entries(this.scanner.rejectionCounts)) this.state.rejections[code] = (this.state.rejections[code] || 0) + n;
    this.scanner.rejectionCounts = {};

    if (this.clock.now() - this.lastLeaderboardLogAt > 60000) {
      this.lastLeaderboardLogAt = this.clock.now();
      this.log.info("scanner leaderboard", { top: this.scanner.leaderboard(5) });
    }
    for (const c of candidates) if (c.score >= this.cfg.DISCORD_CANDIDATE_MIN_SCORE) this.notifier.candidate(c);
    if (candidates.length) await this.tryEntry(candidates);
  }

  async tryEntry(candidates) {
    const gate = this.risk.entryGate(this.state, { apiHealthy: this.apiHealthy() });
    if (!gate.ok) {
      this.log.info("entry blocked", { reasons: gate.reasons.map((r) => r.code), best: candidates[0]?.exec });
      return null;
    }
    for (const c of candidates) {
      const sg = this.risk.symbolGate(this.state, c.exec);
      if (!sg.ok) continue;
      const slot = this.risk.freeSlot(this.state);
      if (!slot) return null;
      const quote = this.cfg.QUOTE_CURRENCY;
      const balances = await this.exchange.getBalances();
      const available = balances.get(quote)?.available ?? 0;
      const alloc = this.risk.allocation(this.state, slot, available);
      if (!alloc.ok) {
        this.log.info("entry skipped", { symbol: c.exec, reason: alloc.reason });
        this.state.rejections[alloc.reason.code] = (this.state.rejections[alloc.reason.code] || 0) + 1;
        return null;
      }
      // Stage D: fresh data
      let book = null;
      try {
        await this.market.refreshTickers([c.exec], PRIORITY.ORDER);
        book = await this.client.getOrderBook(c.exec, 20, PRIORITY.ORDER);
      } catch (e) {
        this.log.warn("entry confirmation data failed", { symbol: c.exec, err: e.message });
      }
      const tk = this.market.freshTicker(c.exec);
      const conf = confirmEntry({
        signal: { symbol: c.exec, createdAt: c.at, execAskAtSignal: c.execAsk || tk?.ask },
        ticker: tk, book, pair: this.market.pair(c.exec), allocationQuote: alloc.amount, now: this.clock.now(), cfg: this.cfg
      });
      if (!conf.ok) {
        for (const r of conf.reasons) this.state.rejections["entry_" + r.code] = (this.state.rejections["entry_" + r.code] || 0) + 1;
        this.log.info(`entry rejected at confirmation: ${c.exec}`, { reasons: conf.reasons });
        continue;
      }
      const plan = this.cfg.plans[slot - 1];
      this.log.warn(`ENTRY ${c.exec} slot ${slot} ${alloc.amount} USDC`, { explanation: c.explanation, order: conf.order, costs: conf.costs });
      this.notifier.entryDecision({ candidate: c, slot, plan, allocation: alloc.amount, order: conf.order, costs: conf.costs });
      const p = await this.orders.openPosition({ symbol: c.exec, slot, plan, allocationQuote: alloc.amount, order: conf.order, signal: { score: c.score, explanation: c.explanation, reference: c.ref } });
      return p; // at most one entry per cycle
    }
    return null;
  }

  // ------------------------------------------------------------------ reconciliation / housekeeping
  async reconcileCycle(full) {
    const rep = await this.reconciler.run({ full });
    if (!rep.skipped && (rep.errors.length || rep.actions.length)) this.log.warn("reconciliation", rep);
  }

  async controlFiles() {
    const stopFile = path.join(this.cfg.dataDir, `STOP.${this.mode}`);
    if (fs.existsSync(stopFile)) {
      fs.unlinkSync(stopFile);
      this.onStopRequest?.("stop file");
    }
    const em = fs.existsSync(path.join(this.cfg.dataDir, "EMERGENCY_STOP"));
    if (em !== Boolean(this.state.emergencyStop)) {
      this.state.emergencyStop = em;
      this.store.save();
      if (em) this.notifier.emergency("Fichier EMERGENCY_STOP détecté : nouvelles entrées bloquées (positions toujours surveillées).");
      else this.notifier.info("EMERGENCY_STOP retiré : entrées de nouveau autorisées (si les autres conditions le permettent).");
    }
  }

  async dailyCheck() {
    const now = this.clock.now();
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: this.cfg.RISK_DAY_TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(new Date(now)));
    const day = dayKey(now, this.cfg.RISK_DAY_TIMEZONE);
    if (hour !== this.cfg.DAILY_SUMMARY_HOUR || this.lastDailySummaryDay === day) return;
    this.lastDailySummaryDay = day;
    const perf = performance(this.state, (s) => this.market.freshTicker(s, 120000), this.cfg);
    const top = Object.entries(this.state.rejections).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}:${v}`).join(", ");
    this.notifier.dailySummary({
      day, realizedNetPnl: this.state.daily.realizedNetPnl, fees: this.state.daily.fees, entries: this.state.daily.entries, exits: this.state.daily.exits,
      totalNet: perf.realizedNetPnl, trades: perf.trades, winRate: perf.winRate === null ? "n/a" : Math.round(perf.winRate * 100) + "%", avgWin: perf.avgWin ?? 0, avgLoss: perf.avgLoss ?? 0, maxDrawdown: perf.maxDrawdown,
      open: Object.values(this.state.positions).filter((p) => p.status === "open").length, exposure: perf.exposure, unrealized: perf.unrealizedNetPnl, topRejections: top || "aucun"
    });
  }

  statusSnapshot() {
    const priceOf = (s) => this.market.freshTicker(s, 120000);
    const gate = this.risk.entryGate(this.state, { apiHealthy: this.apiHealthy() });
    const issues = [];
    if (!this.state.reconciliation.ok) issues.push("not reconciled");
    if (!this.apiHealthy()) issues.push("api degraded");
    if (this.clock.now() - this.market.lastTickerOkAt > 60000) issues.push("market data stale");
    const positions = Object.values(this.state.positions).map((p) => {
      const tk = priceOf(p.symbol);
      const lv = p.entryPrice > 0 ? planLevels(p, this.cfg.STOP_LOSS_PCT) : {};
      const share = p.initialQty > 0 ? p.qty / p.initialQty : 1;
      const net = tk?.bid && p.qty ? p.qty * tk.bid * (1 - this.cfg.TAKER_FEE_PCT / 100) - p.costBasisQuote * share : null;
      return {
        id: p.id, symbol: p.symbol, slot: p.slot, plan: p.plan.name, status: p.status, origin: p.origin, qty: p.qty, entryPrice: p.entryPrice,
        bid: tk?.bid ?? null, stopPrice: lv.stopPrice ? Number(lv.stopPrice.toPrecision(6)) : null, targetPrice: lv.targetPrice ? Number(lv.targetPrice.toPrecision(6)) : null,
        floorPrice: lv.floorPrice ? Number(lv.floorPrice.toPrecision(6)) : null, targetReached: p.targetReached, netPnl: net === null ? null : Number(net.toFixed(4)),
        protection: p.protection?.nativeOrderIds?.length ? "software + native (manual)" : "software only", pendingExit: p.pendingExit ? p.pendingExit.status : null, notes: p.notes?.slice(-3)
      };
    });
    const quoteBal = this.state.paper?.balances?.[this.cfg.QUOTE_CURRENCY];
    return {
      at: new Date(this.clock.now()).toISOString(), mode: this.mode, healthy: issues.length === 0, issues, uptimeMin: Math.round((this.clock.now() - this.startedAt) / 60000),
      entryGate: gate, capital: { budget: this.risk.budget(), deployed: this.risk.deployedQuote(this.state), remaining: this.risk.remainingBudget(this.state), quoteBalance: this.mode === "paper" ? quoteBal : "see exchange" },
      positions, performance: performance(this.state, priceOf, this.cfg), leaderboard: this.scanner.leaderboard(10), discrepancies: this.state.discrepancies.slice(-20),
      unmanagedHoldings: this.state.unmanagedHoldings, reconciliation: this.state.reconciliation, api: { ...this.scheduler.stats(), radarIntervalMs: this.radarIntervalMs, authenticated: this.client.authenticated },
      rejections: this.state.rejections, recentHistory: this.state.history.slice(-10).map((p) => ({ symbol: p.symbol, status: p.status, reason: p.exitReason, net: p.realizedNetPnl, closedAt: p.closedAt }))
    };
  }

  async writeStatus() {
    this.lastStatus = this.statusSnapshot();
    writeFileAtomic(path.join(this.cfg.dataDir, `status.${this.mode}.json`), JSON.stringify(this.lastStatus, null, 2));
  }
}
