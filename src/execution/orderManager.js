// Order lifecycle management.
//
// Invariants:
//  1. An order intent (client_order_id) is written durably BEFORE the request is sent.
//  2. A request whose outcome is unknown (timeout, 5xx, 409, malformed) is never
//     re-sent: we look the order up by client_order_id first.
//  3. A position has at most one exit order in flight (no duplicate sells).
//  4. Submitting is not filling: positions change only from exchange-reported fills.
import crypto from "node:crypto";
import { ApiError } from "../api/errors.js";
import { TERMINAL } from "../api/normalize.js";
import { floorToStep, toNum, priceDecimals, fmt } from "../util/num.js";
import { splitSymbol } from "../util/symbols.js";
import { sleep as realSleep } from "../util/time.js";

export class OrderManager {
  constructor({ cfg, store, journal, exchange, market, risk, notifier, logger, clock = { now: () => Date.now() }, sleep = realSleep }) {
    Object.assign(this, { cfg, store, journal, exchange, market, risk, notifier, log: logger, clock, sleep });
    this.busy = new Set(); // position ids with an operation in progress (in-process lock)
  }

  get state() {
    return this.store.state;
  }

  /** Append an auditable event to the position's own history. */
  logPos(p, event, detail = {}) {
    (p.log ||= []).push({ ts: new Date(this.clock.now()).toISOString(), event, status: p.status, ...detail });
    if (p.log.length > 100) p.log.splice(0, p.log.length - 100);
  }

  newClientOrderId() {
    return crypto.randomUUID();
  }

  save(backup = false) {
    this.store.save({ backup });
  }

  // ------------------------------------------------------------------ submission
  /**
   * @returns {Promise<{outcome:'accepted'|'rejected'|'unknown', venueOrderId?:string, error?:ApiError}>}
   */
  async submit(intent, meta = {}) {
    this.journal.recordOrderIntent({ ...intent, ...meta });
    try {
      const res = await this.exchange.placeOrder(intent);
      this.journal.recordOrderUpdate({ clientOrderId: intent.clientOrderId, venueOrderId: res.venueOrderId, status: res.status });
      return { outcome: "accepted", venueOrderId: res.venueOrderId };
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("network", String(e?.message || e));
      this.journal.recordOrderUpdate({ clientOrderId: intent.clientOrderId, error: err.kind, httpStatus: err.status });
      if (err.kind === "client" || err.kind === "auth") return { outcome: "rejected", error: err };
      // rate_limit: almost certainly not processed, but we still verify before any new attempt.
      return { outcome: "unknown", error: err };
    }
  }

  /** Poll an accepted order until it is terminal (IOC/market orders terminate almost immediately). */
  async waitTerminal(venueOrderId, { attempts = 6 } = {}) {
    let last = null;
    for (let i = 0; i < attempts; i++) {
      try {
        last = await this.exchange.getOrder(venueOrderId);
        if (TERMINAL.has(last.status)) return last;
      } catch (e) {
        this.log.warn("order status check failed", { venueOrderId, err: e.message });
      }
      await this.sleep(Math.min(4000, 400 * 2 ** i));
    }
    return last; // may be non-terminal / null: resolved on a later cycle
  }

  /** Find an order by client_order_id among active then historical orders. */
  async lookupByClientId(symbol, clientOrderId, sinceTs) {
    const active = await this.exchange.getActiveOrders({ symbols: [symbol] });
    let hit = active.find((o) => o.clientOrderId === clientOrderId);
    if (hit) return hit;
    const hist = await this.exchange.getHistoricalOrders({ symbols: [symbol], startDate: sinceTs - 5 * 60000, endDate: this.clock.now() + 60000 });
    hit = hist.find((o) => o.clientOrderId === clientOrderId);
    return hit || null;
  }

