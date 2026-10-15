// HZN Bot Auto v3 - entry point.
import { loadEnvFile, buildConfig, publicConfig } from "./config/index.js";
import { Logger } from "./monitoring/logger.js";
import { acquireLock } from "./monitoring/instanceLock.js";
import { startStatusServer } from "./monitoring/statusServer.js";
import { registerSecret } from "./monitoring/redact.js";
import { Bot } from "./bot.js";

const envFile = loadEnvFile();
let cfg;
try {
  cfg = buildConfig(process.env);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
registerSecret(cfg.REVOLUT_API_KEY);
registerSecret(cfg.DISCORD_WEBHOOK_URL);

const logger = new Logger({ dir: cfg.logDir, level: cfg.LOG_LEVEL, timeZone: cfg.RISK_DAY_TIMEZONE });
const log = logger.child("main");

const banner = cfg.BOT_MODE === "live" ? "LIVE MODE - REAL ORDERS ON REVOLUT X" : "PAPER MODE - simulated orders, live market data";
log.info("=".repeat(60));
log.info(`HZN Bot Auto v3 starting | ${banner}`);
log.info("config", { envFile: envFile ? "loaded" : "none", ...publicConfig(cfg) });
for (const w of cfg.warnings) log.warn("config warning: " + w);
log.warn("Stop-loss and X2/X3 exits are SOFTWARE-monitored: Revolut X API cannot create native stop orders. Nothing protects positions while the bot is stopped.");

let lock;
try {
  lock = acquireLock(cfg.dataDir, cfg.BOT_MODE);
} catch (e) {
  log.error(e.message);
  process.exit(3);
}

const bot = new Bot({ cfg, logger });
let server = null;
let exiting = false;

async function shutdown(code, reason) {
  if (exiting) return;
  exiting = true;
  try {
    await bot.stop(reason);
  } catch (e) {
    log.error("error during shutdown", { err: e.message });
  }
  server?.close();
  lock?.release();
  log.info(`exit (${code})`);
  setTimeout(() => process.exit(code), 200);
}

bot.onStopRequest = (why) => shutdown(0, why);
process.on("SIGINT", () => shutdown(0, "SIGINT"));
process.on("SIGTERM", () => shutdown(0, "SIGTERM"));
process.on("SIGBREAK", () => shutdown(0, "SIGBREAK")); // Ctrl+Break / console close on Windows
process.on("unhandledRejection", (e) => {
  log.error("unhandled rejection - restarting via supervisor", { err: e?.message || String(e), stack: e?.stack?.split("\n").slice(0, 5) });
  bot.notifier.emergency(`Exception non gérée : ${e?.message || e}. Redémarrage par le superviseur.`);
  shutdown(1, "unhandled rejection");
});
process.on("uncaughtException", (e) => {
  log.error("uncaught exception - restarting via supervisor", { err: e?.message, stack: e?.stack?.split("\n").slice(0, 5) });
  bot.notifier.emergency(`Exception non gérée : ${e?.message}. Redémarrage par le superviseur.`);
  shutdown(1, "uncaught exception");
});

try {
  await bot.init();
  server = startStatusServer({ port: cfg.HEALTH_PORT, getStatus: () => bot.lastStatus || bot.statusSnapshot(), logger: logger.child("status") });
  await bot.run();
} catch (e) {
  log.error("fatal", { err: e.message, details: e.details });
  bot.notifier.emergency(`Arrêt fatal : ${e.message}`);
  await shutdown(1, "fatal: " + e.message);
}
