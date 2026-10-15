// npm run status [-- --mode live|paper] : print the last status snapshot written by the bot.
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, buildConfig } from "../config/index.js";
import { arg } from "./common.js";

loadEnvFile();
const cfg = buildConfig(process.env);
const mode = arg("mode", cfg.BOT_MODE);
const file = path.join(cfg.dataDir, `status.${mode}.json`);
if (!fs.existsSync(file)) {
  console.log(`No status file for ${mode} mode (${file}). Is the bot running?`);
  process.exit(1);
}
const s = JSON.parse(fs.readFileSync(file, "utf8"));
const age = Math.round((Date.now() - Date.parse(s.at)) / 1000);
const lockFile = path.join(cfg.dataDir, `bot.${mode}.lock`);
let running = "no";
if (fs.existsSync(lockFile)) {
  try {
    const { pid } = JSON.parse(fs.readFileSync(lockFile, "utf8"));
    process.kill(pid, 0);
    running = `yes (pid ${pid})`;
  } catch {
    running = "no (stale lock)";
  }
}
if (arg("json")) {
  console.log(JSON.stringify(s, null, 2));
  process.exit(0);
}
console.log(`\nHZN Bot Auto — ${s.mode.toUpperCase()} — running: ${running} — snapshot ${age}s old`);
console.log(`Health: ${s.healthy ? "OK" : "DEGRADED " + s.issues.join(", ")}`);
console.log(`Entries: ${s.entryGate.ok ? "allowed" : "BLOCKED: " + s.entryGate.reasons.map((r) => r.code).join(", ")}`);
console.log(`Capital: budget ${s.capital.budget} | deployed ${s.capital.deployed.toFixed(4)} | remaining ${s.capital.remaining.toFixed(4)} | quote ${typeof s.capital.quoteBalance === "number" ? s.capital.quoteBalance.toFixed(4) : s.capital.quoteBalance}`);
const p = s.performance;
console.log(`PnL (net of fees): realized ${p.realizedNetPnl.toFixed(4)} | unrealized ${p.unrealizedNetPnl.toFixed(4)} | fees ${p.totalFees.toFixed(4)} | trades ${p.trades} | win rate ${p.winRate === null ? "n/a" : (p.winRate * 100).toFixed(0) + "%"} | maxDD ${p.maxDrawdown.toFixed(4)} | today ${p.dailyRealized.toFixed(4)}`);
console.log("\nPositions:");
if (!s.positions.length) console.log("  (none)");
for (const x of s.positions) console.log(`  [slot ${x.slot} ${x.plan}] ${x.symbol} ${x.status} qty ${x.qty} entry ${x.entryPrice} bid ${x.bid} stop ${x.stopPrice} target ${x.targetPrice} floorArmed ${x.targetReached} netPnL ${x.netPnl} | ${x.protection}${x.pendingExit ? " | exit " + x.pendingExit : ""}`);
const disc = s.discrepancies.filter((d) => !d.resolved);
if (disc.length) {
  console.log("\nOpen discrepancies:");
  for (const d of disc) console.log(`  [${d.severity}] ${d.kind} ${d.symbol || ""} ${JSON.stringify(d.details)}`);
}
if (s.unmanagedHoldings?.length) {
  console.log("\nUnmanaged holdings (not touched by the bot):");
  for (const h of s.unmanagedHoldings) console.log(`  ${h.currency} ${h.total} (~${h.valueQuote} USDC)`);
}
console.log("\nScanner top:");
for (const l of s.leaderboard.slice(0, 6)) console.log(`  ${l.symbol.padEnd(11)} ${String(l.score).padStart(5)} ${l.qualified ? "QUALIFIED" : "rejected "} ${l.why.slice(0, 110)}`);
console.log(`\nAPI last minute: ${Object.entries(s.api).filter(([, v]) => typeof v === "object").map(([k, v]) => `${k} ${v.lastMinute}${v.paused ? " PAUSED" : ""}`).join(" | ")} | radar ${s.api.radarIntervalMs}ms`);
console.log(`Dashboard: http://127.0.0.1:${cfg.HEALTH_PORT}/\n`);