  // ------------------------------------------------------------------ entries
  /**
   * Open a position. The position record (status "opening") is persisted before
   * the order is sent, so a crash at any point leaves a trace to reconcile.
   */
  async openPosition({ symbol, slot, plan, allocationQuote, order, signal }) {
    const id = `pos-${this.clock.now()}-${symbol}`;
    const clientOrderId = this.newClientOrderId();
    const now = this.clock.now();
    const p = {
      id, symbol, slot, plan, origin: "bot", status: "opening", allocationQuote,
      qty: 0, entryPrice: 0, costBasisQuote: 0, entryFeeQuote: 0,
      targetReached: false, targetReachedAt: null, peakBid: null,
      openedAt: null, createdAt: new Date(now).toISOString(),
      entry: { clientOrderId, venueOrderId: null, status: "submitting", submittedAt: now, request: { ...order }, attempts: 0 },
      exits: [], pendingExit: null, exitReason: null, realizedNetPnl: 0, proceedsQuote: 0, initialQty: 0,
      protection: { type: "software", nativeOrderIds: [] },
      signal: signal ? { score: signal.score, explanation: signal.explanation, reference: signal.reference } : null,
      notes: [], lastBid: null, lastPriceAt: null
    };
    if (signal?.decisionPrice) p.entry.expectedPrice = signal.decisionPrice;
    if (signal?.quant) p.quant = signal.quant;
    this.logPos(p, "entry_submitted", { order });
    this.state.positions[id] = p;
    this.risk.recordEntry(this.state);
    this.save(true);
    this.notifier.orderSubmitted({ position: p, side: "buy", order });

    const res = await this.submit({ clientOrderId, symbol, side: "buy", type: order.type, baseSize: order.baseSize, price: order.price, timeInForce: order.timeInForce }, { positionId: id, slot, purpose: "entry" });
    if (res.outcome === "rejected") {
      p.entry.status = "rejected";
      p.entry.error = res.error.message;
      this.#closeFailed(p, "entry_rejected");
      this.notifier.orderFailed({ position: p, side: "buy", error: res.error });
      return p;
    }
    if (res.outcome === "unknown") {
      p.entry.status = "unknown";
      p.entry.error = res.error.message;
      this.save();
      this.log.warn("entry outcome unknown - will look up by client_order_id", { symbol, clientOrderId, err: res.error.kind });
      await this.resolveOpening(p);
      return p;
    }
    p.entry.venueOrderId = res.venueOrderId;
    p.entry.status = "accepted";
    this.save();
    const o = await this.waitTerminal(res.venueOrderId);
    if (o) this.applyEntryOrder(p, o);
    return p;
  }

  /** Resolve an "opening" position whose order outcome is unknown or not terminal yet. */
  async resolveOpening(p) {
    if (this.busy.has(p.id)) return;
    this.busy.add(p.id);
    try {
      const e = p.entry;
      if (e.venueOrderId) {
        const o = await this.exchange.getOrder(e.venueOrderId).catch((err) => (err.kind === "not_found" ? null : Promise.reject(err)));
        if (o) return this.applyEntryOrder(p, o);
      }
      e.attempts = (e.attempts || 0) + 1;
      const found = await this.lookupByClientId(p.symbol, e.clientOrderId, e.submittedAt);
      if (found) {
        e.venueOrderId = found.venueOrderId;
        this.journal.recordOrderUpdate({ clientOrderId: e.clientOrderId, venueOrderId: found.venueOrderId, status: found.status, via: "lookup" });
        return this.applyEntryOrder(p, found);
      }
      const age = this.clock.now() - e.submittedAt;
      if (age > 180000 && e.attempts >= 3) {
        e.status = "not_found";
        this.log.warn("entry order never appeared on the exchange - treating as not placed", { symbol: p.symbol, clientOrderId: e.clientOrderId });
        this.#closeFailed(p, "entry_not_found");
        this.notifier.warning(`Ordre d'achat ${p.symbol} introuvable sur Revolut X après ${Math.round(age / 1000)}s : considéré comme non placé (aucune position ouverte).`);
      } else {
        this.save();
      }
    } finally {
      this.busy.delete(p.id);
    }
  }

