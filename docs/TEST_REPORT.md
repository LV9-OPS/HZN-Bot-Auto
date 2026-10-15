# Test report — v3.0.0 (15 Oct 2026)

## 1. Static checks
`npm run check`: 54/54 files pass `node --check`.

## 2. Automated tests — 85/85 pass
Run on Linux (Node 22.22) and on the user's Windows PC (Node 24.21): `npm test`. All tests use mocked or simulated exchanges, and none touch the real account.

| Area | Tests (all ✔) |
|---|---|
| Early-movement detection | early move detected; small 15m/60m change does not reject; volume baseline excludes the burst; extended move rejected; false breakout rejected; reversal rejected; early mover ranked above climax burst; wide spread / illiquid rejected with reason; insufficient history; closed candles only (no look-ahead) and gap filling; zero candidates on a quiet market |
| Profit plan & stop | stop at −3 % on bid; X2 = 2× (not +2 %); X2→X1 retracement exit; X3→X2 exits; floor replaces the stop after the target; no decision without a reliable price |
| Stage D | fresh entry sized within allocation; stale signal; price ran away; spread widened; costs vs. stop; exchange minimums and exit placeability; thin book; inactive pair or missing quote |
| Precision | step flooring without float artefacts (e.g. 6.454119999 → "6.45411") |
| Risk | 10 USDC hard cap; 5/3/2 slots; allocation ≤ budget and balance; daily loss limit; daily trade limit and cooldown; no duplicate symbol; discrepancy, reconciliation and emergency gates; live confirmation required; fee-aware stats and drawdown |
| Order lifecycle | intent persisted before send, real fill price/qty/fee; IOC unfilled; rejection; **timeout after accept → found by client_order_id, no duplicate**; timeout before send → proven absent then failed; **HTTP 429 → verified, never re-sent**; partial entry fill; stop-loss exit with net PnL after fees; **duplicate exit prevention**; no overselling; IOC → market fallback; insufficient balance |
| Reconciliation | matching balances OK; **malformed/failing balances never delete a position**; balance below position → needs_reconciliation (after confirmation), entries blocked; sell filled while down is applied; **missing local position rebuilt from the bot's own fills**; foreign holdings never adopted; dust ignored; **legacy XRP verified from exchange order**; unverifiable legacy stays blocked; targetReached rebuilt from candles; orphan bot buy cancelled, foreign orders untouched; manual TP/SL detected; no concurrent runs |
| API layer | public 1 req/s and priorities; 429 pauses group; Ed25519 signature format verified; Retry-After (ms) retry and bounded retries; POST never retried; timeouts typed; only limit/market creatable; malformed payloads raise; multi-region duplicate tickers; secret redaction |
| Storage | restart keeps armed floor; corrupt file → backup; all corrupt → refuse to start; invalid state never written; interrupted write; legacy migration; torn journal line |
| Discord | submitted vs. filled wording and content; dedupe and cooldown; webhook never leaked |
| End-to-end paper | fake Revolut X HTTP API + real bot: early mover → stage D → IOC entry (slot 1, 5 USDC, X2→X1) → −4 % → stop-loss sell → restart keeps state; crash with armed floor → restart → reconcile → X2→X1 exit; second instance refused; scan cycles never overlap; exchange downtime → no invented-price exit and a critical alert |
| Replay | entry at next minute's open plus half spread and slippage; costs applied |

## 3. Read-only checks against the real account (15 Oct 2026)
- Authentication works (Ed25519 signature accepted).
- `npm run reconcile` (dry run): the legacy XRP entry order was found and **filled** (6.45411 @ 1.5494, 2 Oct), but the XRP balance is **0** and no
  sell exists in exchange order history. The bot reports `exchange balance below verified quantity` and blocks live entries. It does
  not invent an exit. **Action for you:** confirm where the XRP went, then `npm run resolve -- XRP-USDC --closed --yes`.
