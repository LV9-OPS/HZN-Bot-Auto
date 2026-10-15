// npm run account -- [--days 30]   READ-ONLY account overview.
// Balances valued with the best available market (USDC, USD, EUR) and a summary
// of filled orders per symbol, to explain where holdings came from.
import { setup, arg } from "../src/cli/common.js";
import { MarketData } from "../src/market/marketData.js";
import { PRIORITY } from "../src/api/scheduler.js";
import { STABLE_OR_FIAT } from "../src/util/symbols.js";

const { cfg, logger, client } = setup({ overrides: { BOT_MODE: "paper" }, level: "warn" });
if (!client.authenticated) { console.error("credentials required"); process.exit(1); }
const days = Number(arg("days", 30));
const market = new MarketData({ client, cfg, logger: logger.child("market") });
await market.refreshPairs(true);
await market.refreshAllTickers(PRIORITY.RECONCILE);
const balances = await client.getBalances();
const valueOf = (cur, qty) => {
  if (STABLE_OR_FIAT.has(cur) && ["USDC", "USDT", "USD"].includes(cur)) return { v: qty, via: cur };
  for (const q of ["USDC", "USD", "EUR"]) {
    const t = market.tickers.get(`${cur}-${q}`);
    if (t?.valid) return { v: qty * t.bid, via: `${cur}-${q}` };
  }
  return { v: NaN, via: "no market" };
};
console.log("\n== Balances ==");
let total = 0;
for (const b of balances.values()) {
  if (!(b.total > 0)) continue;
  const { v, via } = valueOf(b.currency, b.total);
  if (Number.isFinite(v)) total += v;
  console.log(`  ${b.currency.padEnd(6)} ${String(b.total).padEnd(16)} ~${Number.isFinite(v) ? v.toFixed(4) : "?"} (${via})${b.reserved ? " reserved " + b.reserved : ""}`);
}
console.log(`  total ~${total.toFixed(2)} (USD-ish)`);
const hist = await client.getHistoricalOrders({ startDate: Date.now() - days * 86400000, endDate: Date.now() });
const filled = hist.filter((o) => o.filledQuantity > 0).sort((a, b) => a.createdAt - b.createdAt);
console.log(`\n== Filled orders, last ${days} days: ${filled.length} ==`);
for (const o of filled) console.log(`  ${new Date(o.createdAt).toISOString().slice(0, 16)} ${o.symbol.padEnd(11)} ${o.side.padEnd(4)} ${o.type.padEnd(6)} qty ${o.filledQuantity} @ ${o.avgFillPrice} fee ${o.totalFee} ${o.feeCurrency || ""} cid ${o.clientOrderId ? o.clientOrderId.slice(0, 8) : "-"}`);
process.exit(0);
