// npm run resolve -- XRP-USDC --closed [--yes]
// Manually resolve a position stuck in "needs_reconciliation" when YOU know it was
// closed outside the bot (e.g. sold in the Revolut app). The position is archived
// as externally closed (its PnL is unknown and is NOT added to the bot statistics)
// and the related discrepancies are marked resolved. The bot must be stopped.
import { setup, arg, positional } from "./common.js";
import { StateStore } from "../storage/stateStore.js";
import { acquireLock } from "../monitoring/instanceLock.js";

const { cfg, logger } = setup({ overrides: { BOT_MODE: "paper" }, level: "warn" });
const mode = arg("mode", "live");
const symbol = String(positional(0) || "").toUpperCase().replace("/", "-");
if (!symbol || !arg("closed")) {
  console.error("usage: npm run resolve -- SYMBOL --closed [--yes] [--mode live]");
  process.exit(1);
}
const lock = acquireLock(cfg.dataDir, mode);
try {
  const store = new StateStore({ dataDir: cfg.dataDir, mode, logger: logger.child("state") });
  store.load();
  const s = store.state;
  const p = Object.values(s.positions).find((x) => x.symbol === symbol && x.status === "needs_reconciliation");
  if (!p) throw new Error(`No ${symbol} position in needs_reconciliation (${mode}).`);
  const disc = s.discrepancies.filter((d) => !d.resolved && d.symbol === symbol);
  console.log(`Position ${p.id}: qty ${p.qty} entry ${p.entryPrice} origin ${p.origin}`);
  console.log(`Open discrepancies: ${disc.map((d) => d.kind).join(", ") || "none"}`);
  if (!arg("yes")) { console.log("Re-run with --yes to archive it as closed outside the bot."); process.exit(0); }
  p.status = "closed";
  p.exitReason = "EXTERNAL_CLOSE_CONFIRMED_BY_USER";
  p.closedAt = new Date().toISOString();
  p.notes.push("closed outside the bot, confirmed manually; PnL unknown and excluded from statistics");
  delete s.positions[p.id];
  s.history.push(p);
  for (const d of disc) { d.resolved = true; d.resolvedAt = new Date().toISOString(); d.resolution = "confirmed closed by user"; }
  store.save({ backup: true });
  console.log("Resolved. Reconciliation will run again at the next start.");
} catch (e) {
  console.error("resolve failed:", e.message);
  process.exitCode = 1;
} finally {
  lock.release();
}
