// Revolut X REST client (https://developer.revolut.com/docs/api/revolut-x-crypto-exchange).
// Verified against the official docs on 2026-10-15:
//  - Auth headers: X-Revx-API-Key, X-Revx-Timestamp (ms), X-Revx-Signature (base64 Ed25519)
//  - Signed message: timestamp + METHOD + "/api" + path + query (no '?') + minified JSON body
//  - POST /1.0/orders supports ONLY order_configuration.limit or .market (no stop / TP-SL creation)
//  - 429 responses carry Retry-After in MILLISECONDS
import fs from "node:fs";
import crypto from "node:crypto";
import { ApiError, classifyStatus } from "./errors.js";
import { PRIORITY } from "./scheduler.js";
import { registerSecret } from "../monitoring/redact.js";
import { sleep } from "../util/time.js";
import { normSymbol } from "../util/symbols.js";
import * as N from "./normalize.js";

export class RevolutXClient {
  constructor({ cfg, scheduler, logger, fetchImpl = globalThis.fetch, clock = { now: () => Date.now() }, sleepImpl = sleep }) {
    this.cfg = cfg;
    this.baseUrl = cfg.REVOLUT_BASE_URL.replace(/\/$/, "");
    this.region = cfg.REVOLUT_REGION;
    this.scheduler = scheduler;
    this.log = logger;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.sleep = sleepImpl;
    this.apiKey = cfg.REVOLUT_API_KEY || "";
    this.privateKey = null;
    if (this.apiKey) registerSecret(this.apiKey);
    if (cfg.REVOLUT_PRIVATE_KEY_PATH && fs.existsSync(cfg.REVOLUT_PRIVATE_KEY_PATH)) {
      this.privateKey = crypto.createPrivateKey(fs.readFileSync(cfg.REVOLUT_PRIVATE_KEY_PATH));
      if (this.privateKey.asymmetricKeyType !== "ed25519") throw new Error("Revolut X private key must be Ed25519");
    }
    this.lastSuccessAt = 0;
    this.consecutiveFailures = 0;
  }

  get authenticated() {
    return Boolean(this.apiKey && this.privateKey);
  }

  /** Market-data reads use authenticated endpoints when possible (1000/min) and public ones otherwise (1/s). */
  get marketGroup() {
    return this.authenticated ? "auth" : "public";
  }

  // ---------------------------------------------------------------- core
  sign(timestamp, method, pathWithApi, query, body) {
    const message = timestamp + method.toUpperCase() + pathWithApi + (query || "") + (body || "");
    return crypto.sign(null, Buffer.from(message, "utf8"), this.privateKey).toString("base64");
  }

  buildUrl(path, params) {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    return url;
  }

  async rawRequest({ method, path, params, body, auth, group }) {
    const url = this.buildUrl(path, params);
    const bodyText = body ? JSON.stringify(body) : "";
    const headers = { Accept: "application/json" };
    if (auth) {
      if (!this.authenticated) throw new ApiError("auth", "Authenticated client not configured", { endpoint: path });
      const ts = String(this.clock.now());
      headers["X-Revx-API-Key"] = this.apiKey;
      headers["X-Revx-Timestamp"] = ts;
      headers["X-Revx-Signature"] = this.sign(ts, method, new URL(url).pathname, url.searchParams.toString(), bodyText);
    }
    if (bodyText) headers["Content-Type"] = "application/json";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.cfg.HTTP_TIMEOUT_MS);
    let res;
    try {
      res = await this.fetch(url, { method, headers, body: bodyText || undefined, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      this.consecutiveFailures++;
      const kind = e?.name === "AbortError" ? "timeout" : "network";
      throw new ApiError(kind, `${method} ${path} ${kind}: ${e?.message || e}`, { endpoint: path });
    }
    clearTimeout(timer);
    let text = "";
    try {
      text = await res.text();
    } catch (e) {
      throw new ApiError("network", `${method} ${path} body read failed`, { endpoint: path, status: res.status });
    }
    if (!res.ok) {
      const kind = classifyStatus(res.status);
      const ra = Number(res.headers?.get?.("retry-after"));
      const retryAfterMs = Number.isFinite(ra) && ra > 0 ? ra : null; // documented in ms
      if (kind === "rate_limit") this.scheduler.pauseGroup(group, retryAfterMs ?? 2000, `429 on ${path}`);
      if (kind === "server") this.consecutiveFailures++;
      throw new ApiError(kind, `${method} ${path} -> HTTP ${res.status}`, { status: res.status, retryAfterMs, endpoint: path, body: text });
    }
    this.consecutiveFailures = 0;
    this.lastSuccessAt = this.clock.now();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError("malformed", `${method} ${path} returned non-JSON`, { status: res.status, endpoint: path, body: text });
    }
  }

