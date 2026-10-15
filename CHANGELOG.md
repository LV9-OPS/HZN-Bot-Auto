# Changelog

## 3.0.0 — 2026-10-15 (branch `rebuild/v3`)
Complete rebuild. v0.2 is preserved on `main` and `legacy/pre-v3-snapshot`, with a file copy in `backups/pre-v3-*`.

### Added
- Multi-stage scanner: one-request ticker radar, early-movement analysis on the most liquid reference market (USD/EUR),
  explainable 0–100 scoring with named rejection reasons, and stage-D confirmation on fresh data (staleness, chase, spread, depth, costs, minimums, exit placeability).
- Exact X2→X1 / X3→X2 / X3→X2 profit plans with a persisted armed floor, and a −3 % bid-based stop before the target.
- Capital manager: hard 10 USDC cap, 5/3/2 slots, daily loss and trade limits, per-symbol cooldown, emergency stop.
- Order manager: durable `client_order_id` registry written before sending, IOC entries and exits, lookup-before-retry for uncertain outcomes,
  partial fills, real fill prices and fees, no overselling, a single in-flight exit, market fallback for exits.
- Reconciliation engine: balances, active and historical orders, legacy migration with exchange verification, recovery of missing positions from the
  bot's own fills, unmanaged-holding and dust detection, orphan handling, discrepancies that block entries.
- Fail-closed state store: atomic writes, schema v3 validation, 30 rotating backups, quarantine of corrupt files, separate paper and live files.
- Central request scheduler with per-endpoint token buckets and priorities, 429 `Retry-After` (ms) handling, bounded GET retries, adaptive radar cadence.
- Paper exchange that runs the same code paths against live market data.
- Discord notifier (French): queue, deduplication, cooldowns, redaction, submitted vs. filled distinction, daily summary.
- Monitoring: rotating JSON logs with redaction, local status dashboard (127.0.0.1), `npm run status`, single-instance lock,
  graceful shutdown, Windows supervisor and autostart scripts.
- CLIs: `reconcile` (read-only dry run), `account`, `adopt`, `resolve`, `stop`, `emergency-on/off`, `fetch-history`, `replay`.
- 85 automated tests (unit, integration, end-to-end paper). No runtime dependencies (dotenv removed in favour of `process.loadEnvFile`).

### Removed
- `src/revolut.js`, `scanner.js`, `strategy.js`, `risk.js`, `state.js`, `discord.js` and `health.js` (v0.2), the `cancelAllOrders` client method,
  the take-profit/trailing settings, and the health server on `0.0.0.0`.

### Changed
- Default `BOT_MODE=paper`. Your `.env` was switched from `live` to `paper`. Live mode needs `LIVE_TRADING_CONFIRMATION`.
