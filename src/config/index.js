// Centralized, validated configuration. Every tunable lives here with its
// default, bounds and a one-line rationale (see docs/CONFIGURATION.md).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const bool = (v) => ["1", "true", "yes", "on"].includes(String(v).trim().toLowerCase());

/**
 * Spec: name -> { type, def, min, max, enum, secret, desc }
 * Numbers are validated against min/max. Unknown HZN_/REVOLUT_ vars produce a warning.
 */
export const SPEC = {
  // --- mode & safety ---
  BOT_MODE: { type: "enum", enum: ["paper", "live"], def: "paper", desc: "paper = simulated orders on live market data; live = real orders" },
  LIVE_TRADING_CONFIRMATION: { type: "string", def: "", desc: "Must equal I_ACCEPT_REAL_MONEY_RISK for live mode" },
  EMERGENCY_STOP: { type: "bool", def: false, desc: "Block all new entries (positions keep being managed)" },

  // --- Revolut X ---
  REVOLUT_API_KEY: { type: "string", def: "", secret: true, desc: "64-char API key" },
  REVOLUT_PRIVATE_KEY_PATH: { type: "string", def: "", desc: "Path to Ed25519 private key PEM (outside the repo)" },
  REVOLUT_REGION: { type: "enum", enum: ["EEA", "UK", "US", "GLOBAL"], def: "EEA", desc: "Region for public endpoints" },
  REVOLUT_BASE_URL: { type: "string", def: "https://revx.revolut.com/api", desc: "API base URL" },
  HTTP_TIMEOUT_MS: { type: "int", def: 10000, min: 2000, max: 60000, desc: "Per request timeout" },

  // --- API budget (documented limits: public 1 req/s; authenticated 100/s & 1000/min; orders 10/s & 1000/day) ---
  API_PUBLIC_PER_SEC: { type: "num", def: 0.8, min: 0.1, max: 1, desc: "Public endpoint rate (doc limit 1/s)" },
  API_AUTH_PER_MIN: { type: "int", def: 400, min: 30, max: 900, desc: "Authenticated read budget per minute (doc limit 1000)" },
  API_ORDERS_PER_DAY: { type: "int", def: 600, min: 10, max: 950, desc: "Order placement budget per day (doc limit 1000)" },

  // --- capital ---
  MAX_TRADING_BUDGET_QUOTE: { type: "num", def: 10, min: 1, max: 10, desc: "Hard cap on capital deployed (USDC). Hard-limited to 10 by code." },
  SLOT_ALLOCATIONS: { type: "list-num", def: [5, 3, 2], desc: "Per-slot allocation in USDC, slot 1..3" },
  MAX_OPEN_POSITIONS: { type: "int", def: 3, min: 1, max: 3, desc: "Simultaneous positions" },
  QUOTE_CURRENCY: { type: "enum", enum: ["USDC"], def: "USDC", desc: "Quote currency traded" },
  MIN_POSITION_QUOTE: { type: "num", def: 1, min: 0.1, max: 10, desc: "Below this an allocation is not worth trading" },
  DUST_THRESHOLD_QUOTE: { type: "num", def: 0.5, min: 0, max: 5, desc: "Holdings worth less are dust" },
  PAPER_START_QUOTE: { type: "num", def: 10, min: 1, max: 100000, desc: "Paper account starting USDC" },

  // --- exits ---
  STOP_LOSS_PCT: { type: "num", def: 3, min: 0.5, max: 50, desc: "Initial stop below entry, checked on bid, active until target reached" },
  PLAN_SLOT1: { type: "string", def: "2:1", desc: "target:floor multiples for slot 1 (X2 then floor X1)" },
  PLAN_SLOT2: { type: "string", def: "3:2", desc: "slot 2 (X3 then floor X2)" },
  PLAN_SLOT3: { type: "string", def: "3:2", desc: "slot 3 (X3 then floor X2)" },
  EXIT_LIMIT_SLIPPAGE_PCT: { type: "num", def: 0.5, min: 0.05, max: 5, desc: "IOC sell limit placed this far below bid" },
  EXIT_MAX_IOC_ATTEMPTS: { type: "int", def: 3, min: 1, max: 10, desc: "IOC attempts before market fallback (stop/emergency only)" },
  EXIT_MARKET_FALLBACK: { type: "bool", def: true, desc: "Use a market sell when IOC attempts fail for stop-loss/emergency exits" },
  PRICE_MAX_AGE_MS: { type: "int", def: 15000, min: 2000, max: 120000, desc: "A bid older than this is not used for exit decisions" },
  PRICE_ANOMALY_PCT: { type: "num", def: 15, min: 2, max: 90, desc: "Jumps larger than this need a second confirming tick" },

  // --- emergency policy ---
  EMERGENCY_EXIT_ON_DELIST: { type: "bool", def: true, desc: "Exit if a held pair becomes inactive and a reliable bid exists" },
  EMERGENCY_DATA_OUTAGE_MS: { type: "int", def: 120000, min: 10000, max: 3600000, desc: "Alert when no reliable price for this long" },

  // --- entries ---
  ENTRY_LIMIT_SLIPPAGE_PCT: { type: "num", def: 0.15, min: 0, max: 2, desc: "IOC buy limit this far above ask" },
  SIGNAL_MAX_AGE_MS: { type: "int", def: 20000, min: 2000, max: 300000, desc: "Signal older than this is stale" },
  MAX_CHASE_PCT: { type: "num", def: 0.5, min: 0, max: 5, desc: "Reject if ask moved more than this since signal" },
  MAX_SPREAD_PCT: { type: "num", def: 0.4, min: 0.01, max: 5, desc: "Max bid/ask spread on the USDC pair" },
  MIN_EXEC_QUOTE_VOLUME_24H: { type: "num", def: 5000, min: 0, max: 1e9, desc: "Min 24h USDC volume on execution pair" },
  MIN_REF_QUOTE_VOLUME_24H: { type: "num", def: 100000, min: 0, max: 1e10, desc: "Min 24h volume on the signal reference pair" },
  TAKER_FEE_PCT: { type: "num", def: 0.09, min: 0, max: 2, desc: "Revolut X taker fee (published 0.09%)" },
  EST_SLIPPAGE_PCT: { type: "num", def: 0.05, min: 0, max: 2, desc: "Expected slippage per side" },
  MAX_COST_TO_STOP_RATIO: { type: "num", def: 0.35, min: 0.05, max: 1, desc: "Round-trip cost must be below this fraction of the stop distance" },
  MIN_SCORE: { type: "num", def: 62, min: 0, max: 100, desc: "Minimum candidate score to consider an entry" },
  SYMBOL_COOLDOWN_MIN: { type: "int", def: 60, min: 0, max: 10080, desc: "No re-entry on a symbol after an exit for this long" },
  SIGNAL_REFERENCE_QUOTES: { type: "list", def: ["USD", "EUR", "USDC"], desc: "Quotes considered as momentum reference market (most liquid wins)" },

  // --- risk ---
  MAX_DAILY_LOSS_QUOTE: { type: "num", def: 1.5, min: 0.1, max: 10, desc: "Realized net loss that blocks new entries for the day" },
  MAX_TRADES_PER_DAY: { type: "int", def: 8, min: 1, max: 100, desc: "Max entries per day" },
  RISK_DAY_TIMEZONE: { type: "string", def: "Europe/Paris", desc: "Time zone for the daily risk reset" },

  // --- cadence ---
  RADAR_INTERVAL_MS: { type: "int", def: 5000, min: 2000, max: 120000, desc: "Broad ticker radar" },
  POSITION_INTERVAL_MS: { type: "int", def: 2000, min: 1000, max: 60000, desc: "Open-position price check" },
  CANDLE_REFRESH_MS: { type: "int", def: 60000, min: 15000, max: 600000, desc: "Round-robin candle refresh per reference pair" },
  RECONCILE_INTERVAL_MS: { type: "int", def: 60000, min: 15000, max: 3600000, desc: "Balance/order reconciliation" },
  HISTORY_SYNC_INTERVAL_MS: { type: "int", def: 300000, min: 60000, max: 86400000, desc: "Historical order sync" },

  // --- notifications / monitoring ---
  DISCORD_WEBHOOK_URL: { type: "string", def: "", secret: true, desc: "Discord webhook (secret)" },
  DISCORD_CANDIDATE_MIN_SCORE: { type: "num", def: 70, min: 0, max: 100, desc: "Only announce candidates at/above this score" },
  DISCORD_CANDIDATE_COOLDOWN_MIN: { type: "int", def: 30, min: 0, max: 1440, desc: "Per-symbol cooldown for candidate alerts" },
  DAILY_SUMMARY_HOUR: { type: "int", def: 21, min: 0, max: 23, desc: "Local hour for daily summary" },
  HEALTH_PORT: { type: "int", def: 8787, min: 0, max: 65535, desc: "Local status server (127.0.0.1 only). 0 disables." },
  LOG_LEVEL: { type: "enum", enum: ["debug", "info", "warn", "error"], def: "info", desc: "Log verbosity" },
  DATA_DIR: { type: "string", def: "data", desc: "State directory" },
  LOG_DIR: { type: "string", def: "logs", desc: "Log directory" }
};

