# Strategy

## Entry: detect the start of a move

**Signal market.** For each active `BASE-USDC` pair, the bot reads momentum from the most liquid of `BASE-USD`, `BASE-EUR`
and `BASE-USDC`, ranked by 24-hour quote volume. Orders always execute on `BASE-USDC`. Signals use only **closed** 1-minute candles,
and missing minutes are filled as flat zero-volume candles, so a window of N minutes always means N minutes of clock time.

**Features** (`src/signals/earlyMomentum.js`):

| Feature | Definition |
|---|---|
| ret1/3/5/15/60 | % change over the last 1/3/5/15/60 minutes |
| accel3 | (last 3 min %/min) − (previous 3 min %/min) |
| relVol5 | mean volume of the last 5 min ÷ mean of minutes t-65…t-6 (the baseline excludes the burst) |
| volAccel | last 3 min volume ÷ previous 3 min |
| baseRangePct | high–low range of minutes t-35…t-6, i.e. how calm the market was before the move |
| breakout | close above the highest high of the previous 30 min, with the close in the upper half of the bar |
| wickRejection | the bar poked above the prior high but closed back below it (false breakout) |
| fading | more than 50 % of the 5-minute burst given back (reversal) |
| ema9/ema21 | gap and slope (trend) |
| extension | ret60, % above the 30-minute low, % above EMA21 |

**Hard gates** (each rejection is logged with its reason): `spread_too_wide`, `illiquid_exec_pair`, `inactive_market`,
`no_momentum` (5m < 0.25 %), `burst_too_large` (5m > 3 %), `last_minute_down`, `no_volume_expansion` (relVol5 < 1.5),
`already_extended` (60m > 6 % or > 5 % above the 30-minute low), `overstretched` (> 3 % above EMA21), `no_base` (prior range > 4 %),
`false_breakout`, `reversal`, `no_trend`. There is **no minimum** on the 15m/60m change, so an early move is not rejected
for being early.

**Score (0–100):** momentum 20, acceleration 15, relative volume 20, volume acceleration 5, breakout 15, trend 10, calm base 5,
cost or spread 10, and an extension penalty of up to −15. The minimum score is `MIN_SCORE` (62). Thresholds are configurable parameters that you can test
with `npm run replay`.

**Stage D (just before the order):** the signal is ≤ 20 s old, the ask has moved ≤ 0.5 % since the signal, the spread is ≤ 0.4 %, round-trip cost
(2 × 0.09 % fee + spread + 2 × 0.05 % slippage) is ≤ 0.35 × the stop distance, the order book covers the size within the limit price, the
exchange minimums are met, **and** the position would still meet the minimum notional at the stop price, so the exit can actually be placed.
The order is an **IOC limit buy** at ask + 0.15 %, sized so that notional plus fee is ≤ the slot allocation.

The scanner can and often does return zero candidates. Having cash never forces a trade.

## Exits (unchanged meaning of the request)

| Slot | Allocation | Target | After the target | Before the target |
|---|---|---|---|---|
| 1 | 5 USDC | bid ≥ **2 × entry** | exit when bid ≤ **1 × entry** | stop when bid ≤ entry × (1 − 3 %) |
| 2 | 3 USDC | bid ≥ **3 × entry** | exit when bid ≤ **2 × entry** | same stop |
| 3 | 2 USDC | bid ≥ **3 × entry** | exit when bid ≤ **2 × entry** | same stop |

- "X2" means **+100 %** and "X3" means **+200 %**, not +2 %/+3 %.
- Reaching the target does not sell. It arms the floor, and that flag is persisted to disk immediately so a restart cannot lose it.
- Entry price = the exchange-reported average fill price. All checks use the **current bid**, not a candle close.
- A bid that jumps more than 15 % from the last reliable bid needs a second confirming tick. With no fresh, valid bid, nothing is decided.
- Exit execution: an IOC limit sell at bid − 0.5 %, at most 3 attempts, then a market sell. The sell size never exceeds the exchange's available
  balance, and only one exit order can be in flight per position.

### What this exit plan means in practice

Liquid coins rarely double or triple. In the 7-day replay, every closed trade was a −3 % stop-loss. Positions that did not stop out
stayed open for days, holding the slot and the budget, with no profit-taking below 2×/3×. So the plan is effectively
"stop-loss or hold for a very large move". It is implemented as requested, and the thresholds are configurable (`PLAN_SLOT1..3`, `STOP_LOSS_PCT`).
If you want a different profit policy later, change it explicitly. The bot will not change it silently.

## Emergency policy
- **Pair becomes inactive (delisting):** exit at the reliable bid if one exists (`EMERGENCY_EXIT_ON_DELIST=true`). Otherwise hold and alert.
- **No reliable price for more than 2 minutes:** hold, never exit at an invented price, and send a critical Discord alert.
- **API errors or rate limiting:** new entries are blocked, positions stay monitored, and requests back off.
- **Global emergency stop:** `npm run emergency-on` or `EMERGENCY_STOP=true` blocks entries, and exits keep running.

## Paper fill model
Buy at ask × (1 + 0.05 %) if the limit allows it, sell at bid × (1 − 0.05 %), with a 0.09 % taker fee in USDC and IOC remainders cancelled.
