import fs from "node:fs";
import crypto from "node:crypto";

const BASE_URL = "https://revx.revolut.com/api";

export class RevolutX {
  constructor() {
    this.apiKey = process.env.REVOLUT_API_KEY || "";
    this.privateKeyPath = process.env.REVOLUT_PRIVATE_KEY_PATH || "";
    this.region = process.env.REVOLUT_REGION || "EEA";
    this.privateKey = null;
    if (this.privateKeyPath && fs.existsSync(this.privateKeyPath)) {
      this.privateKey = crypto.createPrivateKey(fs.readFileSync(this.privateKeyPath));
    }
  }
  get configured() { return Boolean(this.apiKey && this.privateKey); }
  async publicGet(path, params = {}) {
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    const response = await fetch(url);
    const text = await response.text();
    if (!response.ok) throw new Error("Revolut public API " + response.status + ": " + text);
    return text ? JSON.parse(text) : {};
  }
  async authenticatedGet(path, params = {}) { return this.#request("GET", path, params, ""); }
  async authenticatedPost(path, body = {}) { return this.#request("POST", path, {}, JSON.stringify(body)); }
  async authenticatedDelete(path, params = {}) { return this.#request("DELETE", path, params, ""); }
  async #request(method, path, params = {}, body = "") {
    if (!this.configured) throw new Error("Authenticated Revolut X client is not configured.");
    const url = new URL(BASE_URL + path);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
    const timestamp = Date.now().toString();
    const query = url.searchParams.toString();
    const signedPath = "/api" + path;
    const message = timestamp + method.toUpperCase() + signedPath + query + body;
    const signature = crypto.sign(null, Buffer.from(message, "utf8"), this.privateKey).toString("base64");
    const headers = { "X-Revx-API-Key": this.apiKey, "X-Revx-Timestamp": timestamp, "X-Revx-Signature": signature };
    if (body) headers["Content-Type"] = "application/json";
    const response = await fetch(url, { method, headers, body: body || undefined });
    const text = await response.text();
    if (!response.ok) throw new Error("Revolut API " + response.status + ": " + text);
    return text ? JSON.parse(text) : {};
  }
  getTickers(symbols) { return this.publicGet("/1.0/public/tickers", { symbols: Array.isArray(symbols) ? symbols.join(",") : symbols, region: this.region }); }
  getCandles(symbol, interval = 5, since, until) { return this.publicGet("/1.0/public/candles/" + symbol, { interval, since, until, region: this.region }); }
  getPairs() { return this.publicGet("/1.0/public/configuration/pairs", { region: this.region }); }
  getOrderBook(symbol, limit = 20) { return this.publicGet("/2.0/public/order-book/" + symbol, { limit, region: this.region }); }
  getBalances() { return this.authenticatedGet("/1.0/balances"); }
  getActiveOrders(params = {}) { return this.authenticatedGet("/1.0/orders/active", params); }
  getHistoricalOrders(params = {}) { return this.authenticatedGet("/1.0/orders/historical", params); }
  getOrder(orderId) { return this.authenticatedGet("/1.0/orders/" + orderId); }
  getTransactions(params = {}) { return this.authenticatedGet("/1.0/transactions", params); }
  placeOrder(order) { return this.authenticatedPost("/1.0/orders", order); }
  cancelOrder(orderId) { return this.authenticatedDelete("/1.0/orders/" + orderId); }
  cancelAllOrders() { return this.authenticatedDelete("/1.0/orders"); }
}