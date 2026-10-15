import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildConfig } from "../src/config/index.js";
import { nullLogger } from "../src/monitoring/logger.js";

export function tmpDir(prefix = "hzn-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeCfg(overrides = {}) {
  const dir = overrides.DATA_DIR || tmpDir();
  const cfg = buildConfig({ BOT_MODE: "paper", DATA_DIR: dir, LOG_DIR: path.join(dir, "logs"), HEALTH_PORT: "0", ...overrides });
  return cfg;
}

export class ManualClock {
  constructor(t = Date.UTC(2026, 9, 15, 10, 0, 0)) {
    this.t = t;
  }
  now() {
    return this.t;
  }
  advance(ms) {
    this.t += ms;
  }
}

export function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * Generate 1m candles: a quiet base then a scripted tail.
 * tail: array of {ret: % close-to-close, vol: volume multiple, wickUp?: %}
 */
export function genCandles({ n = 150, start = Date.UTC(2026, 9, 15, 8, 0, 0), price = 100, baseVol = 10, noise = 0.03, tail = [], seed = 7 } = {}) {
  const r = rng(seed);
  const out = [];
  let p = price;
  const quiet = n - tail.length;
  for (let i = 0; i < n; i++) {
    const open = p;
    let close, vol, wickUp = 0;
    if (i < quiet) {
      close = open * (1 + ((r() - 0.5) * 2 * noise) / 100);
      vol = baseVol * (0.6 + r() * 0.8);
    } else {
      const s = tail[i - quiet];
      close = open * (1 + s.ret / 100);
      vol = baseVol * (s.vol ?? 1);
      wickUp = s.wickUp ?? 0;
    }
    const high = Math.max(open, close) * (1 + (wickUp + r() * noise * 0.3) / 100);
    const low = Math.min(open, close) * (1 - (r() * noise * 0.3) / 100);
    out.push({ start: start + i * 60000, open, high, low, close, volume: vol });
    p = close;
  }
  return out;
}

export function captureNotifier() {
  const messages = [];
  const handler = {
    get(_, prop) {
      if (prop === "messages") return messages;
      return (...args) => {
        messages.push({ type: prop, args });
        return true;
      };
    }
  };
  return new Proxy({}, handler);
}

export { nullLogger };

/** Minimal market stub for order manager / paper exchange tests. */
export class StubMarket {
  constructor(clock) {
    this.clock = clock;
    this.tickers = new Map();
    this.pairs = new Map();
  }
  setPair(symbol, over = {}) {
    const [base, quote] = symbol.split("-");
    this.pairs.set(symbol, { symbol, base, quote, baseStep: "0.0001", quoteStep: "0.01", minOrderSize: 0.0001, maxOrderSize: 1e6, minOrderSizeQuote: 0.1, status: "active", ...over });
  }
  setTicker(symbol, bid, ask, extra = {}) {
    const mid = (bid + ask) / 2;
    this.tickers.set(symbol, { symbol, bid, ask, mid, valid: true, spreadPct: ((ask - bid) / mid) * 100, ts: this.clock.now(), bidRaw: String(bid), askRaw: String(ask), quoteVolume24h: 1e6, ...extra });
  }
  pair(s) {
    return this.pairs.get(s) || null;
  }
  freshTicker(s) {
    const t = this.tickers.get(s);
    return t && this.clock.now() - t.ts <= 15000 ? t : null;
  }
  async refreshPairs() {
    return this.pairs;
  }
  async refreshTickers() {
    for (const [s, t] of this.tickers) this.tickers.set(s, { ...t, ts: this.clock.now() });
    return this.tickers;
  }
  executionUniverse() {
    return [...this.pairs.values()].filter((p) => p.quote === "USDC");
  }
}
