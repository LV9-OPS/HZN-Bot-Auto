// Strict normalization of exchange payloads. Malformed data raises or is
// flagged instead of turning into zeros that could look like "no position".
import { ApiError } from "./errors.js";
import { toNum } from "../util/num.js";
import { normSymbol } from "../util/symbols.js";

export function listOf(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.data)) return raw.data;
  return null;
}

export function normalizePairs(raw) {
  const data = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("malformed", "pairs payload is not an object");
  const out = new Map();
  for (const [key, c] of Object.entries(data)) {
    if (!c || typeof c !== "object") continue;
    const symbol = normSymbol(key);
    const pair = {
      symbol,
      base: String(c.base || symbol.split("-")[0]).toUpperCase(),
      quote: String(c.quote || symbol.split("-")[1]).toUpperCase(),
      baseStep: String(c.base_step ?? ""),
      quoteStep: String(c.quote_step ?? ""),
      minOrderSize: toNum(c.min_order_size),
      maxOrderSize: toNum(c.max_order_size),
      minOrderSizeQuote: toNum(c.min_order_size_quote),
      maxOrderSizeQuote: toNum(c.max_order_size_quote),
      status: String(c.status || "").toLowerCase()
    };
    if (!(toNum(pair.baseStep) > 0)) continue; // unusable configuration
    out.set(symbol, pair);
  }
  if (out.size === 0) throw new ApiError("malformed", "pairs payload contained no usable pair");
  return out;
}

export function normalizeTickers(raw, now) {
  const list = listOf(raw);
  if (!list) throw new ApiError("malformed", "tickers payload has no data array");
  const ts = Number(raw?.metadata?.timestamp) || now;
  const out = new Map();
  for (const t of list) {
    const symbol = normSymbol(t.symbol);
    if (!symbol.includes("-")) continue;
    const bid = toNum(t.bid);
    const ask = toNum(t.ask);
    const tk = {
      symbol,
      bid,
      ask,
      mid: toNum(t.mid),
      last: toNum(t.last_price),
      index: toNum(t.index_price),
      high24h: toNum(t.high_24h),
      low24h: toNum(t.low_24h),
      change24h: toNum(t.price_change_24h),
      volume24h: toNum(t.volume_24h),
      quoteVolume24h: toNum(t.quote_volume_24h),
      bidRaw: String(t.bid ?? ""),
      askRaw: String(t.ask ?? ""),
      ts
    };
    if (!Number.isFinite(tk.mid) && bid > 0 && ask > 0) tk.mid = (bid + ask) / 2;
    tk.valid = bid > 0 && ask > 0 && ask >= bid;
    tk.spreadPct = tk.valid ? ((ask - bid) / tk.mid) * 100 : NaN;
    // Duplicate symbols (seen when region is omitted) - keep the most liquid.
    const prev = out.get(symbol);
    if (!prev || (tk.quoteVolume24h || 0) > (prev.quoteVolume24h || 0)) out.set(symbol, tk);
  }
  return out;
}

export function normalizeCandles(raw, interval = 1) {
  const list = listOf(raw);
  if (!list) throw new ApiError("malformed", "candles payload has no data array");
  const out = [];
  for (const c of list) {
    const k = { start: Number(c.start), open: toNum(c.open), high: toNum(c.high), low: toNum(c.low), close: toNum(c.close), volume: toNum(c.volume) };
    if (!Number.isFinite(k.start) || !(k.close > 0) || !(k.high > 0) || !(k.low > 0) || !(k.open > 0)) continue;
    if (!Number.isFinite(k.volume) || k.volume < 0) k.volume = 0;
    k.interval = interval;
    out.push(k);
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

export function normalizeOrderBook(raw) {
  const d = raw?.data ?? raw;
  const side = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((l) => (Array.isArray(l) ? { price: toNum(l[0]), qty: toNum(l[1]) } : { price: toNum(l.p ?? l.price), qty: toNum(l.q ?? l.quantity ?? l.qty) }))
      .filter((l) => l.price > 0 && l.qty > 0);
  const bids = side(d?.bids).sort((a, b) => b.price - a.price);
  const asks = side(d?.asks).sort((a, b) => a.price - b.price);
  return { bids, asks };
}

export function normalizeBalances(raw) {
  const list = listOf(raw);
  if (!list) throw new ApiError("malformed", "balances payload has no data array");
  const out = new Map();
  for (const b of list) {
    const currency = String(b.currency || "").toUpperCase();
    if (!currency) throw new ApiError("malformed", "balance entry without currency");
    const available = toNum(b.available);
    const reserved = toNum(b.reserved ?? 0);
    const staked = toNum(b.staked ?? 0);
    let total = toNum(b.total);
    if (!Number.isFinite(available)) throw new ApiError("malformed", `balance ${currency} has invalid available`);
    if (!Number.isFinite(total)) total = available + (reserved || 0) + (staked || 0);
    out.set(currency, { currency, available, reserved: reserved || 0, staked: staked || 0, total });
  }
  return out;
}

const STATUS = new Set(["pending_new", "new", "partially_filled", "filled", "cancelled", "rejected", "replaced"]);
export function normStatus(s) {
  const v = String(s || "").toLowerCase().replace("canceled", "cancelled");
  return STATUS.has(v) ? v : "unknown";
}

export const TERMINAL = new Set(["filled", "cancelled", "rejected", "replaced"]);
export const OPEN = new Set(["pending_new", "new", "partially_filled"]);

export function normalizeOrder(o) {
  if (!o || typeof o !== "object") throw new ApiError("malformed", "order is not an object");
  const filled = toNum(o.filled_quantity);
  const avg = toNum(o.average_fill_price);
  const filledAmount = toNum(o.filled_amount);
  return {
    venueOrderId: String(o.id ?? o.venue_order_id ?? ""),
    clientOrderId: String(o.client_order_id ?? ""),
    previousOrderId: o.previous_order_id ? String(o.previous_order_id) : null,
    symbol: normSymbol(o.symbol),
    side: String(o.side || "").toLowerCase(),
    type: String(o.type || "").toLowerCase(),
    status: normStatus(o.status ?? o.state),
    quantity: toNum(o.quantity),
    filledQuantity: Number.isFinite(filled) ? filled : 0,
    leavesQuantity: toNum(o.leaves_quantity),
    price: toNum(o.price),
    avgFillPrice: Number.isFinite(avg) ? avg : (filled > 0 && filledAmount > 0 ? filledAmount / filled : NaN),
    filledAmount: Number.isFinite(filledAmount) ? filledAmount : (filled > 0 && avg > 0 ? filled * avg : 0),
    totalFee: toNum(o.total_fee),
    feeCurrency: o.fee_currency ? String(o.fee_currency).toUpperCase() : null,
    rejectReason: o.reject_reason || null,
    timeInForce: o.time_in_force || null,
    trigger: o.conditional || o.stop_loss || o.take_profit ? { conditional: o.conditional || null, stopLoss: o.stop_loss || null, takeProfit: o.take_profit || null } : null,
    createdAt: Number(o.created_date) || null,
    updatedAt: Number(o.updated_date) || null
  };
}

export function normalizeFill(f) {
  return { price: toNum(f.p ?? f.price), qty: toNum(f.q ?? f.quantity), side: String(f.s ?? f.side ?? "").toLowerCase(), tradeId: String(f.tid ?? f.id ?? ""), orderId: String(f.oid ?? ""), ts: Number(f.tdt ?? f.ts ?? f.timestamp) || null };
}
