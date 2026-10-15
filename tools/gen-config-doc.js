// node tools/gen-config-doc.js > docs/CONFIGURATION.md
import { SPEC, LIVE_CONFIRMATION_PHRASE, HARD_MAX_BUDGET } from "../src/config/index.js";
const lines = ["# Configuration reference", "", "All settings are environment variables, read from `.env` in the project folder or from the file named by `HZN_ENV_FILE` (recommended: keep it in `C:\\Users\\insan\\HZN-Secrets\\`). Every value is validated at startup; an invalid value stops the bot with exit code 2 and a list of problems.", "", `Hard limits enforced in code: total budget ≤ ${HARD_MAX_BUDGET} USDC, slot allocations must sum to ≤ the budget, max 3 positions. Live mode requires \`BOT_MODE=live\` **and** \`LIVE_TRADING_CONFIRMATION=${LIVE_CONFIRMATION_PHRASE}\`.`, "", "Secrets (never printed, never sent to Discord): `REVOLUT_API_KEY`, `DISCORD_WEBHOOK_URL`, the private key file.", "", "| Variable | Type | Default | Range | Purpose |", "|---|---|---|---|---|"];
for (const [k, s] of Object.entries(SPEC)) {
  const def = Array.isArray(s.def) ? s.def.join(",") : s.def === "" ? "(empty)" : String(s.def);
  const range = s.enum ? s.enum.join(" / ") : s.min !== undefined ? `${s.min} – ${s.max}` : "";
  lines.push(`| \`${k}\` | ${s.type}${s.secret ? " (secret)" : ""} | ${def.replace(/\\/g, "\\\\")} | ${range} | ${s.desc} |`);
}
lines.push("", "Legacy v0.2 settings (`MAX_TRADE_QUOTE`, `TAKE_PROFIT_PCT`, `TRAILING_*`, `SCAN_INTERVAL_MS`, `MAX_PRELIMINARY_CANDIDATES`) are ignored with a warning.");
console.log(lines.join("\n"));
