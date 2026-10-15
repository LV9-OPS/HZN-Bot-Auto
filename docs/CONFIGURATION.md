# Configuration reference

All settings are environment variables, read from `.env` in the project folder or from the file named by `HZN_ENV_FILE` (recommended: keep it in `C:\Users\insan\HZN-Secrets\`). Every value is validated at startup; an invalid value stops the bot with exit code 2 and a list of problems.

Hard limits enforced in code: total budget ≤ 10 USDC, slot allocations must sum to ≤ the budget, max 3 positions. Live mode requires `BOT_MODE=live` **and** `LIVE_TRADING_CONFIRMATION=I_ACCEPT_REAL_MONEY_RISK`.

Secrets (never printed, never sent to Discord): `REVOLUT_API_KEY`, `DISCORD_WEBHOOK_URL`, the private key file.

| Variable | Type | Default | Range | Purpose |
|---|---|---|---|---|
| `BOT_MODE` | enum | paper | paper / live | paper = simulated orders on live market data; live = real orders |
| `LIVE_TRADING_CONFIRMATION` | string | (empty) |  | Must equal I_ACCEPT_REAL_MONEY_RISK for live mode |
| `EMERGENCY_STOP` | bool | false |  | Block all new entries (positions keep being managed) |
| `REVOLUT_API_KEY` | string (secret) | (empty) |  | 64-char API key |
| `REVOLUT_PRIVATE_KEY_PATH` | string | (empty) |  | Path to Ed25519 private key PEM (outside the repo) |
| `REVOLUT_REGION` | enum | EEA | EEA / UK / US / GLOBAL | Region for public endpoints |
| `REVOLUT_BASE_URL` | string | https://revx.revolut.com/api |  | API base URL |
| `HTTP_TIMEOUT_MS` | int | 10000 | 2000 – 60000 | Per request timeout |
| `API_PUBLIC_PER_SEC` | num | 0.8 | 0.1 – 1 | Public endpoint rate (doc limit 1/s) |
| `API_AUTH_PER_MIN` | int | 400 | 30 – 900 | Authenticated read budget per minute (doc limit 1000) |
| `API_ORDERS_PER_DAY` | int | 600 | 10 – 950 | Order placement budget per day (doc limit 1000) |
| `MAX_TRADING_BUDGET_QUOTE` | num | 10 | 1 – 10 | Hard cap on capital deployed (USDC). Hard-limited to 10 by code. |
| `SLOT_ALLOCATIONS` | list-num | 5,3,2 |  | Per-slot allocation in USDC, slot 1..3 |
| `MAX_OPEN_POSITIONS` | int | 3 | 1 – 3 | Simultaneous positions |
| `QUOTE_CURRENCY` | enum | USDC | USDC | Quote currency traded |
| `MIN_POSITION_QUOTE` | num | 1 | 0.1 – 10 | Below this an allocation is not worth trading |
| `DUST_THRESHOLD_QUOTE` | num | 0.5 | 0 – 5 | Holdings worth less are dust |
| `PAPER_START_QUOTE` | num | 10 | 1 – 100000 | Paper account starting USDC |
| `STOP_LOSS_PCT` | num | 3 | 0.5 – 50 | Initial stop below entry, checked on bid, active until target reached |
| `PLAN_SLOT1` | string | 2:1 |  | target:floor multiples for slot 1 (X2 then floor X1) |
| `PLAN_SLOT2` | string | 3:2 |  | slot 2 (X3 then floor X2) |
| `PLAN_SLOT3` | string | 3:2 |  | slot 3 (X3 then floor X2) |
| `ENTRY_MODE` | enum | momentum | momentum / dip / quant | momentum = early 1m breakout; dip = buy a sharp 15m drop; quant = 1h regime-aware decision engine (trend/breakout/pullback) |
| `QUANT_STRATEGIES` | list | TREND,BREAKOUT,PULLBACK |  | quant: candidate strategies (trend, breakout, pullback) |
| `QUANT_REQUIRE_VALIDATION` | bool | true |  | quant: only strategies validated out-of-sample (data/strategy-validation.json) may trade |
| `QUANT_CYCLE_MS` | int | 900000 | 60000 – 3600000 | quant: decision cycle (15 min) |
| `RISK_PER_TRADE_PCT` | num | 1 | 0.1 – 5 | quant: planned max loss per trade (stop + costs) as % of equity |
| `MAX_CORRELATION` | num | 0.8 | 0 – 1 | quant: reject a position whose 30-day 1h return correlation with an open one exceeds this |
| `DIP_MIN_DROP_15M_PCT` | num | 2 | 0.5 – 20 | dip: minimum 15-minute drop |
| `EXIT_MODE` | enum | plan | plan / scalp | plan = X2/X3 profit plans; scalp = small take-profit, trailing stop, max holding time |
| `SCALP_TAKE_PROFIT_PCT` | num | 1.5 | 0 – 50 | scalp: sell when bid >= entry +X% (0 = off) |
| `SCALP_TRAIL_ACTIVATION_PCT` | num | 0 | 0 – 50 | scalp: arm a trailing stop once bid >= entry +X% (0 = off) |
| `SCALP_TRAIL_DISTANCE_PCT` | num | 0.5 | 0.05 – 20 | scalp: trailing stop distance below the highest bid |
| `SCALP_MAX_HOLD_MIN` | int | 0 | 0 – 100000 | scalp: exit after this many minutes (0 = off) |
| `EXIT_LIMIT_SLIPPAGE_PCT` | num | 0.5 | 0.05 – 5 | IOC sell limit placed this far below bid |
| `EXIT_MAX_IOC_ATTEMPTS` | int | 3 | 1 – 10 | IOC attempts before market fallback (stop/emergency only) |
| `EXIT_MARKET_FALLBACK` | bool | true |  | Use a market sell when IOC attempts fail for stop-loss/emergency exits |
| `PRICE_MAX_AGE_MS` | int | 15000 | 2000 – 120000 | A bid older than this is not used for exit decisions |
| `PRICE_ANOMALY_PCT` | num | 15 | 2 – 90 | Jumps larger than this need a second confirming tick |
| `EMERGENCY_EXIT_ON_DELIST` | bool | true |  | Exit if a held pair becomes inactive and a reliable bid exists |
| `EMERGENCY_DATA_OUTAGE_MS` | int | 120000 | 10000 – 3600000 | Alert when no reliable price for this long |
| `ENTRY_LIMIT_SLIPPAGE_PCT` | num | 0.15 | 0 – 2 | IOC buy limit this far above ask |
| `SIGNAL_MAX_AGE_MS` | int | 20000 | 2000 – 300000 | Signal older than this is stale |
| `MAX_CHASE_PCT` | num | 0.5 | 0 – 5 | Reject if ask moved more than this since signal |
| `MAX_SPREAD_PCT` | num | 0.4 | 0.01 – 5 | Max bid/ask spread on the USDC pair |
| `MIN_EXEC_QUOTE_VOLUME_24H` | num | 5000 | 0 – 1000000000 | Min 24h USDC volume on execution pair |
| `MIN_REF_QUOTE_VOLUME_24H` | num | 100000 | 0 – 10000000000 | Min 24h volume on the signal reference pair |
| `TAKER_FEE_PCT` | num | 0.09 | 0 – 2 | Revolut X taker fee (published 0.09%) |
| `EST_SLIPPAGE_PCT` | num | 0.05 | 0 – 2 | Expected slippage per side |
| `MAX_COST_TO_STOP_RATIO` | num | 0.35 | 0.05 – 1 | Round-trip cost must be below this fraction of the stop distance |
| `MIN_SCORE` | num | 62 | 0 – 100 | Minimum candidate score to consider an entry |
| `SYMBOL_COOLDOWN_MIN` | int | 60 | 0 – 10080 | No re-entry on a symbol after an exit for this long |
| `SIGNAL_REFERENCE_QUOTES` | list | USD,EUR,USDC |  | Quotes considered as momentum reference market (most liquid wins) |
| `MAX_DAILY_LOSS_QUOTE` | num | 1.5 | 0.1 – 10 | Realized net loss that blocks new entries for the day |
| `MAX_TRADES_PER_DAY` | int | 8 | 1 – 100 | Max entries per day |
| `MONTHLY_LOSS_PCT` | num | 3 | 0.5 – 50 | Realized net loss this month (% of month-start equity) that blocks new entries until next month |
| `MONTHLY_LIMIT_ACTION` | enum | flatten | flatten / block | On the monthly loss limit: flatten = sell all bot positions and block entries until next month; block = block entries only |
| `MAX_DRAWDOWN_PCT` | num | 10 | 1 – 90 | Realized drawdown from peak (vs budget) that halts entries until manual reset (npm run risk-reset) |
| `LOSS_STREAK_PAUSE` | int | 3 | 0 – 50 | Consecutive losing trades that pause entries (0 = off) |
| `LOSS_STREAK_PAUSE_HOURS` | int | 24 | 1 – 720 | Pause length after a losing streak |
| `RISK_DAY_TIMEZONE` | string | Europe/Paris |  | Time zone for the daily risk reset |
| `RADAR_INTERVAL_MS` | int | 5000 | 2000 – 120000 | Broad ticker radar |
| `POSITION_INTERVAL_MS` | int | 2000 | 1000 – 60000 | Open-position price check |
| `CANDLE_REFRESH_MS` | int | 60000 | 15000 – 600000 | Round-robin candle refresh per reference pair |
| `RECONCILE_INTERVAL_MS` | int | 60000 | 15000 – 3600000 | Balance/order reconciliation |
| `HISTORY_SYNC_INTERVAL_MS` | int | 300000 | 60000 – 86400000 | Historical order sync |
| `DISCORD_WEBHOOK_URL` | string (secret) | (empty) |  | Discord webhook (secret) |
| `DISCORD_CANDIDATE_MIN_SCORE` | num | 70 | 0 – 100 | Only announce candidates at/above this score |
| `DISCORD_CANDIDATE_COOLDOWN_MIN` | int | 30 | 0 – 1440 | Per-symbol cooldown for candidate alerts |
| `DAILY_SUMMARY_HOUR` | int | 21 | 0 – 23 | Local hour for daily summary |
| `HEALTH_PORT` | int | 8787 | 0 – 65535 | Local status server (127.0.0.1 only). 0 disables. |
| `LOG_LEVEL` | enum | info | debug / info / warn / error | Log verbosity |
| `DATA_DIR` | string | data |  | State directory |
| `LOG_DIR` | string | logs |  | Log directory |

Legacy v0.2 settings (`MAX_TRADE_QUOTE`, `TAKE_PROFIT_PCT`, `TRAILING_*`, `SCAN_INTERVAL_MS`, `MAX_PRELIMINARY_CANDIDATES`) are ignored with a warning.
