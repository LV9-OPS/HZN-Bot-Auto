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
} else {
  console.log("usage: node src/cli/control.js stop|emergency-on|emergency-off");
  process.exit(1);
}
