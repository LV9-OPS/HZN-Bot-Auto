# Risk management

## Capital
- **Hard cap: 10 USDC**, enforced in code (`HARD_MAX_BUDGET`) and in configuration validation. The slot allocations (5/3/2) must sum to ≤ the budget.
- Deployed capital = the cost basis (including entry fee) of held positions, plus the full allocation reserved for orders whose outcome is not yet known.
- Each allocation = min(slot target, remaining budget, 99.5 % of available USDC). Below `MIN_POSITION_QUOTE` (1 USDC) the bot does not trade.
- Funds outside the budget, and holdings the bot did not buy, are never used, sold or counted.
- No leverage, margin, borrowing or derivatives.

## Entry gate (all must pass)
| Check | Reason code |
|---|---|
| Emergency stop off (`EMERGENCY_STOP`, `data/EMERGENCY_STOP`) | `emergency_stop` |
| Last reconciliation succeeded | `not_reconciled` |
| No unresolved critical discrepancy | `critical_discrepancy` |
| No position in `needs_reconciliation` | `position_needs_reconciliation` |
| Daily realized net PnL > −`MAX_DAILY_LOSS_QUOTE` (day in Europe/Paris) | `daily_loss_limit` |
| Entries today < `MAX_TRADES_PER_DAY` | `daily_trade_limit` |
| Free slot and fewer than `MAX_OPEN_POSITIONS` positions | `max_positions`, `no_free_slot` |
| Remaining budget ≥ 1 USDC | `budget_exhausted` |
| API healthy (no 429 in the last 60 s, fewer than 3 consecutive failures) | `api_degraded` |
| Symbol not already held, not in its 60-minute cooldown after an exit | `already_held`, `cooldown` |

When the daily loss limit is hit, entries stop for the rest of the day. Open positions keep their stop-loss and floor monitoring.

## Performance accounting (net of fees)
Realized PnL = sell proceeds after fees − the proportional cost basis including the entry fee. Partial fills are handled per fill.
Tracked: realized, unrealized (at bid, after the exit fee), total fees, win rate, average win and loss, max drawdown of realized equity,
exposure per asset, daily realized PnL, entries per day, and rejection counts by reason. See `npm run status` and the dashboard.

## Known risks you keep
- **Software-only protection.** Sleep, a crash or a network loss stops the stop-loss. Use the supervisor, disable Windows sleep and keep the PC online.
  For extra safety you can add a stop-loss order manually in the Revolut X app. The bot detects it and never sells more than the available balance.
- **Gaps.** A stop is a trigger, not a guaranteed price. A fast drop can fill well below −3 %.
- **Thin USDC books.** Spreads of 0.2–1 % are common, so costs are significant relative to a 3 % stop.
- **Strategy edge is unproven.** See docs/TEST_REPORT.md.
