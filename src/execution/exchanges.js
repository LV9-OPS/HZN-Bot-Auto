// Exchange adapters with one interface used by the order manager and the
// reconciler. LiveExchange talks to Revolut X; PaperExchange simulates fills
// against live market data so paper mode exercises the same code paths.
import crypto from "node:crypto";
import { ApiError } from "../api/errors.js";
import { toNum } from "../util/num.js";
import { splitSymbol } from "../util/symbols.js";

export class LiveExchange {
  constructor({ client }) {
    this.client = client;
    this.kind = "live";
  }
  getBalances() { return this.client.getBalances(); }
  getActiveOrders(q) { return this.client.getActiveOrders(q); }
  getHistoricalOrders(q) { return this.client.getHistoricalOrders(q); }
  getOrder(id) { return this.client.getOrder(id); }
  placeOrder(req) { return this.client.placeOrder(req); }
  cancelOrder(id) { return this.client.cancelOrder(id); }
}

/**
 * Paper exchange. Fill model (documented in docs/STRATEGY.md):
 *  - buy fills at the current ask (+ slippage) if the limit allows it, IOC remainder cancelled
 *  - sell fills at the current bid (- slippage) if the limit allows it
 *  - taker fee charged in quote currency
 * `faults` lets tests inject timeouts, rejections and lost responses.
 */
export class PaperExchange {
  constructor({ store, getTicker, cfg, clock = { now: () => Date.now() } }) {
    this.kind = "paper";
    this.store = store; // object holding .state.paper
    this.getTicker = getTicker;
    this.cfg = cfg;
    this.clock = clock;
    this.faults = {};
    if (!this.store.state.paper) {
      this.store.state.paper = { balances: { [cfg.QUOTE_CURRENCY]: cfg.PAPER_START_QUOTE }, orders: {} };
    }
  }

  get book() {
    return this.store.state.paper;
  }

  async getBalances() {
    if (this.faults.balances) throw this.#fault(this.faults.balances, "/1.0/balances");
    const out = new Map();
    for (const [cur, amt] of Object.entries(this.book.balances)) out.set(cur, { currency: cur, available: amt, reserved: 0, staked: 0, total: amt });
    return out;
  }

  async getActiveOrders() {
    return []; // paper orders are IOC/market only: never resting
  }

  async getHistoricalOrders({ symbols, startDate, endDate } = {}) {
    if (this.faults.history) throw this.#fault(this.faults.history, "/1.0/orders/historical");
    return Object.values(this.book.orders).filter((o) => (!symbols || symbols.includes(o.symbol)) && (!startDate || o.createdAt >= startDate) && (!endDate || o.createdAt <= endDate)).map((o) => ({ ...o }));
  }

  async getOrder(id) {
    if (this.faults.getOrder) throw this.#fault(this.faults.getOrder, "/1.0/orders/{id}");
    const o = this.book.orders[id];
    if (!o) throw new ApiError("not_found", "order not found", { status: 404 });
    return { ...o };
  }

  async cancelOrder() {
    return true;
  }

  #fault(kind, endpoint) {
    return new ApiError(kind, `injected ${kind}`, { endpoint, status: kind === "rate_limit" ? 429 : kind === "server" ? 503 : null, retryAfterMs: kind === "rate_limit" ? 1000 : null });
  }

  async placeOrder({ clientOrderId, symbol, side, type, baseSize, price }) {
    const f = this.faults.placeOrder;
    if (f === "timeout_before" || f === "network_before") throw this.#fault(f === "timeout_before" ? "timeout" : "network", "/1.0/orders");
    if (f === "reject") throw new ApiError("client", "injected rejection", { status: 400 });
    if (f === "rate_limit") throw this.#fault("rate_limit", "/1.0/orders");
    if (Object.values(this.book.orders).some((o) => o.clientOrderId === clientOrderId)) throw new ApiError("conflict", "duplicate client_order_id", { status: 409 });

    const tk = this.getTicker(symbol);
    const now = this.clock.now();
    const { base, quote } = splitSymbol(symbol);
    const qty = toNum(baseSize);
    const lim = toNum(price);
    const slip = this.cfg.EST_SLIPPAGE_PCT / 100;
    const fee = this.cfg.TAKER_FEE_PCT / 100;
    let filled = 0;
    let avg = NaN;
    let status = "cancelled";
    let rejectReason = null;
    if (!tk || !tk.valid || now - tk.ts > this.cfg.PRICE_MAX_AGE_MS) {
      status = "rejected";
      rejectReason = "no market data";
    } else if (side === "buy") {
      const px = tk.ask * (1 + slip);
      if (type === "market" || px <= lim) {
        const cost = qty * px * (1 + fee);
        if (cost > (this.book.balances[quote] || 0) + 1e-12) {
          status = "rejected";
          rejectReason = "insufficient balance";
        } else {
          filled = qty;
          avg = px;
        }
      }
    } else {
      const px = tk.bid * (1 - slip);
      if (type === "market" || px >= lim) {
        if (qty > (this.book.balances[base] || 0) + 1e-12) {
          status = "rejected";
          rejectReason = "insufficient balance";
        } else {
          filled = qty;
          avg = type === "market" ? px : Math.max(px, lim);
        }
      }
    }
    let totalFee = 0;
    if (filled > 0) {
      status = "filled";
      const notional = filled * avg;
      totalFee = notional * fee;
      if (side === "buy") {
        this.book.balances[quote] = (this.book.balances[quote] || 0) - notional - totalFee;
        this.book.balances[base] = (this.book.balances[base] || 0) + filled;
      } else {
        this.book.balances[base] = (this.book.balances[base] || 0) - filled;
        this.book.balances[quote] = (this.book.balances[quote] || 0) + notional - totalFee;
        if (this.book.balances[base] < 1e-12) delete this.book.balances[base];
      }
    }
    const venueOrderId = crypto.randomUUID();
    this.book.orders[venueOrderId] = {
      venueOrderId, clientOrderId, symbol, side, type, status, quantity: qty, filledQuantity: filled, leavesQuantity: 0,
      price: lim, avgFillPrice: avg, filledAmount: filled * (avg || 0), totalFee, feeCurrency: quote, rejectReason,
      createdAt: now, updatedAt: now
    };
    // keep the paper order book small
    const ids = Object.keys(this.book.orders);
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete this.book.orders[id];
    if (f === "timeout_after_accept") throw this.#fault("timeout", "/1.0/orders"); // accepted but the response was lost
    if (status === "rejected") throw new ApiError("client", `order rejected: ${rejectReason}`, { status: 400 });
    return { venueOrderId, clientOrderId, status: "new" };
  }
}