export const LIVE_CONFIRMATION_PHRASE = "I_ACCEPT_REAL_MONEY_RISK";
export const HARD_MAX_BUDGET = 10;

function parsePlan(s, name, errors) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(String(s));
  if (!m) { errors.push(`${name} must look like "2:1"`); return null; }
  const target = Number(m[1]);
  const floor = Number(m[2]);
  if (!(target > 1) || !(floor >= 1) || floor >= target) { errors.push(`${name}: need target > floor >= 1`); return null; }
  return { targetMultiple: target, floorMultiple: floor, name: `X${target}->X${floor}` };
}

export function loadEnvFile(file) {
  const envFile = file || process.env.HZN_ENV_FILE || path.join(PROJECT_ROOT, ".env");
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
    return envFile;
  }
  return null;
}

/** Build a frozen config object from an env map. Throws with every problem listed. */
export function buildConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const cfg = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    const raw = env[name];
    const present = raw !== undefined && String(raw).trim() !== "";
    let value = spec.def;
    if (present) {
      const s = String(raw).trim();
      switch (spec.type) {
        case "int":
        case "num": {
          const n = Number(s);
          if (!Number.isFinite(n) || (spec.type === "int" && !Number.isInteger(n))) errors.push(`${name} must be a ${spec.type === "int" ? "integer" : "number"}`);
          else value = n;
          break;
        }
        case "bool": value = bool(s); break;
        case "enum":
          if (!spec.enum.includes(s)) errors.push(`${name} must be one of ${spec.enum.join(", ")}`);
          else value = s;
          break;
        case "list": value = s.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean); break;
        case "list-num": {
          const arr = s.split(",").map((x) => Number(x.trim()));
          if (arr.some((n) => !Number.isFinite(n) || n <= 0)) errors.push(`${name} must be a comma list of positive numbers`);
          else value = arr;
          break;
        }
        default: value = s;
      }
    }
    if ((spec.type === "int" || spec.type === "num") && Number.isFinite(value)) {
      if (spec.min !== undefined && value < spec.min) errors.push(`${name}=${value} below minimum ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) errors.push(`${name}=${value} above maximum ${spec.max}`);
    }
    cfg[name] = value;
  }

  // Cross-field validation
  cfg.plans = [1, 2, 3].map((i) => parsePlan(cfg[`PLAN_SLOT${i}`], `PLAN_SLOT${i}`, errors));
  if (cfg.SLOT_ALLOCATIONS.length < cfg.MAX_OPEN_POSITIONS) errors.push("SLOT_ALLOCATIONS must have at least MAX_OPEN_POSITIONS entries");
  const slotSum = cfg.SLOT_ALLOCATIONS.slice(0, cfg.MAX_OPEN_POSITIONS).reduce((a, b) => a + b, 0);
  if (slotSum > cfg.MAX_TRADING_BUDGET_QUOTE + 1e-9) errors.push(`Sum of slot allocations (${slotSum}) exceeds MAX_TRADING_BUDGET_QUOTE (${cfg.MAX_TRADING_BUDGET_QUOTE})`);
  if (cfg.MAX_TRADING_BUDGET_QUOTE > HARD_MAX_BUDGET) errors.push(`MAX_TRADING_BUDGET_QUOTE is hard-capped at ${HARD_MAX_BUDGET}`);

  cfg.credentialsPresent = Boolean(cfg.REVOLUT_API_KEY && cfg.REVOLUT_PRIVATE_KEY_PATH);
  if (cfg.REVOLUT_API_KEY && !/^[A-Za-z0-9]{32,128}$/.test(cfg.REVOLUT_API_KEY)) warnings.push("REVOLUT_API_KEY does not look like a 64-char alphanumeric key");
  if (cfg.REVOLUT_PRIVATE_KEY_PATH) {
    const keyPath = path.resolve(cfg.REVOLUT_PRIVATE_KEY_PATH);
    if (!fs.existsSync(keyPath)) errors.push("REVOLUT_PRIVATE_KEY_PATH does not exist");
    if (keyPath.toLowerCase().startsWith(PROJECT_ROOT.toLowerCase())) warnings.push("Private key is inside the project folder; move it outside the repository");
  }
  if (cfg.DISCORD_WEBHOOK_URL && !/^https:\/\/(discord(app)?\.com)\/api\/webhooks\//.test(cfg.DISCORD_WEBHOOK_URL)) errors.push("DISCORD_WEBHOOK_URL is not a Discord webhook URL");

  if (cfg.BOT_MODE === "live") {
    if (!cfg.credentialsPresent) errors.push("Live mode requires REVOLUT_API_KEY and REVOLUT_PRIVATE_KEY_PATH");
    if (cfg.LIVE_TRADING_CONFIRMATION !== LIVE_CONFIRMATION_PHRASE) errors.push(`Live mode requires LIVE_TRADING_CONFIRMATION=${LIVE_CONFIRMATION_PHRASE}`);
  }

  for (const k of Object.keys(env)) {
    if ((k.startsWith("REVOLUT_") || k.startsWith("HZN_")) && !SPEC[k] && k !== "HZN_ENV_FILE") warnings.push(`Unknown setting ${k} ignored`);
  }
  for (const legacy of ["MAX_TRADE_QUOTE", "TAKE_PROFIT_PCT", "TRAILING_ACTIVATION_PCT", "TRAILING_STOP_PCT", "SCAN_INTERVAL_MS", "MAX_PRELIMINARY_CANDIDATES"]) {
    if (env[legacy] !== undefined) warnings.push(`Legacy setting ${legacy} is no longer used`);
  }

  if (errors.length) {
    const err = new Error("Invalid configuration:\n - " + errors.join("\n - "));
    err.configErrors = errors;
    throw err;
  }
  cfg.warnings = warnings;
  cfg.dataDir = path.resolve(PROJECT_ROOT, cfg.DATA_DIR);
  cfg.logDir = path.resolve(PROJECT_ROOT, cfg.LOG_DIR);
  return Object.freeze(cfg);
}

/** A printable, secret-free view of the config. */
export function publicConfig(cfg) {
  const out = {};
  for (const [name, spec] of Object.entries(SPEC)) {
    if (spec.secret) out[name] = cfg[name] ? "<set>" : "<empty>";
    else if (name === "REVOLUT_PRIVATE_KEY_PATH") out[name] = cfg[name] ? "<set>" : "<empty>";
    else out[name] = cfg[name];
  }
  out.plans = cfg.plans.map((p) => p.name);
  return out;
}
