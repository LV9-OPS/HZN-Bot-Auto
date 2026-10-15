import test from "node:test";
import assert from "node:assert/strict";
import { MarketData } from "../../src/market/marketData.js";
import { buildConfig } from "../../src/config/index.js";
import { makeCfg, nullLogger } from "../helpers.js";

const pair = (base, quote, status = "active") => [`${base}-${quote}`, { symbol: `${base}-${quote}`, base, quote, status }];
const pairs = new Map([
  pair("BTC", "EUR"), pair("ETH", "EUR"), pair("SOL", "EUR"), pair("XRP", "EUR"), pair("DOGE", "EUR"), pair("USDC", "EUR"),
  pair("BTC", "USD"), pair("BTC", "USDC"), pair("ETH", "USDC")
]);

test("EUR quote and TRADE_ASSETS whitelist restrict the execution universe", () => {
  const cfg = makeCfg({ QUOTE_CURRENCY: "EUR", TRADE_ASSETS: "btc,eth,sol,xrp" });
  const md = new MarketData({ client: {}, cfg, logger: nullLogger });
  md.pairs = pairs;
  assert.deepEqual(md.executionUniverse().map((p) => p.symbol).sort(), ["BTC-EUR", "ETH-EUR", "SOL-EUR", "XRP-EUR"]);
});

test("empty whitelist keeps every non-stable pair of the quote", () => {
  const md = new MarketData({ client: {}, cfg: makeCfg({ QUOTE_CURRENCY: "EUR" }), logger: nullLogger });
  md.pairs = pairs;
  assert.equal(md.executionUniverse().length, 5);
});

test("with a fiat quote the signal reference is the execution pair itself", () => {
  const md = new MarketData({ client: {}, cfg: makeCfg({ QUOTE_CURRENCY: "EUR" }), logger: nullLogger });
  md.pairs = pairs;
  md.tickers.set("BTC-USD", { quoteVolume24h: 1e9 });
  assert.equal(md.referenceFor("BTC"), "BTC-EUR");
  const usdc = new MarketData({ client: {}, cfg: makeCfg(), logger: nullLogger });
  usdc.pairs = pairs;
  usdc.tickers.set("BTC-USD", { quoteVolume24h: 1e9 });
  assert.equal(usdc.referenceFor("BTC"), "BTC-USD");
});

test("unknown quote currencies are rejected", () => {
  assert.throws(() => buildConfig({ QUOTE_CURRENCY: "GBP" }), /QUOTE_CURRENCY/);
});
