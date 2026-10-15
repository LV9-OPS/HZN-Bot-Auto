import { loadEnvFile, buildConfig } from "../config/index.js";
import { Logger } from "../monitoring/logger.js";
import { registerSecret } from "../monitoring/redact.js";
import { RequestScheduler } from "../api/scheduler.js";
import { RevolutXClient } from "../api/revolutx.js";

export function setup({ overrides = {}, consoleLogs = true, level } = {}) {
  loadEnvFile();
  const cfg = buildConfig({ ...process.env, ...overrides });
  registerSecret(cfg.REVOLUT_API_KEY);
  registerSecret(cfg.DISCORD_WEBHOOK_URL);
  const logger = new Logger({ dir: null, level: level || cfg.LOG_LEVEL, console: consoleLogs });
  const scheduler = RequestScheduler.fromConfig(cfg, { logger: logger.child("api") });
  const client = new RevolutXClient({ cfg, scheduler, logger: logger.child("api") });
  return { cfg, logger, scheduler, client };
}

export function arg(name, def = undefined) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
}

export function positional(n = 0) {
  return process.argv.slice(2).filter((a, i, arr) => !a.startsWith("--") && !(i > 0 && arr[i - 1].startsWith("--") && !["--yes", "--json"].includes(arr[i - 1])))[n];
}
