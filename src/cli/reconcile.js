// npm run reconcile -- [--mode live]  (READ-ONLY dry run)
// Runs the reconciliation engine against the real Revolut X account WITHOUT
// writing state, placing or cancelling anything, or sending Discord messages.
// Use it to inspect what the bot would see at startup.
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { setup, arg } from "./common.js";
import { StateStore } from "../storage/stateStore.js";
import { Journal } from "../storage/journal.js";
import { MarketData } from "../market/marketData.js";
import { LiveExchange } from "../execution/exchanges.js";
import { OrderManager } from "../execution/orderManager.js";
import { RiskManager } from "../risk/riskManager.js";
import { Reconciler } from "../reconciliation/reconciler.js";
import { DiscordNotifier } from "../notifications/discord.js";

const { cfg, logger, client } = setup({ overrides: { BOT_MODE: "paper" }, level: "warn" });
if (!client.authenticated) {
  console.error("REVOLUT_API_KEY / REVOLUT_PRIVATE_KEY_PATH not configured: cannot read the account.");
  process.exit(1);
}
const mode = arg("mode", "live");

// Work on a throw-away copy of the data dir so nothing real is modified.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hzn-reconcile-"));
for (const f of [`state.${mode}.json`, "state.json", `orders.${mode}.jsonl`]) {
  const src = path.join(cfg.dataDir, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, f));
}
const store = new StateStore({ dataDir: tmp, mode, logger: logger.child("state") });
const loaded = store.load();
const journal = new Journal({ dataDir: tmp, mode });
const market = new MarketData({ client, cfg, logger: logger.child("market") });
const live = new LiveExchange({ client });
const readOnly = {
  getBalances: () => live.getBalances(),
  getActiveOrders: (q) => live.getActiveOrders(q),
  getHistoricalOrders: (q) => live.getHistoricalOrders(q),
  getOrder: (id) => live.getOrder(id),
  placeOrder: () => { throw new Error("dry-run: order placement disabled"); },
  cancelOrder: (id) => { console.log(`(dry-run) would cancel orphan order ${id}`); return true; }
};
const messages = [];
const notifier = new DiscordNotifier({ webhookUrl: "", mode, cfg, logger, priceOf: (s) => market.freshTicker(s, 120000) });
const origSend = notifier.send.bind(notifier);
notifier.send = (text, o) => { messages.push(text); return origSend(text, o); };
const risk = new RiskManager({ cfg });
const orders = new OrderManager({ cfg, store, journal, exchange: readOnly, market, risk, notifier, logger: logger.child("orders") });
const rec = new Reconciler({ cfg, store, journal, exchange: readOnly, market, orders, notifier, logger: logger.child("reconcile"), client });

try {
  const balances = await client.getBalances();
  console.log("\n== Balances (non-zero) ==");
  for (const b of balances.values()) if (b.total > 0) console.log(`  ${b.currency.padEnd(6)} total ${b.total} | available ${b.available} | reserved ${b.reserved}`);
  const active = await client.getActiveOrders({});
  console.log(`\n== Active orders: ${active.length} ==`);
  for (const o of active) console.log(`  ${o.symbol} ${o.side} ${o.type} ${o.status} qty ${o.quantity} filled ${o.filledQuantity} price ${o.price}${o.trigger ? " trigger " + JSON.stringify(o.trigger) : ""}`);
  console.log(`\n== Local ${mode} state loaded from: ${loaded.source}; positions: ${Object.keys(store.state.positions).length} ==`);
  const report = await rec.run({ full: true });
  console.log("\n== Reconciliation report (dry run) ==");
  console.log(JSON.stringify(report, null, 2));
  console.log("\n== Positions after reconciliation (not saved) ==");
  for (const p of Object.values(store.state.positions)) console.log(`  ${p.symbol} slot ${p.slot} ${p.plan.name} status ${p.status} qty ${p.qty} entry ${p.entryPrice} targetReached ${p.targetReached} origin ${p.origin}`);
  for (const h of store.state.unmanagedHoldings) console.log(`  UNMANAGED ${h.currency} ${h.total} (~${h.valueQuote} USDC)`);
  console.log("\n== Notifications that would be sent ==");
  for (const m of messages) console.log("  - " + m.replace(/\n/g, " / ").slice(0, 400));
  console.log("\nNothing was written, ordered or cancelled.");
} catch (e) {
  console.error("Reconciliation dry run failed:", e.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  setTimeout(() => process.exit(process.exitCode || 0), 100);
}
