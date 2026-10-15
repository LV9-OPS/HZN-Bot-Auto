// Market data cache shared by radar, signals, position monitor and paper exchange.
// - pair configuration cached (static-ish, refreshed every 10 min)
// - latest ticker per symbol + short snapshot history for the radar
// - incremental 1-minute candle cache per reference symbol
import { PRIORITY } from "../api/scheduler.js";
import { splitSymbol, STABLE_OR_FIAT } from "../util/symbols.js";
import { closedOnly } from "../signals/indicators.js";

const PAIRS_TTL = 10 * 60 * 1000;
const SNAP_KEEP_MS = 20 * 60 * 1000;
const CANDLE_KEEP = 240;

export class MarketData {
  constructor({ client, cfg, logger, clock = { now: () => Date.now() } }) {
    this.client = client;
    this.cfg = cfg;
    this.log = logger;
    this.clock = clock;
    this.pairs = new Map();
    this.pairsAt = 0;
    this.tickers = new Map(); // symbol -> ticker
    this.snapshots = new Map(); // symbol -> [{ts, mid, index, vol24}]
    this.candles = new Map(); // symbol -> { list, fetchedAt }
    this.lastTickerOkAt = 0;
    this.priceHistory = new Map(); // symbol -> last reliable bid (anomaly check)
  }

  pair(symbol) {
    return this.pairs.get(symbol) || null;
  }

  async refreshPairs(force = false) {
    if (!force && this.pairs.size && this.clock.now() - this.pairsAt < PAIRS_TTL) return this.pairs;
    const pairs = await this.client.getPairs();
    this.pairs = pairs;
    this.pairsAt = this.clock.now();
    return pairs;
  }

  /** Eligible execution universe: active BASE-USDC pairs, non-stable bases. */
  executionUniverse() {
    const q = this.cfg.QUOTE_CURRENCY;
    return [...this.pairs.values()].filter((p) => p.quote === q && p.status === "active" && !STABLE_OR_FIAT.has(p.base));
  }

  /** For a base asset choose the most liquid reference market among SIGNAL_REFERENCE_QUOTES. */
  referenceFor(base) {
    let best = null;
    for (const q of this.cfg.SIGNAL_REFERENCE_QUOTES) {
      const sym = `${base}-${q}`;
      const p = this.pairs.get(sym);
      if (!p || p.status !== "active") continue;
      const tk = this.tickers.get(sym);
      const vol = tk?.quoteVolume24h ?? 0;
      if (!best || vol > best.vol) best = { symbol: sym, vol };
    }
    return best?.symbol || `${base}-${this.cfg.QUOTE_CURRENCY}`;
  }

  ingestTickers(map) {
    const now = this.clock.now();
    for (const [sym, tk] of map) {
      this.tickers.set(sym, tk);
      if (!tk.valid) continue;
      let arr = this.snapshots.get(sym);
      if (!arr) this.snapshots.set(sym, (arr = []));
      const last = arr[arr.length - 1];
      if (!last || tk.ts > last.ts) arr.push({ ts: tk.ts, mid: tk.mid, index: tk.index, vol24: tk.volume24h });
      while (arr.length && now - arr[0].ts > SNAP_KEEP_MS) arr.shift();
    }
    this.lastTickerOkAt = now;
  }

  async refreshAllTickers(priority = PRIORITY.RADAR) {
    const map = await this.client.getTickers(undefined, priority);
    this.ingestTickers(map);
    return map;
  }

  async refreshTickers(symbols, priority = PRIORITY.POSITION) {
    if (!symbols.length) return new Map();
    const map = await this.client.getTickers(symbols, priority);
    this.ingestTickers(map);
    return map;
  }

  /** Latest ticker if it is fresh and valid, otherwise null. Never invents a price. */
  freshTicker(symbol, maxAgeMs = this.cfg.PRICE_MAX_AGE_MS) {
    const tk = this.tickers.get(symbol);
    if (!tk || !tk.valid) return null;
    if (this.clock.now() - tk.ts > maxAgeMs) return null;
    return tk;
  }

  /** Price change over the last `ms` from radar snapshots (mid or index). */
  snapshotChange(symbol, ms, field = "mid") {
    const arr = this.snapshots.get(symbol);
    if (!arr || arr.length < 2) return NaN;
    const last = arr[arr.length - 1];
    const target = last.ts - ms;
    let ref = null;
    for (const s of arr) {
      if (s.ts <= target) ref = s;
      else break;
    }
    if (!ref || !(ref[field] > 0) || !(last[field] > 0)) return NaN;
    return ((last[field] - ref[field]) / ref[field]) * 100;
  }

  /** Incrementally fetch 1m candles and return CLOSED candles only. */
  async closedCandles(symbol, { maxAgeMs = this.cfg.CANDLE_REFRESH_MS, priority = PRIORITY.DEEP } = {}) {
    const now = this.clock.now();
    const entry = this.candles.get(symbol);
    if (!entry || now - entry.fetchedAt >= maxAgeMs) {
      const since = entry?.list?.length ? entry.list[entry.list.length - 1].start : now - 150 * 60000;
      const fresh = await this.client.getCandles(symbol, { interval: 1, since, until: now }, priority);
      const merged = new Map((entry?.list || []).map((c) => [c.start, c]));
      for (const c of fresh) merged.set(c.start, c);
      const list = [...merged.values()].sort((a, b) => a.start - b.start).slice(-CANDLE_KEEP);
      this.candles.set(symbol, { list, fetchedAt: now });
    }
    return closedOnly(this.candles.get(symbol).list, now);
  }

  candleAge(symbol) {
    const e = this.candles.get(symbol);
    return e ? this.clock.now() - e.fetchedAt : Infinity;
  }

  /** Price for exit decisions: fresh valid bid with an anomaly guard (a huge jump needs a 2nd confirming tick). */
  reliableBid(symbol) {
    const tk = this.freshTicker(symbol);
    if (!tk) return { reliable: false, reason: "no fresh valid quote" };
    const prev = this.priceHistory.get(symbol);
    const bid = tk.bid;
    if (prev && prev.bid > 0) {
      const jump = Math.abs((bid - prev.bid) / prev.bid) * 100;
      if (jump > this.cfg.PRICE_ANOMALY_PCT && prev.ts !== tk.ts) {
        if (!prev.pending || Math.abs((bid - prev.pending) / prev.pending) * 100 > 2) {
          this.priceHistory.set(symbol, { ...prev, pending: bid });
          return { reliable: false, reason: `price jump ${jump.toFixed(1)}% awaiting confirmation`, bid };
        }
      }
    }
    this.priceHistory.set(symbol, { bid, ts: tk.ts, pending: null });
    return { reliable: true, bid, ask: tk.ask, ts: tk.ts, spreadPct: tk.spreadPct };
  }

  baseOf(symbol) {
    return splitSymbol(symbol).base;
  }
}
