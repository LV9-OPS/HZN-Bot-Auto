# Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Exit code 2 `Invalid configuration` | Read the listed problems (for example a missing live confirmation, a budget > 10 or a bad webhook). Fix `.env`. |
| Exit code 3 `Another HZN bot instance` | A bot for the same mode is running (`npm run status` shows the PID). Stop it with `npm run stop`. A lock left by a crashed process is cleaned automatically. |
| `Entries: BLOCKED not_reconciled` | Startup or periodic reconciliation failed (API down or auth). Check the logs, then `npm run reconcile`. |
| `position_needs_reconciliation` / `critical_discrepancy` | Exchange facts disagree with the local state. Run `npm run reconcile` to see what. If you sold the coin outside the bot: `npm run resolve -- SYMBOL --closed --yes`. If you hold it and want the bot to manage it: `npm run adopt -- SYMBOL --yes`. |
| "Avoir non géré" on Discord | A coin in your account was not bought by this bot. It is ignored. Use `npm run adopt` only if you want the bot to manage it. |
| `State file and all backups are invalid` | The bot refuses to start rather than forget positions. Inspect `data\state.<mode>.json.corrupt-*` and `data\backups\`. Restore a file manually, or move the bad files away, then **run `npm run reconcile`** before starting. |
| Auth failure (401/403) | Wrong key, wrong private key, clock skew (sync Windows time) or a revoked key. |
| Repeated `⏳` rate limit | Lower `API_AUTH_PER_MIN`, raise `RADAR_INTERVAL_MS`. The bot already adapts the radar cadence. |
| No trades for hours | Expected: most USDC pairs fail the spread or volume gates, and most moves fail the early-movement gates. The `npm run status` scanner top and the Discord daily summary show the rejection reasons. |
| `.env` values ignored / API key "not configured" | The file was saved with a BOM, or `HZN_ENV_FILE` points elsewhere. Re-save it as UTF-8 without BOM. |
| Dashboard not reachable | `HEALTH_PORT=0` disables it. The port may be in use, so change `HEALTH_PORT`. It only listens on 127.0.0.1. |