  /** GET with bounded exponential backoff. Never used for order placement. */
  async get(path, params, { auth, group, priority, cost = 1, retries = 2 } = {}) {
    let attempt = 0;
    for (;;) {
      try {
        return await this.scheduler.schedule(group, () => this.rawRequest({ method: "GET", path, params, auth, group }), { priority, cost, label: path });
      } catch (e) {
        if (!(e instanceof ApiError) || !e.retryable || attempt >= retries) throw e;
        const backoff = e.kind === "rate_limit" ? (e.retryAfterMs ?? 2000) : Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        this.log?.debug?.(`retry ${path} in ${backoff}ms (${e.kind})`);
        await this.sleep(backoff);
        attempt++;
      }
    }
  }

  // ---------------------------------------------------------------- market data
  async getPairs() {
    const auth = this.authenticated;
    const raw = await this.get(auth ? "/1.0/configuration/pairs" : "/1.0/public/configuration/pairs", auth ? {} : { region: this.region }, { auth, group: this.marketGroup, priority: PRIORITY.RECONCILE });
    return N.normalizePairs(raw);
  }

  async getTickers(symbols, priority = PRIORITY.RADAR) {
    const auth = this.authenticated;
    const syms = symbols?.length ? symbols.map((s) => normSymbol(s).replace("-", "/")) : undefined;
    const raw = await this.get(auth ? "/1.0/tickers" : "/1.0/public/tickers", { symbols: syms, region: auth ? undefined : this.region }, { auth, group: this.marketGroup, priority });
    return N.normalizeTickers(raw, this.clock.now());
  }

  async getCandles(symbol, { interval = 1, since, until } = {}, priority = PRIORITY.DEEP) {
    const auth = this.authenticated;
    const s = normSymbol(symbol);
    const raw = await this.get(auth ? `/1.0/candles/${s}` : `/1.0/public/candles/${s}`, { interval, since, until, region: auth ? undefined : this.region }, { auth, group: auth ? "candles" : "public", priority });
    return N.normalizeCandles(raw, interval);
  }

  async getOrderBook(symbol, limit = 20, priority = PRIORITY.ORDER) {
    const auth = this.authenticated;
    const s = normSymbol(symbol);
    const raw = await this.get(auth ? `/1.0/order-book/${s}` : `/2.0/public/order-book/${s}`, { limit, region: auth ? undefined : this.region }, { auth, group: this.marketGroup, priority });
    return N.normalizeOrderBook(raw);
  }

  // ---------------------------------------------------------------- account (authenticated only)
  async getBalances(priority = PRIORITY.RECONCILE) {
    const raw = await this.get("/1.0/balances", {}, { auth: true, group: "auth", priority });
    return N.normalizeBalances(raw);
  }

