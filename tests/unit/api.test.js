import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RequestScheduler, PRIORITY } from "../../src/api/scheduler.js";
import { RevolutXClient } from "../../src/api/revolutx.js";
import { ApiError } from "../../src/api/errors.js";
import { normalizeBalances, normalizeTickers } from "../../src/api/normalize.js";
import { redact, registerSecret } from "../../src/monitoring/redact.js";
import { makeCfg, tmpDir, nullLogger } from "../helpers.js";

function keyFiles() {
  const dir = tmpDir();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const file = path.join(dir, "private.pem");
  fs.writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
  return { file, publicKey };
}

function response(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
}

function client(fetchImpl, over = {}) {
  const { file, publicKey } = keyFiles();
  const cfg = makeCfg({ REVOLUT_API_KEY: "a".repeat(64), REVOLUT_PRIVATE_KEY_PATH: file, HTTP_TIMEOUT_MS: "2000", ...over });
  const scheduler = RequestScheduler.fromConfig(cfg);
  return { c: new RevolutXClient({ cfg, scheduler, logger: nullLogger(), fetchImpl, sleepImpl: async () => {} }), publicKey, scheduler };
}

test("scheduler enforces the public 1 req/s budget and priority order", async () => {
  const s = new RequestScheduler({ groups: { public: [{ capacity: 1, perMs: 100 }] } });
  const order = [];
  const t0 = Date.now();
  const jobs = [s.schedule("public", async () => order.push("a"), { priority: PRIORITY.DEEP }), s.schedule("public", async () => order.push("b"), { priority: PRIORITY.DEEP }), s.schedule("public", async () => order.push("pos"), { priority: PRIORITY.POSITION })];
  await Promise.all(jobs);
  assert.deepEqual(order, ["a", "pos", "b"]); // first runs immediately, then higher priority jumps the queue
  assert.ok(Date.now() - t0 >= 180, "rate limited");
  s.close();
});

test("scheduler pauses a group after a 429", async () => {
  const s = new RequestScheduler({ groups: { auth: [{ capacity: 10, perMs: 1000 }] } });
  s.pauseGroup("auth", 150);
  const t0 = Date.now();
  await s.schedule("auth", async () => 1);
  assert.ok(Date.now() - t0 >= 140);
  assert.equal(s.stats().auth.rateLimited, 1);
  s.close();
});

test("authenticated requests are signed as timestamp+METHOD+/api/path+query+body (Ed25519)", async () => {
  let seen;
  const { c, publicKey } = client(async (url, init) => {
    seen = { url: new URL(url), init };
    return response(200, { data: [{ currency: "USDC", available: "10", reserved: "0", total: "10" }] });
  });
  await c.getActiveOrders({ symbols: ["BTC-USDC"] }).catch(() => {});
  const h = seen.init.headers;
  const msg = h["X-Revx-Timestamp"] + "GET" + seen.url.pathname + seen.url.searchParams.toString();
  assert.equal(seen.url.pathname, "/api/1.0/orders/active");
  assert.ok(crypto.verify(null, Buffer.from(msg), publicKey, Buffer.from(h["X-Revx-Signature"], "base64")));
  assert.equal(h["X-Revx-API-Key"], "a".repeat(64));
});

test("429 with Retry-After (ms) is retried after the delay; GET retries are bounded", async () => {
  let calls = 0;
  const { c } = client(async () => (++calls === 1 ? response(429, "slow down", { "retry-after": "50" }) : response(200, { data: [] })));
  const b = await c.getBalances();
  assert.equal(b.size, 0);
  assert.equal(calls, 2);
  let n = 0;
  const { c: c2 } = client(async () => { n++; return response(503, "down"); });
  await assert.rejects(c2.getBalances(), (e) => e instanceof ApiError && e.kind === "server");
  assert.equal(n, 3, "1 try + 2 retries");
});

test("order placement is never retried automatically and reports unknown outcomes", async () => {
  let n = 0;
  const { c } = client(async () => { n++; return response(503, "gateway"); });
  await assert.rejects(c.placeOrder({ clientOrderId: "x", symbol: "BTC-USDC", side: "buy", type: "limit", baseSize: "0.1", price: "1" }), (e) => e.kind === "server" && e.outcomeUnknown);
  assert.equal(n, 1);
});

test("timeouts surface as ApiError(timeout)", async () => {
  const { c } = client((url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; rej(e); })), { HTTP_TIMEOUT_MS: "2000" });
  await assert.rejects(c.getOrder("abc"), (e) => e.kind === "timeout");
});

test("only limit and market orders can be created (no fabricated stop orders)", async () => {
  const { c } = client(async () => response(200, {}));
  await assert.rejects(c.placeOrder({ clientOrderId: "x", symbol: "BTC-USDC", side: "sell", type: "stop", baseSize: "1" }), /only supports limit and market/);
});

test("malformed / empty payloads raise instead of looking like 'no position'", () => {
  assert.throws(() => normalizeBalances({}), (e) => e.kind === "malformed");
  assert.throws(() => normalizeBalances({ data: [{ available: "1" }] }), /without currency/);
  assert.throws(() => normalizeBalances({ data: [{ currency: "XRP", available: "abc" }] }), /invalid available/);
  assert.throws(() => normalizeTickers("<html>", 0), (e) => e.kind === "malformed");
});

test("duplicate tickers (multi-region) keep the most liquid entry", () => {
  const m = normalizeTickers({ data: [{ symbol: "XRP/USDC", bid: "1", ask: "1.01", quote_volume_24h: "3000" }, { symbol: "XRP/USDC", bid: "1.1", ask: "1.11", quote_volume_24h: "136000" }] }, 0);
  assert.equal(m.get("XRP-USDC").quoteVolume24h, 136000);
});

test("secrets are redacted from logs and messages", () => {
  registerSecret("SUPERSECRETKEY123456");
  const s = redact("key=SUPERSECRETKEY123456 hook https://discord.com/api/webhooks/123/abcDEF -----BEGIN PRIVATE KEY-----\nAAA\n-----END PRIVATE KEY-----");
  assert.ok(!s.includes("SUPERSECRETKEY123456"));
  assert.ok(!s.includes("abcDEF"));
  assert.ok(!s.includes("AAA"));
});