  applyEntryOrder(p, o) {
    const e = p.entry;
    e.status = o.status;
    e.venueOrderId = o.venueOrderId || e.venueOrderId;
    if (!TERMINAL.has(o.status)) {
      // partially filled but still working (should not happen with IOC) - wait.
      this.save();
      return p;
    }
    const filled = o.filledQuantity || 0;
    if (!(filled > 0)) {
      this.#closeFailed(p, o.status === "rejected" ? "entry_rejected" : "entry_unfilled");
      this.notifier.entryNotFilled({ position: p, order: o });
      return p;
    }
    const { base, quote } = splitSymbol(p.symbol);
    const avg = Number.isFinite(o.avgFillPrice) ? o.avgFillPrice : o.filledAmount / filled;
    const notional = Number.isFinite(o.filledAmount) && o.filledAmount > 0 ? o.filledAmount : filled * avg;
    let feeQuote = 0;
    let qty = filled;
    if (Number.isFinite(o.totalFee) && o.totalFee > 0) {
      if (o.feeCurrency === base) { qty = filled - o.totalFee; feeQuote = o.totalFee * avg; }
      else if (!o.feeCurrency || o.feeCurrency === quote) feeQuote = o.totalFee;
      else { feeQuote = notional * this.cfg.TAKER_FEE_PCT / 100; p.notes.push(`fee in ${o.feeCurrency} estimated`); }
    } else if (!Number.isFinite(o.totalFee)) {
      feeQuote = notional * this.cfg.TAKER_FEE_PCT / 100;
      p.notes.push("entry fee estimated (not reported)");
    }
    p.qty = qty;
    p.initialQty = qty;
    p.entryPrice = avg;
    p.entryFeeQuote = feeQuote;
    p.costBasisQuote = notional + (o.feeCurrency === base ? 0 : feeQuote);
    p.status = "open";
    p.openedAt = new Date(this.clock.now()).toISOString();
    p.peakBid = null;
    p.partialEntry = o.quantity > 0 && filled < o.quantity * 0.999;
    if (p.entry.expectedPrice > 0) p.entry.slippagePct = ((avg - p.entry.expectedPrice) / p.entry.expectedPrice) * 100;
    if (p.quant) {
      // turn the strategy's planned distances into absolute levels around the REAL fill
      p.plan = { ...p.plan, stopPrice: avg * (1 - p.quant.stopPct / 100), targetPrice: p.quant.targetPct > 0 ? avg * (1 + p.quant.targetPct / 100) : 0, highestClose: avg };
    }
    this.logPos(p, "entry_filled", { qty, avg, feeQuote, slippagePct: p.entry.slippagePct });
    this.journal.event("entry_filled", { id: p.id, symbol: p.symbol, qty, avg, feeQuote, partial: p.partialEntry });
    this.save(true);
    this.notifier.entryFilled({ position: p, order: o });
    return p;
  }

