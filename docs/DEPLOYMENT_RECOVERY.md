# Deployment and recovery

## Files
| Path | Content | Safe to delete? |
|---|---|---|
| `data/state.<mode>.json` | positions, PnL, discrepancies (schema v3) | **No** |
| `data/backups/state.<mode>.*.json` | last 30 snapshots (on every position change + hourly) | Old ones only |
| `data/orders.<mode>.jsonl` | durable registry of every `client_order_id` the bot sent. It proves which holdings the bot owns. | **No** |
| `data/events.<mode>.jsonl` | append-only trade events | Yes (audit only) |
| `data/status.<mode>.json` | latest status snapshot | Yes |
| `data/bot.<mode>.lock` | single-instance lock | Only if no bot is running |
| `data/state.json` | legacy v0.2 state (imported once into live state) | Keep as a record |
| `data/EMERGENCY_STOP` | presence blocks entries | Yes, to re-enable entries |

## Start / stop
- Start: `scripts\run-bot.ps1` (supervised) or `npm start`.
- Stop: `npm run stop` (graceful: finishes in-flight tasks and saves state). Ctrl+C also works. The supervisor stops on exit code 0.
- Crash: the supervisor restarts with back-off from 5 s to 5 min. On every start the bot loads state (fail-closed), re-runs a **full
  reconciliation**, and allows entries only if it succeeds.

## Restart guarantees
- Positions, `targetReached` (armed floor), in-flight orders and pending exits survive restarts. This was verified by tests and by a real
  kill/restart during the paper run (the LINK position was recovered).
- An order sent just before a crash is found by its `client_order_id` and is never re-sent.
- A sell that filled while the bot was down is booked from the exchange history.

## Backups and rollback
- Before v3: `backups\pre-v3-<timestamp>\` holds a copy of the old `src`, `data` and config. The branch `legacy/pre-v3-snapshot` holds the old
  uncommitted changes. `main` is untouched.
- Roll back: `npm run stop`, then `git checkout main` (or `legacy/pre-v3-snapshot`). v3 data files use new names and do not conflict.
- Restore a state snapshot: stop the bot, copy `data\backups\state.live.<ts>.json` to `data\state.live.json`, then `npm run reconcile`, then start.

## Publishing to GitHub
The rebuild was committed locally on branch `rebuild/v3` and **not pushed**. When satisfied:
`git push -u origin rebuild/v3`, then open a pull request into `main`. Check that the remote is the right one (`LV8-OPS` vs `LV9-OPS`).
