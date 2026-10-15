# Audit of v0.2 and the v3 design

## 1. Audit (v0.2, commit 8515e0d plus uncommitted local changes, preserved on branch `legacy/pre-v3-snapshot`)

| # | Defect | Where | Consequence |
|---|---|---|---|
| 1 | `loadState()` caught **every** read/parse error and returned an **empty state** | `src/state.js` | One corrupted or half-written file made the bot "forget" all positions. This is the most likely cause of the XRP desync. |
| 2 | Non-atomic `fs.writeFile` of the state, with no backup and no schema version | `src/state.js` | A crash during a write left a truncated JSON, which then triggered defect 1 |
| 3 | The live exit path **deleted a position** when the balance lookup returned 0, an unexpected shape or an empty array (`STALE POSITION CLEARED`) | `src/index.js` `checkPosition` | A malformed or empty API response erased a real position |
| 4 | No reconciliation: only a balance listing at startup; exchange holdings were never compared to local positions | `startupCheck` | Real holdings could exist with no local record (the XRP case) |
| 5 | Stop-loss was a software check followed by a **limit** sell at the bid | `checkPosition` | A limit order at the bid may not fill in a falling market, and nothing protected positions while the bot was down |
| 6 | Before selling, the bot cancelled `position.orderId` (the **entry** order id) | `checkPosition` | A pointless call that hid the real exit-order state |
| 7 | Entry and exit orders resting at the bid/ask, with `filled_quantity` from `partially_filled` treated as final | `syncPendingEntry/Exit` | Partial fills were booked as complete, and remaining quantities were not tracked |
| 8 | No idempotency: a timeout after placement led to an error and a later new order | `placeLimit` | Duplicate orders were possible |
| 9 | Scanner pre-ranked on **24-hour change and range position** and kept the top 30 before candle analysis | `src/scanner.js` | Biased towards coins that had *already* moved, and early movers were discarded before analysis |
| 10 | The scanner required `change15m ≥ 0.5 %` and `change60m ≥ 1 %` | `strategy.evaluate` | Moves were rejected precisely while they were early |
| 11 | Signals computed on the **USDC** pair's own 1-minute candles | `scanner.js` | On Revolut X EEA, about 75 % of USDC 1-minute candles have zero volume, so volume-acceleration metrics were noise |
| 12 | Public tickers requested without `region` return **duplicate symbols** (one per region) | `revolut.js` | Mixed or inconsistent prices and volumes |
| 13 | Rate limiting existed only for public calls; candles were requested in a serial loop for 30 pairs on every cycle, and 429s were swallowed silently | `revolut.js`, `scanner.js` | Inefficient polling and invisible rate-limit problems |
| 14 | The paper-entry log printed `quoteSize: maxTrade`, while the slot logic mixed `slot` with `positions.length + 1` | `openPosition` | Wrong slot or plan after a position closed |
| 15 | PnL = `quoteSize × pct`, with no fees, no real fill prices and no partial fills | several | Performance was misstated |
| 16 | Unhandled loop errors were only logged, and Discord errors were rate-limited but carried full API responses | `main` | Silent degradation, with possible leakage of API detail |
| 17 | The health server listened on `0.0.0.0` | `health.js` | Exposed on the LAN |
| 18 | `cancelAllOrders()` existed in the client | `revolut.js` | A risk of cancelling the user's own orders |

**Secrets:** `.env`, `private.pem` and webhooks were **never committed**. Git history was scanned for private keys,
webhook URLs and API keys, and nothing was found. The private key lives outside the repo (`C:\Users\insan\HZN-Secrets`).
Note: the git remote is `LV8-OPS/Bot-Auto`, not `LV9-OPS/Bot-Auto` as written in the brief.

