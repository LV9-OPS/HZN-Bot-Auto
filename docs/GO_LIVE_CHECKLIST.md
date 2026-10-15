# Go-live checklist

Current recommendation: **NO-GO.** The replay showed no positive edge (see TEST_REPORT.md), and the account holds ~0.03 USDC.

Complete **every** item before live trading:

- [ ] `npm run check` and `npm test` pass (85/85) on this PC.
- [ ] Paper trading has run under the supervisor for **at least 7 days**, with no crash loops, no unexplained discrepancy, and a positive or acceptable
      net result after fees (`npm run status`, daily summaries).
- [ ] `npm run replay` on fresh history (`npm run fetch-history -- --days 14`) shows signal forward returns above costs.
- [ ] `npm run reconcile` shows `ok: true`, with no `needs_reconciliation` position. The legacy XRP record is resolved
      (`npm run resolve -- XRP-USDC --closed --yes` once you have confirmed where the XRP went).
- [ ] You understand that **stop-losses are software-only**: the PC must be on, awake and online, and the supervisor or autostart is installed.
      Optional: add a stop order manually in the Revolut X app for each live position.
- [ ] At least 10 USDC is available on Revolut X (spot USDC), and you accept losing it.
- [ ] The API key has no withdrawal permission. The private key is outside the repo. `.env` is not tracked (`git status` clean).
- [ ] Discord receives PAPER messages, including the daily summary.
- [ ] You reviewed the final `.env`: `MAX_TRADING_BUDGET_QUOTE=10`, `SLOT_ALLOCATIONS=5,3,2`, `STOP_LOSS_PCT=3`, plans `2:1 / 3:2 / 3:2`,
      `MAX_DAILY_LOSS_QUOTE`, `MAX_TRADES_PER_DAY`.

## Activation (explicit)
```powershell
npm run stop                                # stop the paper bot
# edit .env:
#   BOT_MODE=live
#   LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK
npm run reconcile                           # must report ok: true
powershell -ExecutionPolicy Bypass -File scripts\run-bot.ps1
npm run status -- --mode live               # check "LIVE", entries allowed, positions as expected
```
Without the exact phrase the bot refuses to start in live mode. To go back to paper: `npm run stop`, then set `BOT_MODE=paper`.
Paper and live use separate state files, so switching modes never mixes positions.
