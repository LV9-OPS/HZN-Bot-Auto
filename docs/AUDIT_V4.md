# Audit v3 → v4 (Intelligence upgrade)

## 1. State before the upgrade (v3, branch `rebuild/v3`)
**Already correct and preserved:**
- Central rate limiting (token buckets, `Retry-After` in ms, no blind order retry).
- Idempotent `client_order_id` written to disk before sending, plus lookup on uncertain outcomes.
- Fail-closed state store, exchange reconciliation, no overselling, partial fills, fee-aware PnL.
- Discord distinguishes submitted from filled orders. Secrets are redacted. Paper mode works.

**Gaps against the new specification:**

| # | Gap | Fixed in v4 |
|---|---|---|
| 1 | No market-regime classification; strategies traded in any regime | `src/quant/regime.js` (trend, volatility, liquidity stress, extreme moves), with per-strategy regime permissions |
| 2 | Decisions were not logged as auditable records | `src/quant/decision.js` 10-step pipeline, written to `data/decisions.<mode>.jsonl` |
| 3 | Only 1-minute signals, which research shows are not exploitable at spot costs | 1h strategies (trend, breakout, pullback) on a 15-minute decision cycle |
| 4 | Backtests covered 7–21 days with no walk-forward, no baselines, no Sharpe/Sortino/profit factor, no per-regime results | `src/backtest/*` and `tools/research.js`: 2017–2026, walk-forward, baselines, full metrics, parameter and cost sensitivity |
| 5 | No monthly loss limit, no portfolio drawdown limit, no loss-streak pause, no correlation guard | `MONTHLY_LOSS_PCT=3` with flatten policy, `MAX_DRAWDOWN_PCT=10` halt with manual reset, loss-streak pause, 30-day correlation guard |
| 6 | Position sizing was fixed per slot (5/3/2), not risk-based | ATR stop + 1% risk per trade, capped by slots, budget, cash and a volatility target |
| 7 | No strategy kill switch | `src/quant/performance.js`: disables a strategy after persistent live degradation; no automatic re-optimisation |
| 8 | State names differed from the specification; no ERROR_LOCKED state | `STATE_NAMES` mapping (ENTRY_PENDING, OPEN, EXIT_PENDING, RECONCILIATION_REQUIRED, ERROR_LOCKED, CLOSED); `error_locked` after 3 rejected exits |
| 9 | No per-position audit trail or simulated-vs-real slippage tracking | `position.log[]`, `entry.slippagePct`, `exit.slippagePct` |
| 10 | Performance reporting was partly estimated | All metrics come from fills or are explicitly marked as estimates. Backtests are reproducible from saved data. |

## 2. Viability with 10 USDC (quantified)
| Item | Value |
|---|---|
| Taker fee | 0.09% per side (maker 0%) |
| Spread, Revolut X USDC (snapshot) | BTC 0.09–0.21%, ETH 0.13–0.21%, SOL 0.12–0.25%, others 0.4–1.2% |
| Round-trip cost (2 fees + spread + 2 × 0.05% slippage) | 0.37% (BTC) to 0.48% (0.2% spread). More than 1% on illiquid pairs. |
| Round trip on a 5 USDC position | ≈ 0.019–0.024 USDC |
| Monthly loss limit 3% of 10 USDC | 0.30 USDC, about 3 planned stop-losses at 1% risk, or about 13 round trips of costs alone |
| 5% monthly objective | 0.50 USDC per month. Measured out of sample: about +0.06 USDC per month on average, with a 27% drawdown. |
| Minimum order | `min_order_size_quote` 0.1 USDC on most pairs. The bot uses ≥ 1 USDC. |

**Consequences built into the bot:**
- The bot refuses any trade whose expected move (target, or 2× ATR) is below 3× the round-trip cost.
- It refuses pairs with a spread above 0.4%.
- It sizes so that a stop-out costs at most 1% of equity, including costs.
- The 3% monthly limit closes all positions (mark-to-market) and blocks entries until the next month.
- Hourly gaps can still cause a worse month: −6.2% was seen in the out-of-sample test.

## 3. Revolut X API facts relevant to v4
- Only `limit` and `market` orders can be created: no stop, OCO or conditional orders through the API. Stops are software-monitored on the bid every 2 seconds. A position is **never** reported as natively protected unless a native order created in the app is detected.
- Candles cover 1 minute to 4 weeks (up to 5,000 per authenticated request). History only starts at Revolut X's launch, so long-horizon research uses Binance public data as a price proxy.
- Rate limits are unchanged (1,000 authenticated reads per minute). The quant mode adds about 2 requests per minute.
