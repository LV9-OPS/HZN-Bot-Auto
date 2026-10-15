// npm run fetch-history -- [--days 7]
// Downloads 1-minute candles of each eligible asset's reference market (and the
// USDC execution pair's current spread) into data/history/ for replay tests.
// Read-only; respects the documented rate limits through the shared scheduler.
import fs from "node:fs";
import path from "node:path";
import { setup, arg } from "../src/cli/common.js";
import { MarketData } from "../src/market/marketData.js";
import { PRIORITY } from "../src/api/scheduler.js";

const { cfg, logger, client } = setup({ overrides: { BOT_MODE: "paper" }, level: "info" });
const days = Number(arg("days", 7));
const outDir = path.join(cfg.dataDir, "history");
fs.mkdirSync(outDir, { recursive: true });
const market = new MarketData({ client, cfg, logger: logger.child("market") });
await market.refreshPairs(true);
await market.refreshAllTickers(PRIORITY.RECONCILE);
const universe = market.executionUniverse();
const meta = { fetchedAt: new Date().toISOString(), days, authenticated: client.authenticated, region: cfg.REVOLUT_REGION, assets: [] };
const end = Date.now() - 60000;
const start = end - days * 86400000;
const perRequest = client.authenticated ? 5000 : 1000;
for (const pair of universe) {
  const ref = market.referenceFor(pair.base);
  const exec = market.tickers.get(pair.symbol);
  const refTk = market.tickers.get(ref);
  const all = new Map();
  let until = end;
  let guard = 0;
  while (until > start && guard++ < 50) {
    const since = Math.max(start, until - perRequest * 60000);
    try {
      const candles = await client.getCandles(ref, { interval: 1, since, until }, PRIORITY.BACKGROUND);
      for (const c of candles) all.set(c.start, c);
    } catch (e) {
      console.warn(`  ${ref}: ${e.message}`);
      break;
    }
    until = since;
  }
  const list = [...all.values()].sort((a, b) => a.start - b.start).map((c) => [c.start, c.open, c.high, c.low, c.close, c.volume]);
  fs.writeFileSync(path.join(outDir, `${ref}.json`), JSON.stringify(list));
  meta.assets.push({ base: pair.base, exec: pair.symbol, ref, candles: list.length, execSpreadPct: exec?.spreadPct ?? null, execQuoteVolume24h: exec?.quoteVolume24h ?? null, refQuoteVolume24h: refTk?.quoteVolume24h ?? null, minOrderSizeQuote: pair.minOrderSizeQuote });
  console.log(`${pair.symbol.padEnd(11)} ref ${ref.padEnd(10)} candles ${list.length} spread ${exec?.spreadPct?.toFixed(3)}%`);
}
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
console.log(`saved to ${outDir}`);
process.exit(0);