  #closeFailed(p, reason) {
    p.status = "failed";
    p.exitReason = reason;
    p.closedAt = new Date(this.clock.now()).toISOString();
    this.#archive(p);
    this.save(true);
  }

  #archive(p) {
    delete this.state.positions[p.id];
    this.state.history.push(p);
    if (this.state.history.length > 300) this.state.history.splice(0, this.state.history.length - 300);
  }

  // ------------------------------------------------------------------ exits
  /**
   * Execute (or continue) an exit. Safe to call repeatedly: if an exit order is
   * already in flight it is resolved instead of sending a new one.
   */
  async exitPosition(p, reason, { emergency = false } = {}) {
    if (this.busy.has(p.id)) return { skipped: "busy" };
    this.busy.add(p.id);
    try {
      if (p.pendingExit) {
        const resolved = await this.#resolvePendingExit(p);
        if (!resolved) return { skipped: "exit_in_flight" };
        if (p.status === "closed") return { closed: true };
      }
      if (p.status !== "open" && p.status !== "closing") return { skipped: "status_" + p.status };
      p.exitReason = p.exitReason || reason;
      p.status = "closing";

      const pair = this.market.pair(p.symbol);
      if (!pair) throw new Error("pair config unavailable for " + p.symbol);
      const { base } = splitSymbol(p.symbol);
      // Never sell more than the exchange says is available (no overselling).
      const balances = await this.exchange.getBalances();
      const bal = balances.get(base);
      const available = bal ? bal.available : 0;
      if (!(available > 0)) {
        const reserved = bal ? bal.reserved : 0;
        this.save();
        this.notifier.critical(`Sortie ${p.symbol} impossible : solde ${base} disponible = 0 (réservé ${fmt(reserved, 8)}). Un ordre externe (ex. TP/SL créé dans l'app) bloque peut-être les fonds. Position conservée, vérification requise.`, `exit-nobal-${p.symbol}`);
        return { skipped: "no_available_balance" };
      }
      const qtyToSell = Math.min(p.qty, available);
      const sellSize = floorToStep(qtyToSell, pair.baseStep);
      const tk = this.market.freshTicker(p.symbol);
      const bid = tk?.bid;
      if (toNum(sellSize) <= 0 || toNum(sellSize) < (pair.minOrderSize || 0) || (bid > 0 && toNum(sellSize) * bid < (pair.minOrderSizeQuote || 0))) {
        this.log.warn("remaining quantity is below exchange minimum - closing as dust", { symbol: p.symbol, qty: p.qty });
        p.notes.push(`residual ${p.qty} ${base} below exchange minimum left as dust`);
        p.dustQty = p.qty;
        return this.#finalize(p);
      }
      const attempts = p.exits.filter((x) => x.reason === p.exitReason).length;
      const useMarket = attempts >= this.cfg.EXIT_MAX_IOC_ATTEMPTS && this.cfg.EXIT_MARKET_FALLBACK;
      if (!useMarket && !(tk && tk.valid)) {
        this.save();
        return { skipped: "no_reliable_price" };
      }
      if (attempts >= this.cfg.EXIT_MAX_IOC_ATTEMPTS && !this.cfg.EXIT_MARKET_FALLBACK) {
        this.notifier.critical(`Sortie ${p.symbol} : ${attempts} tentatives IOC non exécutées, repli marché désactivé. Intervention requise.`, `exit-stuck-${p.id}`);
      }
      const decimals = Math.max(priceDecimals(tk?.bidRaw), priceDecimals(tk?.askRaw), 2);
      const order = useMarket
        ? { type: "market", baseSize: sellSize }
        : { type: "limit", timeInForce: "ioc", baseSize: sellSize, price: (Math.floor(bid * (1 - this.cfg.EXIT_LIMIT_SLIPPAGE_PCT / 100) * 10 ** decimals) / 10 ** decimals).toFixed(decimals) };
      const clientOrderId = this.newClientOrderId();
      const ex = { clientOrderId, venueOrderId: null, reason: p.exitReason, type: order.type, request: order, submittedAt: this.clock.now(), status: "submitting", emergency, attempts: 0, expectedBid: bid };
      this.logPos(p, "exit_submitted", { reason: p.exitReason, order });
      p.pendingExit = ex;
      this.save(true);
      this.notifier.orderSubmitted({ position: p, side: "sell", order, reason: p.exitReason, bid });

      const res = await this.submit({ clientOrderId, symbol: p.symbol, side: "sell", ...order }, { positionId: p.id, slot: p.slot, purpose: "exit", reason: p.exitReason });
      if (res.outcome === "rejected") {
        ex.status = "rejected";
        ex.error = res.error.message;
        p.exits.push(ex);
        p.pendingExit = null;
        this.logPos(p, "exit_rejected", { error: res.error.message });
        const rejections = p.exits.filter((x) => x.status === "rejected").length;
        if (rejections >= 3) {
          p.status = "error_locked";
          this.logPos(p, "error_locked", { rejections });
          this.notifier.critical(`${p.symbol} passe en ERROR_LOCKED après ${rejections} ventes rejetées par Revolut X. Aucune action automatique ; nouvelles entrées bloquées. Vérifie la position dans l'app.`, `locked-${p.id}`);
        }
        this.save();
        this.notifier.orderFailed({ position: p, side: "sell", error: res.error });
        return { rejected: true };
      }
      if (res.outcome === "unknown") {
        ex.status = "unknown";
        ex.error = res.error.message;
        this.save();
        return { unknown: true };
      }
      ex.venueOrderId = res.venueOrderId;
      ex.status = "accepted";
      this.save();
      const o = await this.waitTerminal(res.venueOrderId);
      if (o) this.#applyExitOrder(p, o);
      return { submitted: true };
    } finally {
      this.busy.delete(p.id);
    }
  }

  /** @returns {boolean} true when the pending exit is settled (terminal or proven absent). */
  async #resolvePendingExit(p) {
    const ex = p.pendingExit;
    let o = null;
    if (ex.venueOrderId) {
      o = await this.exchange.getOrder(ex.venueOrderId).catch((err) => (err.kind === "not_found" ? null : Promise.reject(err)));
    }
    if (!o) {
      ex.attempts = (ex.attempts || 0) + 1;
      o = await this.lookupByClientId(p.symbol, ex.clientOrderId, ex.submittedAt);
      if (o) ex.venueOrderId = o.venueOrderId;
    }
    if (!o) {
      if (this.clock.now() - ex.submittedAt > 180000 && ex.attempts >= 3) {
        ex.status = "not_found";
        p.exits.push(ex);
        p.pendingExit = null;
        this.save();
        return true;
      }
      this.save();
      return false;
    }
    this.#applyExitOrder(p, o);
    return TERMINAL.has(o.status);
  }

  /** Public entry point used by the monitor/reconciler for in-flight exits. */
  async resolveExit(p) {
    if (!p.pendingExit || this.busy.has(p.id)) return;
    this.busy.add(p.id);
    try {
      await this.#resolvePendingExit(p);
    } finally {
      this.busy.delete(p.id);
    }
  }

  /** Used by the reconciler to book a sell found on the exchange (p.pendingExit must be set). */
  _applyExitForReconcile(p, o, { forceClose = false } = {}) {
    this.#applyExitOrder(p, o);
    if (forceClose && this.state.positions[p.id]) {
      if (p.qty > 0) { p.dustQty = p.qty; p.notes.push(`residual ${p.qty} after recovered exits`); }
      this.#finalize(p);
    }
  }

  #applyExitOrder(p, o) {
    const ex = p.pendingExit;
    if (!ex) return;
    ex.status = o.status;
    if (!TERMINAL.has(o.status)) {
      this.save();
      return;
    }
    const filled = o.filledQuantity || 0;
    const { base, quote } = splitSymbol(p.symbol);
    if (filled > 0) {
      const avg = Number.isFinite(o.avgFillPrice) ? o.avgFillPrice : o.filledAmount / filled;
      const notional = o.filledAmount > 0 ? o.filledAmount : filled * avg;
      let feeQuote;
      if (Number.isFinite(o.totalFee)) feeQuote = o.feeCurrency === base ? o.totalFee * avg : o.totalFee;
      else feeQuote = notional * this.cfg.TAKER_FEE_PCT / 100;
      const proceeds = notional - feeQuote;
      const costShare = p.initialQty > 0 ? p.costBasisQuote * (filled / p.initialQty) : 0;
      ex.filledQty = filled;
      ex.avgPrice = avg;
      ex.feeQuote = feeQuote;
      ex.proceedsQuote = proceeds;
      ex.realizedNetPnl = proceeds - costShare;
      if (ex.expectedBid > 0) ex.slippagePct = ((avg - ex.expectedBid) / ex.expectedBid) * 100;
      this.logPos(p, "exit_filled", { filled, avg, feeQuote, reason: ex.reason, slippagePct: ex.slippagePct });
      p.qty = Math.max(0, p.qty - filled);
      p.proceedsQuote = (p.proceedsQuote || 0) + proceeds;
      p.realizedNetPnl = (p.realizedNetPnl || 0) + ex.realizedNetPnl;
      p.exitFeesQuote = (p.exitFeesQuote || 0) + feeQuote;
      this.journal.event("exit_fill", { id: p.id, symbol: p.symbol, filled, avg, feeQuote, reason: ex.reason, quote });
      this.notifier.exitFilled({ position: p, exit: ex, partial: p.qty > 0 });
    }
    p.exits.push(ex);
    p.pendingExit = null;
    const pair = this.market.pair(p.symbol);
    const tk = this.market.freshTicker(p.symbol);
    const residualValue = tk?.bid ? p.qty * tk.bid : 0;
    const belowMin = pair && (p.qty < (pair.minOrderSize || 0) || residualValue < (pair.minOrderSizeQuote || 0));
    if (p.qty <= 0 || (filled > 0 && belowMin)) {
      if (p.qty > 0) { p.dustQty = p.qty; p.notes.push(`residual ${p.qty} ${base} left as dust`); }
      this.#finalize(p);
    } else {
      this.save(true);
    }
  }

  #finalize(p) {
    p.status = "closed";
    this.logPos(p, "closed", { netPnl: p.realizedNetPnl });
    p.closedAt = new Date(this.clock.now()).toISOString();
    const fees = (p.entryFeeQuote || 0) + (p.exitFeesQuote || 0);
    this.risk.recordClose(this.state, { netPnl: p.realizedNetPnl || 0, fees, symbol: p.symbol });
    this.#archive(p);
    this.save(true);
    this.notifier.positionClosed({ position: p });
    return { closed: true };
  }
}
