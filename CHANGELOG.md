# Changelog

## 4.1.0 — 2026-10-16
### Added
- `QUOTE_CURRENCY` now accepts `EUR` and `USD` (Revolut X fiat books are 10–20× more liquid than USDC).
- `TRADE_ASSETS` whitelist (e.g. `BTC,ETH,SOL,XRP`).
- With a fiat quote, the execution pair itself is the signal reference.
- `npm run spreads`: read-only spread and volume sampler. Measured on 16 Oct 2026: BTC-EUR 0.012%, ETH-EUR 0.018%, SOL-EUR 0.048%, XRP-EUR 0.050% (USDC: 0.12–0.19%).
- Discord and log amounts use the configured quote currency.
- 116 tests.

### Research
- Walk-forward on BTC/ETH/SOL/XRP at 0.035% spread: combined OOS +35.5% over 82 months (DD 21.8%); `trend` on train-selected windows t=2.05, PF 1.34, mean +0.55%/trade. It still fails the 0.2% spread robustness rule, so it is not formally validated.

## 4.0.0 — 2026-10-16 (intelligence upgrade, branch `rebuild/v3`)
### Added
- `ENTRY_MODE=quant`: a 15-minute decision cycle on 1h bars with a 10-step, fully logged decision engine (`data/decisions.<mode>.jsonl`).
- Market-regime detection (trend, volatility percentile, liquidity stress, extreme moves, BTC market filter) with per-strategy permissions.
- Candidate strategies: `trend` (time-series momentum), `breakout` (Donchian with volume), `pullback` (oversold dip in an uptrend). All use ATR stops, trailing, time and signal exits.
- Risk engine: 1% risk per trade with ATR sizing within the 5/3/2 slots, a cost-vs-expected-move gate, a 30-day correlation guard and a volatility target.
- Portfolio policies: 3% monthly loss limit with flatten, 10% drawdown halt (`npm run risk-reset` after review), loss-streak pause.
- Strategy kill switch on persistent live degradation, with no in-production re-optimisation.
- Research stack: `npm run fetch-binance` (2017–2026 hourly data), `npm run research` (walk-forward, baselines, metrics per regime and strategy, parameter and cost sensitivity, deflation-style robustness gates). Writes `data/strategy-validation.json`; live trading requires validation.
- Explicit state names (ENTRY_PENDING, OPEN, EXIT_PENDING, RECONCILIATION_REQUIRED, ERROR_LOCKED, CLOSED), a per-position audit log, and realised slippage tracking.
- Scalp and dip modes (from 3.1) are kept as options.
- 111 automated tests.

### Result
- No strategy passed the robustness gates (see docs/RESEARCH_2016_2026.md), so live quant trading stays disabled by design. Paper mode can run the `trend` candidate to collect forward evidence.

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
