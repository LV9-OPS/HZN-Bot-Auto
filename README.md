# HZN Bot Auto v3

Early-momentum crypto trading bot for the **Revolut X** exchange API, rebuilt from scratch (October 2026).
**Paper mode is the default.** Live trading needs an explicit, documented activation step
([docs/GO_LIVE_CHECKLIST.md](docs/GO_LIVE_CHECKLIST.md)).

> No profit is promised. On the 7-day replay run during the rebuild (8–15 Oct 2026), the signal did **not**
> beat costs, so the go/no-go is **NO-GO for live** (see [docs/TEST_REPORT.md](docs/TEST_REPORT.md)).

## What it does

1. **Radar (every ~5 s):** one ticker request for the whole market. It filters the active `*-USDC` pairs on spread and liquidity, then
   tracks 1/3/5-minute changes from in-memory snapshots.
2. **Early-movement analysis:** 1-minute candles of each coin's **most liquid reference market** (USD/EUR).
   Revolut X USDC books are thin, so their own candles are mostly empty. Radar-flagged coins are analysed first, and
   every other coin is still refreshed round-robin.
3. **Explainable ranking:** a 0–100 score built from momentum, acceleration, relative volume, breakout, trend, calm base,
   cost and an extension penalty. Every rejection has a named reason (`already_extended`, `false_breakout`, …).
4. **Entry confirmation on fresh data:** checks signal age, chase, spread, order-book depth, round-trip cost vs. stop distance and exchange minimums,
   and confirms the exit can be placed. Orders are IOC limit orders, so nothing is left resting.
5. **Capital:** hard cap of 10 USDC. Slots get 5 / 3 / 2 USDC, with at most 3 positions and one per coin.
6. **Exits (exactly as specified):** slot 1 = reach **2× entry**, then the floor arms at 1×. Slots 2 and 3 = reach **3× entry**, then the floor arms at 2×.
   Before the target, a **−3 % stop-loss on the bid** applies.
7. **Reconciliation** with the exchange runs at startup and every minute, using a durable order registry and fail-closed state.
8. **Discord** messages are in French and always say whether an order was *submitted* or *filled*.

## Critical limitation: no exchange-native stop-loss

The Revolut X API (`POST /1.0/orders`) only accepts `limit` and `market` orders. Conditional and TP/SL orders exist in
the Revolut X app and the API can *read* and *cancel* them, but the API **cannot create** them. All stop-loss and floor exits
are therefore **software-monitored**. **If the PC sleeps, the bot crashes or the network is down, nothing protects the
positions.** The bot detects TP/SL orders you create manually in the app and shows them as extra protection.

## Quick start (Windows, PowerShell)

```powershell
cd C:\Users\insan\HZN-Bot-Auto
npm test                      # 85 automated tests
npm run reconcile             # READ-ONLY view of your real account vs. local state
npm start                     # paper mode in this window (Ctrl+C to stop)
# or supervised (auto-restart after crashes):
powershell -ExecutionPolicy Bypass -File scripts\run-bot.ps1
npm run status                # positions, PnL, entry gate, scanner top, API usage
# dashboard: http://127.0.0.1:8787/
npm run stop                  # graceful stop
```

## Commands

| Command | Purpose |
|---|---|
| `npm start` | Run the bot (mode from `.env`, paper by default) |
| `npm run status [-- --mode live]` | Print the latest status snapshot |
| `npm run stop` | Graceful stop (the supervisor will not restart it) |
| `npm run emergency-on` / `emergency-off` | Block / allow new entries (positions stay managed) |
| `npm run reconcile` | Read-only reconciliation dry run against the real account |
| `npm run account` | Read-only balances (valued) and filled-order history |
| `npm run adopt -- XRP-USDC [--entry P] --yes` | Hand an existing holding to the bot |
| `npm run resolve -- XRP-USDC --closed --yes` | Mark a stuck position as closed outside the bot |
| `npm run fetch-history -- --days 7` | Download 1-minute history for replay |
| `npm run replay` | Look-ahead-free replay with fees, spread and slippage |
| `npm test` / `npm run check` | Tests / syntax check |

## Documentation

- [Installation on Windows](docs/INSTALL_WINDOWS.md)
- [Configuration reference](docs/CONFIGURATION.md)
- [Strategy](docs/STRATEGY.md)
- [Risk management](docs/RISK.md)
- [Discord notifications](docs/DISCORD.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [Deployment and recovery](docs/DEPLOYMENT_RECOVERY.md)
- [Go-live checklist](docs/GO_LIVE_CHECKLIST.md)
- [Audit of v0.2 and design](docs/AUDIT_AND_DESIGN.md)
- [Revolut X API notes and limits](docs/API_NOTES.md)
- [Test report](docs/TEST_REPORT.md)
- [Changelog](CHANGELOG.md)

## Architecture

```
src/api/            Revolut X client (Ed25519 signing), central request scheduler, strict payload normalization
src/market/         market-data cache, multi-stage scanner (radar + deep analysis)
src/signals/        early-movement features (closed candles only) and explainable scoring
src/strategy/       X2/X3 profit plans + stop-loss (pure), stage-D entry confirmation
src/risk/           budget, slots, daily limits, cooldowns, entry gate
src/execution/      order lifecycle (idempotent, recovery by client_order_id), live + paper exchanges
src/reconciliation/ exchange <-> local state reconciliation and recovery
src/storage/        atomic state store with backups and schema validation, durable order registry
src/notifications/  Discord (queued, deduplicated, redacted)
src/monitoring/     logger with rotation and redaction, status server, instance lock, metrics
src/cli/            status, stop, reconcile, adopt, resolve
tools/              fetch-history, replay, account report, syntax check
tests/              unit + integration + end-to-end paper tests (node:test, no dependencies)
```

The bot has no runtime dependencies. It needs Node.js ≥ 20.12 (tested on Node 24.21 on Windows and Node 22 on Linux).