- Account content: ~0.03 USDC, ALICE ~6.9 USD, RLC ~12.3 USD and dust. ALICE and RLC were not bought through exchange orders in 30 days, so they are reported
  as unmanaged and never touched. **There is not enough USDC on Revolut X to trade live** (minimum 1 USDC per position, 10 for the full plan).

## 4. Historical replay (no look-ahead, fees 0.09 % per side, current spreads, 0.05 % slippage per side)
Data: 1-minute candles of the 23 reference markets, downloaded with `npm run fetch-history`.

| Window | Signals | Trades | Wins | Net PnL (USDC) | Max DD | Exits | Avg hold |
|---|---|---|---|---|---|---|---|
| 7 days (8–15 Oct) | 59 | 6 (+3 open) | 0 | **−0.70** | 0.70 | 6 × stop-loss | 3.2 days |
| 21 days (24 Sep–15 Oct) | 376 | 11 (+2 open) | 0 | **−1.22** | 1.22 | 11 × stop-loss | 4.2 days |

Signal quality, measured as forward return of the reference price after a qualified signal versus the unconditional baseline (21 days):

| Horizon | After signal (mean / % positive) | Baseline (mean / % positive) |
|---|---|---|
| 5 min | −0.062 % / 38.8 % | −0.001 % / 48.3 % |
| 15 min | −0.123 % / 39.7 % | −0.004 % / 49.2 % |
| 60 min | −0.087 % / 46.0 % | −0.016 % / 49.2 % |

Variants tested on 7 days (higher score threshold, stronger volume, slower momentum, no burst cap) were all negative.
**Interpretation:** during this period, 1-minute bursts on these markets tended to mean-revert. The scanner does what it is designed to do: it finds
early, explainable bursts before they are extended, with a median prior 60-minute change of +1.0 % versus the old bot's 24-hour-gainer bias. But
those bursts did not continue on average. Combined with the X2/X3 exit plan, which in practice only exits through the stop-loss,
the expected result is negative. The parameters were **not** tuned to make this backtest look good, because that would be overfitting three weeks of data.

## 5. Paper trading against live market data (user's PC, 15 Oct 2026, ~35 min so far)
- The supervised bot runs with health OK, entries allowed, ~55 authenticated requests/min (budget 400, documented limit 1000), no 429 and no errors.
- 1 paper entry: **LINK-USDC**, slot 1 (5 USDC, X2→X1), score 63.1, IOC filled 0.399033 @ 12.50625, fee 0.0045. Open with unrealized ≈ −0.02 USDC.
- Recovery verified for real: the first bot process was killed during the session. On restart the LINK position, its order registry and the paper balances
  were recovered intact. A graceful `npm run stop` and restart were also verified (lock released, supervisor stopped on exit code 0).
- Discord: PAPER messages delivered with no webhook errors.
- The bot is left running in **paper mode**, so collect at least 7 days before judging.

## 6. Known limitations
1. **No exchange-native stop-loss through the API.** Protection is software-only and stops when the PC sleeps, crashes or goes offline.
2. Strategy edge **not demonstrated** (section 4). The X2/X3 plan leaves capital exposed for days and rarely takes profit.
3. USDC books on Revolut X are thin, with 0.15–1.2 % spreads. About 8 of 23 pairs are usually tradable under the 0.4 % spread limit.
4. `total_fee` may be missing from order details. The fee is then estimated at 0.09 % and flagged in the position notes.
5. The price tick size is not published, so it is inferred from bid/ask decimals. A rejected price is reported and never retried in a loop.
6. Replay uses current spreads, not historical ones, and reference-market candles as a proxy for USDC prices.

## 7. Go / no-go
**NO-GO for live trading.** Reasons: no positive edge in replay, the USDC balance is insufficient, and the legacy XRP discrepancy is unresolved. The code
is ready for extended **paper** trading. Live activation stays behind the explicit steps in GO_LIVE_CHECKLIST.md.