**XRP findings (read-only check, 15 Oct 2026):** the exchange shows the XRP buy order filled on 2 Oct (6.45411 XRP @ 1.5494),
but the account now holds **0 XRP**, and no XRP sell appears in the exchange order history. The XRP left the account outside
exchange orders (for example a conversion in the Revolut app or a transfer). v3 imports the legacy XRP record as
`needs_reconciliation` and will not invent an exit. Run `npm run resolve -- XRP-USDC --closed --yes` once you confirm what happened.
The account currently holds ~0.03 USDC, plus ALICE (~6.9 USD) and RLC (~12.3 USD) that this bot did not buy. These are reported as
*unmanaged holdings* and never touched.

## 2. v3 design

### Data flow
```
         ┌────────────── RequestScheduler (token buckets per endpoint group, priorities) ──────────────┐
radar ──► GET /1.0/tickers (1 call, all pairs) ─► MarketData (tickers, snapshots, candle cache)
deep  ──► GET /1.0/candles/{REF} (incremental) ─► features ─► score + reasons ─► candidates
entry ──► RiskManager gate ─► GET balances / order-book ─► confirmEntry ─► OrderManager ─► POST /1.0/orders (IOC)
monitor ─► GET /1.0/tickers?symbols=held ─► evaluateExit (bid) ─► OrderManager exit (IOC → market fallback)
reconcile ─► balances + active + historical orders + order registry ─► Reconciler ─► state / discrepancies
```

### API request budget (authenticated, documented limit 1000/min for reads)
| Task | Cadence | Requests/min |
|---|---|---|
| Radar tickers (all pairs) | 5 s | 12 |
| Position prices | 2 s (only while positions exist) | 30 |
| Candles, round-robin, ~10 eligible pairs | 60 s each | ~10 (+ flagged refreshes ≤ 15 s) |
| Reconcile (balances + active orders) | 60 s | 2 |
| Historical orders | 5 min | ~0.2 × days in range |
| Entry confirmation | per entry | 3 |
| **Total** | | **~60–80 / min** against a configured budget of 400 and a documented limit of 1000 |

Without credentials, the bot falls back to public endpoints (1 req/s). The radar interval then adapts automatically and the
bot logs the reason. A 429 pauses the whole endpoint group for `Retry-After` ms and sends a Discord alert.

### Position state machine
`opening` → (`open` | `failed`) → `closing` ↔ `open` (partial exit) → `closed`. Any state can move to `needs_reconciliation` when
exchange facts disagree and cannot be explained. In that state entries are blocked, the position is never traded
automatically, and a price collapse is escalated to Discord.

### Recovery logic
- The order intent (`client_order_id`) is fsync'd to `data/orders.<mode>.jsonl` **before** sending.
- A timeout, 5xx, 409 or 429 on placement means the outcome is unknown. The bot looks the order up by `client_order_id` in active and
  historical orders, and never re-sends blindly. After 3 minutes and 3 lookups with no result, the order counts as not placed.
- The state file is written atomically (temp file, fsync, rename), validated against the schema, backed up (30 rotating copies) and quarantined if corrupt.
  The bot refuses to start if the state file and every backup are unreadable.
- On startup and every minute, the reconciler resolves in-flight orders, verifies legacy or flagged positions against their exchange
  orders, applies sells that filled while the bot was down, rebuilds missing positions **only** from the bot's own order
  registry (restoring `targetReached` from candles when needed), reports unmanaged holdings and dust, and cancels only the bot's own orphan buy orders.

### Requirements limited by the Revolut X API
| Requirement | Status |
|---|---|
| Exchange-native stop-loss / TP | **Not possible via API.** Only limit and market orders can be created. Software monitoring is used, and manual TP/SL orders from the app are detected. |
| Lookup by `client_order_id` | No direct endpoint. Implemented by scanning active and historical orders. |
| Fee currency | `total_fee`/`fee_currency` may be missing (seen on the real XRP order). Fees are then estimated at 0.09 % and flagged. |
| Price tick size | Not exposed in pair configuration. The price precision is inferred from published bid/ask decimals. |
| USDC liquidity | Thin. ~8 of 23 USDC pairs usually pass a 0.4 % spread limit. |
