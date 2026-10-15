// npm run stop | npm run emergency-on | npm run emergency-off
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, buildConfig } from "../config/index.js";
import { arg } from "./common.js";

loadEnvFile();
const cfg = buildConfig(process.env);
const action = process.argv[2];
fs.mkdirSync(cfg.dataDir, { recursive: true });
if (action === "stop") {
  const mode = arg("mode", cfg.BOT_MODE);
  fs.writeFileSync(path.join(cfg.dataDir, `STOP.${mode}`), new Date().toISOString());
  console.log(`Stop requested for ${mode} bot (it shuts down gracefully within ~2 s; the supervisor will not restart it).`);
} else if (action === "emergency-on") {
  fs.writeFileSync(path.join(cfg.dataDir, "EMERGENCY_STOP"), new Date().toISOString());
  console.log("EMERGENCY_STOP set: no new entries. Open positions stay monitored.");
} else if (action === "emergency-off") {
  try { fs.unlinkSync(path.join(cfg.dataDir, "EMERGENCY_STOP")); } catch { /* none */ }
  console.log("EMERGENCY_STOP cleared.");
} else if (action === "risk-reset") {
  // Acknowledge a max-drawdown halt after a manual review: the drawdown peak restarts from now.
  const { StateStore } = await import("../storage/stateStore.js");
  const { acquireLock } = await import("../monitoring/instanceLock.js");
  const mode = arg("mode", cfg.BOT_MODE);
  const lock = acquireLock(cfg.dataDir, mode);
  try {
    const store = new StateStore({ dataDir: cfg.dataDir, mode });
    store.load({ allowFresh: false });
    store.state.riskPeakRealized = store.state.stats.realizedNetPnl || 0;
    store.state.riskResetAt = new Date().toISOString();
    store.save({ backup: true });
    console.log(`Drawdown halt reset for ${mode} (peak = current realized PnL ${store.state.riskPeakRealized.toFixed(4)}).`);
  } finally {
    lock.release();
  }
} else {
  console.log("usage: node src/cli/control.js stop|emergency-on|emergency-off|risk-reset");
  process.exit(1);
}
