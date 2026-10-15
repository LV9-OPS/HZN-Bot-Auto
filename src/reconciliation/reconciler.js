// Exchange <-> local state reconciliation.
// Principles:
//  - the exchange is the source of truth for balances and fills
//  - a local position is NEVER deleted because an API response is empty/malformed
//  - a balance is NOT assumed to be a bot position unless the bot's own order
//    registry (client_order_ids) proves it
//  - anything that cannot be established is flagged "needs_reconciliation",
//    which blocks new entries until resolved
import { STABLE_OR_FIAT, splitSymbol } from "../util/symbols.js";
import { fmt } from "../util/num.js";
import { PRIORITY } from "../api/scheduler.js";

const DAY = 86400000;

export class Reconciler {
  constructor({ cfg, store, journal, exchange, market, orders, notifier, logger, client = null, clock = { now: () => Date.now() } }) {
    Object.assign(this, { cfg, store, journal, exchange, market, orders, notifier, log: logger, client, clock });
    this.running = false;
  }

  get state() {
    return this.store.state;
  }

  #discrepancy(kind, symbol, severity, details) {
    const now = new Date(this.clock.now()).toISOString();
    let d = this.state.discrepancies.find((x) => !x.resolved && x.kind === kind && x.symbol === symbol);
    if (!d) {
      d = { id: `${kind}-${symbol}-${this.clock.now()}`, kind, symbol, severity, details, firstSeen: now, lastSeen: now, count: 1, resolved: false };
      this.state.discrepancies.push(d);
      this.notifier.reconciliation({ discrepancy: d });
    } else {
      d.lastSeen = now;
      d.count++;
      d.details = details;
      if (severity === "critical" && d.severity !== "critical") {
        d.severity = "critical";
        this.notifier.reconciliation({ discrepancy: d });
      }
    }
    return d;
  }

  #resolve(kind, symbol, note) {
    for (const d of this.state.discrepancies) {
      if (!d.resolved && d.kind === kind && d.symbol === symbol) {
        d.resolved = true;
        d.resolvedAt = new Date(this.clock.now()).toISOString();
        d.resolution = note;
        this.notifier.info(`Écart résolu : ${kind} ${symbol || ""} — ${note}`);
      }
    }
  }

  /**
   * @param {{full?: boolean}} opts full = include historical orders
   * @returns {Promise<object>} report
   */
  async run({ full = false } = {}) {
    if (this.running) return { skipped: true };
    this.running = true;
    const report = { at: new Date(this.clock.now()).toISOString(), ok: false, actions: [], warnings: [], errors: [] };
    try {
      await this.market.refreshPairs();
      // 1. Exchange facts. Any failure here aborts WITHOUT touching local positions.
      let balances, active;
      try {
        balances = await this.exchange.getBalances();
        active = await this.exchange.getActiveOrders({});
      } catch (e) {
        report.errors.push(`exchange read failed: ${e.message}`);
        this.state.reconciliation.ok = false;
        this.state.reconciliation.lastRunAt = report.at;
        this.state.reconciliation.lastError = e.message;
        this.store.save();
        return report;
      }
      const registry = this.journal.loadOrders();
      const positions = () => Object.values(this.state.positions);

      // Prices for valuation of holdings: one request for the whole market.
      try { await this.market.refreshAllTickers(PRIORITY.RECONCILE); } catch (e) { report.warnings.push("ticker refresh failed: " + e.message); }
      this.state.lastBalances = Object.fromEntries([...balances].filter(([, b]) => b.total > 0).map(([c, b]) => [c, { total: b.total, available: b.available, reserved: b.reserved }]));
      const valueOf = (cur, qty) => {
        for (const q of [this.cfg.QUOTE_CURRENCY, "USD", "EUR"]) {
          const t = this.market.tickers.get(`${cur}-${q}`);
          if (t?.valid) return qty * t.bid; // approximate (EUR/USD treated ~1:1, only used for dust/info)
        }
        return NaN;
      };

      // 2. Historical orders (needed for lost fills, external sells, recovery)
      let history = null;
      const needHistory = full || positions().some((p) => p.status === "needs_reconciliation" || p.status === "opening" || p.pendingExit);
      if (needHistory) {
        const last = this.state.reconciliation.lastHistorySyncAt ? Date.parse(this.state.reconciliation.lastHistorySyncAt) : 0;
        const oldestPos = Math.min(...positions().map((p) => Date.parse(p.openedAt || p.createdAt || "") || this.clock.now()), this.clock.now());
        let start = last ? last - 15 * 60000 : this.clock.now() - 14 * DAY;
        start = Math.min(start, oldestPos - 60000);
        start = Math.max(start, this.clock.now() - 30 * DAY);
        try {
          history = await this.exchange.getHistoricalOrders({ startDate: start, endDate: this.clock.now() });
          this.state.reconciliation.lastHistorySyncAt = new Date(this.clock.now()).toISOString();
        } catch (e) {
          report.warnings.push("historical orders unavailable: " + e.message);
        }
      }

      // 3. In-flight entries/exits
      for (const p of positions()) {
        try {
          if (p.status === "opening") await this.orders.resolveOpening(p);
          if (p.pendingExit) await this.orders.resolveExit(p);
        } catch (e) {
          report.warnings.push(`resolve ${p.symbol}: ${e.message}`);
        }
      }

      // 4. Legacy / needs_reconciliation positions: verify facts on the exchange
      for (const p of positions().filter((x) => x.status === "needs_reconciliation")) {
        await this.#verifyPosition(p, balances, history, report);
      }

      // 5. Open positions vs balances
      for (const p of positions().filter((x) => x.status === "open" || x.status === "closing")) {
        if (p.pendingExit) continue;
        const { base } = splitSymbol(p.symbol);
        const bal = balances.get(base);
        const total = bal ? bal.total : 0;
        const tol = Math.max(p.qty * 0.01, this.market.pair(p.symbol)?.minOrderSize || 0);
        if (total + tol >= p.qty) {
          this.#resolve("balance_below_position", p.symbol, "balance matches");
          if (p.origin !== "bot" && !p.planChecked) {
            await this.#restorePlanState(p, report);
            p.planChecked = true;
          }
          if (bal && bal.reserved > 0) {
            const ext = active.filter((o) => o.symbol === p.symbol && !registry.has(o.clientOrderId));
            p.protection.external = ext.map((o) => ({ id: o.venueOrderId, type: o.type, side: o.side, trigger: o.trigger }));
            if (ext.some((o) => o.type === "tpsl" || o.type === "conditional")) {
              p.protection.nativeOrderIds = ext.filter((o) => o.type === "tpsl" || o.type === "conditional").map((o) => o.venueOrderId);
            }
          }
          continue;
        }
        // Balance lower than the position: look for sells we did not record.
        const sells = (history || []).filter((o) => o.symbol === p.symbol && o.side === "sell" && o.filledQuantity > 0 && (o.createdAt || 0) >= (Date.parse(p.openedAt) || 0) - 60000 && !p.exits.some((x) => x.venueOrderId === o.venueOrderId));
        const sold = sells.reduce((s, o) => s + o.filledQuantity, 0);
        if (sold > 0 && total + sold + tol >= p.qty) {
          for (const o of sells) {
            p.pendingExit = { clientOrderId: o.clientOrderId, venueOrderId: o.venueOrderId, reason: registry.has(o.clientOrderId) ? p.exitReason || "RECOVERED_EXIT" : "EXTERNAL_SELL", type: o.type, submittedAt: o.createdAt, status: o.status, recovered: true };
            this.orders._applyExitForReconcile(p, o);
          }
          report.actions.push(`${p.symbol}: applied ${sells.length} unrecorded sell(s) (${fmt(sold, 8)} ${base})`);
          continue;
        }
        const d = this.#discrepancy("balance_below_position", p.symbol, "warning", { localQty: p.qty, exchangeTotal: total, unexplainedSells: sold });
        if (d.count >= 2) {
          d.severity = "critical";
          p.status = "needs_reconciliation";
          p.notes.push(`exchange balance ${total} < position ${p.qty} (unexplained) at ${d.lastSeen}`);
          report.errors.push(`${p.symbol}: exchange ${total} < local ${p.qty}`);
          this.notifier.reconciliation({ discrepancy: d, position: p });
        }
      }

      // 6. Exchange holdings with no managed position
      const unmanaged = [];
      for (const [cur, bal] of balances) {
        if (STABLE_OR_FIAT.has(cur) || !(bal.total > 0)) continue;
        const sym = `${cur}-${this.cfg.QUOTE_CURRENCY}`;
        if (positions().some((p) => splitSymbol(p.symbol).base === cur)) continue;
        const value = valueOf(cur, bal.total);
        if (Number.isFinite(value) && value < this.cfg.DUST_THRESHOLD_QUOTE) continue; // dust: ignored, never traded
        const recovered = await this.#recoverOrphan(cur, sym, bal, history, registry, report);
        if (!recovered) unmanaged.push({ currency: cur, total: bal.total, valueQuote: Number.isFinite(value) ? Number(value.toFixed(4)) : null, note: "not created by this bot (no matching client_order_id) - not managed" });
      }
      const prev = new Set((this.state.unmanagedHoldings || []).map((h) => h.currency));
      for (const h of unmanaged) if (!prev.has(h.currency)) this.notifier.warning(`Avoir non géré détecté : ${fmt(h.total, 8)} ${h.currency} (~${h.valueQuote ?? "?"} USDC). Il n'a pas été acheté par ce bot (aucun client_order_id connu) : il ne sera ni vendu ni compté dans le budget. Pour le confier au bot : npm run adopt -- ${h.currency}-${this.cfg.QUOTE_CURRENCY}`);
      this.state.unmanagedHoldings = unmanaged;

      // 7. Orphaned orders of ours (resting orders not linked to any position)
      const linked = new Set();
      for (const p of positions()) {
        if (p.entry?.clientOrderId) linked.add(p.entry.clientOrderId);
        if (p.pendingExit?.clientOrderId) linked.add(p.pendingExit.clientOrderId);
      }
      for (const o of active) {
        if (!registry.has(o.clientOrderId) || linked.has(o.clientOrderId)) continue;
        if (o.side === "buy") {
          try {
            await this.exchange.cancelOrder(o.venueOrderId);
            report.actions.push(`cancelled orphan bot buy order ${o.symbol} ${o.venueOrderId}`);
            this.notifier.warning(`Ordre d'achat orphelin du bot annulé : ${o.symbol} (${o.venueOrderId}).`);
          } catch (e) {
            report.warnings.push(`orphan cancel failed ${o.venueOrderId}: ${e.message}`);
          }
        } else {
          this.#discrepancy("orphan_bot_order", o.symbol, "warning", { venueOrderId: o.venueOrderId, side: o.side });
        }
      }

      const crit = this.state.discrepancies.filter((d) => !d.resolved && d.severity === "critical");
      report.ok = crit.length === 0 && !positions().some((p) => p.status === "needs_reconciliation");
      this.state.reconciliation.ok = report.ok;
      this.state.reconciliation.lastRunAt = report.at;
      if (report.ok) this.state.reconciliation.lastOkAt = report.at;
      this.state.reconciliation.lastError = report.errors.join("; ") || null;
      this.store.save();
      return report;
    } finally {
      this.running = false;
    }
  }

  /** Verify a legacy / flagged position using its recorded entry order. */
  async #verifyPosition(p, balances, history, report) {
    const { base } = splitSymbol(p.symbol);
    const bal = balances.get(base);
    const total = bal ? bal.total : 0;
    let entryOrder = null;
    if (p.entry?.venueOrderId) {
      try {
        entryOrder = await this.exchange.getOrder(p.entry.venueOrderId);
      } catch (e) {
        report.warnings.push(`${p.symbol}: entry order lookup failed (${e.kind || e.message})`);
      }
    }
    if (!entryOrder && p.entry?.clientOrderId && history) entryOrder = history.find((o) => o.clientOrderId === p.entry.clientOrderId) || null;
    if (!entryOrder || entryOrder.symbol !== p.symbol || entryOrder.side !== "buy" || !(entryOrder.filledQuantity > 0)) {
      this.#discrepancy("unverifiable_position", p.symbol, "critical", { reason: "entry order not found/filled on exchange", exchangeTotal: total, localQty: p.qty });
      report.errors.push(`${p.symbol}: entry cannot be verified`);
      return;
    }
    // Facts from the exchange
    const filled = entryOrder.filledQuantity;
    const avg = entryOrder.avgFillPrice;
    const feeBase = entryOrder.feeCurrency === base ? entryOrder.totalFee || 0 : 0;
    const qtyBought = filled - feeBase;
    const sellsAfter = (history || []).filter((o) => o.symbol === p.symbol && o.side === "sell" && o.filledQuantity > 0 && (o.createdAt || 0) > (entryOrder.createdAt || 0));
    const soldQty = sellsAfter.reduce((s, o) => s + o.filledQuantity, 0);
    const expected = qtyBought - soldQty;
    const tol = Math.max(qtyBought * 0.01, this.market.pair(p.symbol)?.minOrderSize || 0);
    p.entryPrice = avg;
    p.initialQty = qtyBought;
    const notional = entryOrder.filledAmount || filled * avg;
    p.entryFeeQuote = Number.isFinite(entryOrder.totalFee) ? (feeBase ? feeBase * avg : entryOrder.totalFee) : notional * this.cfg.TAKER_FEE_PCT / 100;
    p.costBasisQuote = notional + (feeBase ? 0 : p.entryFeeQuote);
    p.openedAt = p.openedAt || new Date(entryOrder.createdAt || this.clock.now()).toISOString();
    if (expected <= tol) {
      // Fully sold on the exchange (e.g. exit filled while the bot was down)
      p.qty = qtyBought;
      for (const o of sellsAfter) {
        p.pendingExit = { clientOrderId: o.clientOrderId, venueOrderId: o.venueOrderId, reason: "RECOVERED_EXIT", type: o.type, submittedAt: o.createdAt, status: o.status, recovered: true };
        this.orders._applyExitForReconcile(p, o, { forceClose: true });
      }
      this.#resolve("unverifiable_position", p.symbol, "position was already sold on the exchange");
      report.actions.push(`${p.symbol}: legacy position already sold - closed with exchange fills`);
      return;
    }
    if (total + tol < expected) {
      this.#discrepancy("unverifiable_position", p.symbol, "critical", { reason: "exchange balance below verified quantity", exchangeTotal: total, expected });
      report.errors.push(`${p.symbol}: balance ${total} < expected ${expected}`);
      return;
    }
    p.qty = expected;
    p.status = "open";
    p.origin = p.origin === "legacy" ? "legacy-verified" : p.origin;
    p.notes.push(`verified on exchange: entry ${avg}, qty ${expected}`);
    await this.#restorePlanState(p, report);
    this.#resolve("unverifiable_position", p.symbol, "verified against exchange order " + entryOrder.venueOrderId);
    report.actions.push(`${p.symbol}: verified (entry ${fmt(avg, 6)}, qty ${fmt(expected, 8)})`);
    this.notifier.info(`Position ${p.symbol} vérifiée sur Revolut X : entrée ${fmt(avg, 6)}, quantité ${fmt(expected, 8)}, plan ${p.plan.name}${p.targetReached ? " (objectif déjà atteint, plancher armé)" : ""}. Gestion reprise.`);
  }

  /** Reconstruct targetReached from historical candles when it may have been lost. */
  async #restorePlanState(p, report) {
    if (p.targetReached || !this.client) return;
    try {
      const since = Date.parse(p.openedAt);
      if (!Number.isFinite(since)) return;
      const interval = this.clock.now() - since > 3 * DAY ? 60 : 5;
      const candles = await this.client.getCandles(p.symbol, { interval, since, until: this.clock.now() }, PRIORITY.RECONCILE);
      const maxHigh = Math.max(0, ...candles.map((c) => c.high));
      if (maxHigh >= p.entryPrice * p.plan.targetMultiple) {
        p.targetReached = true;
        p.targetReachedAt = "reconstructed";
        p.notes.push(`target X${p.plan.targetMultiple} reconstructed from candles (max ${maxHigh})`);
        report.actions.push(`${p.symbol}: target reached reconstructed from candles`);
      }
    } catch (e) {
      report.warnings.push(`${p.symbol}: could not check candles for target state (${e.message})`);
    }
  }

  /**
   * A holding with no local position. Recreate a managed position ONLY when the
   * bot's own registry proves the bot bought it.
   */
  async #recoverOrphan(cur, sym, bal, history, registry, report) {
    if (!history || !this.market.pair(sym)) return false;
    const ours = history.filter((o) => o.symbol === sym && registry.has(o.clientOrderId) && o.filledQuantity > 0).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    if (!ours.length) return false;
    // Walk our fills; keep the buys after the last time our net position was ~flat.
    let net = 0;
    let lot = [];
    for (const o of ours) {
      if (o.side === "buy") { net += o.filledQuantity; lot.push(o); }
      else { net -= o.filledQuantity; if (net <= 1e-12) { net = 0; lot = []; } }
    }
    if (!(net > 0) || !lot.length) return false;
    const qty = Math.min(net, bal.total);
    const notional = lot.reduce((s, o) => s + (o.filledAmount || o.filledQuantity * o.avgFillPrice), 0);
    const bought = lot.reduce((s, o) => s + o.filledQuantity, 0);
    const avg = notional / bought;
    const slot = [1, 2, 3].slice(0, this.cfg.MAX_OPEN_POSITIONS).find((s) => !Object.values(this.state.positions).some((p) => p.slot === s));
    const id = `recovered-${this.clock.now()}-${sym}`;
    const intent = registry.get(lot[0].clientOrderId) || {};
    const p = {
      id, symbol: sym, slot: slot || 3, plan: this.cfg.plans[(slot || 3) - 1], origin: "recovered", status: slot ? "open" : "needs_reconciliation",
      allocationQuote: Math.max(0.01, notional), qty, initialQty: bought, entryPrice: avg, costBasisQuote: notional * (1 + this.cfg.TAKER_FEE_PCT / 100), entryFeeQuote: notional * this.cfg.TAKER_FEE_PCT / 100,
      targetReached: false, targetReachedAt: null, peakBid: null, openedAt: new Date(lot[0].createdAt || this.clock.now()).toISOString(), createdAt: new Date(this.clock.now()).toISOString(),
      entry: { clientOrderId: lot[0].clientOrderId, venueOrderId: lot[0].venueOrderId, status: "filled", recovered: true, slotHint: intent.slot },
      exits: [], pendingExit: null, exitReason: null, realizedNetPnl: 0, proceedsQuote: 0,
      protection: { type: "software", nativeOrderIds: [] }, notes: ["recreated from exchange fills of the bot's own orders"], lastBid: null, lastPriceAt: null
    };
    if (intent.slot && !Object.values(this.state.positions).some((x) => x.slot === intent.slot)) { p.slot = intent.slot; p.plan = this.cfg.plans[intent.slot - 1]; }
    this.state.positions[id] = p;
    await this.#restorePlanState(p, report);
    this.#discrepancy("missing_local_position", sym, "warning", { recoveredQty: qty, entry: avg });
    this.#resolve("missing_local_position", sym, "position recreated from the bot's own fills");
    report.actions.push(`${sym}: recreated missing position from bot fills (qty ${fmt(qty, 8)}, entry ${fmt(avg, 6)})`);
    this.notifier.critical(`Position manquante reconstruite : ${sym} qty ${fmt(qty, 8)} entrée ${fmt(avg, 6)} (d'après les ordres du bot sur Revolut X). Gestion reprise${p.status === "needs_reconciliation" ? " — aucun slot libre, vérification requise" : ""}.`, `recovered-${sym}`);
    return true;
  }
}