  async #paged(path, params, { priority, costFn = () => 1, maxPages = 20 }) {
    const out = [];
    let cursor;
    for (let page = 0; page < maxPages; page++) {
      const p = { ...params, cursor, limit: params.limit ?? 100 };
      const raw = await this.get(path, p, { auth: true, group: "auth", priority, cost: costFn(p) });
      const list = N.listOf(raw);
      if (!list) throw new ApiError("malformed", `${path} returned no data array`, { endpoint: path });
      out.push(...list);
      cursor = raw?.metadata?.next_cursor;
      if (!cursor || list.length === 0) return out;
    }
    this.log?.warn?.(`${path}: stopped after ${maxPages} pages`);
    return out;
  }

  async getActiveOrders({ symbols } = {}, priority = PRIORITY.RECONCILE) {
    const list = await this.#paged("/1.0/orders/active", { symbols: symbols?.map(normSymbol) }, { priority });
    return list.map(N.normalizeOrder);
  }

  /** Historical orders cost 1 token per day in range; we chunk to <= 7 days per request. */
  async getHistoricalOrders({ symbols, startDate, endDate }, priority = PRIORITY.RECONCILE) {
    const out = [];
    const DAY = 86400000;
    let start = startDate;
    const end = endDate ?? this.clock.now();
    while (start < end) {
      const chunkEnd = Math.min(end, start + 7 * DAY);
      const days = Math.max(1, Math.ceil((chunkEnd - start) / DAY));
      const list = await this.#paged("/1.0/orders/historical", { symbols: symbols?.map(normSymbol), start_date: start, end_date: chunkEnd }, { priority, costFn: () => days });
      out.push(...list.map(N.normalizeOrder));
      start = chunkEnd;
    }
    return out;
  }

  async getOrder(venueOrderId, priority = PRIORITY.ORDER) {
    const raw = await this.get(`/1.0/orders/${encodeURIComponent(venueOrderId)}`, {}, { auth: true, group: "auth", priority });
    const data = raw?.data ?? raw;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("malformed", "order details missing", { endpoint: "/1.0/orders/{id}" });
    return N.normalizeOrder(data);
  }

  async getOrderFills(venueOrderId, priority = PRIORITY.ORDER) {
    const raw = await this.get(`/1.0/orders/fills/${encodeURIComponent(venueOrderId)}`, {}, { auth: true, group: "auth", priority });
    return (N.listOf(raw) || []).map(N.normalizeFill);
  }

  /**
   * Place an order. NO automatic retry: on an uncertain outcome the caller must
   * look the order up by client_order_id before doing anything else.
   */
  async placeOrder({ clientOrderId, symbol, side, type, baseSize, quoteSize, price, timeInForce }) {
    const conf = {};
    const size = baseSize ? { base_size: String(baseSize) } : { quote_size: String(quoteSize) };
    if (type === "limit") conf.limit = { ...size, price: String(price), ...(timeInForce ? { time_in_force: timeInForce } : {}) };
    else if (type === "market") conf.market = size;
    else throw new Error("Revolut X API only supports limit and market orders (got " + type + ")");
    const body = { client_order_id: clientOrderId, symbol: normSymbol(symbol), side, order_configuration: conf };
    const raw = await this.scheduler.schedule("orders", () => this.rawRequest({ method: "POST", path: "/1.0/orders", body, auth: true, group: "orders" }), { priority: PRIORITY.ORDER, label: "place" });
    const d = raw?.data ?? raw;
    const item = Array.isArray(d) ? d[0] : d;
    if (!item?.venue_order_id) throw new ApiError("malformed", "order accepted without venue_order_id", { endpoint: "/1.0/orders" });
    return { venueOrderId: item.venue_order_id, clientOrderId: item.client_order_id || clientOrderId, status: N.normStatus(item.state || item.status) };
  }

  /** Cancel ONE order by id. There is intentionally no cancel-all wrapper. */
  async cancelOrder(venueOrderId) {
    await this.scheduler.schedule("auth", () => this.rawRequest({ method: "DELETE", path: `/1.0/orders/${encodeURIComponent(venueOrderId)}`, auth: true, group: "auth" }), { priority: PRIORITY.ORDER, label: "cancel" });
    return true;
  }
}
