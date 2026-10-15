# Discord notifications

Configure `DISCORD_WEBHOOK_URL` (a secret, kept in `.env`). Messages are in French, prefixed with `HZN Bot Auto | 🧪 PAPER` or `🔴 LIVE`.

| Event | Example | Throttling |
|---|---|---|
| Startup | mode, auth status, reconciliation result, budget, plans | 1/min |
| Auth success/failure | `Authentification Revolut X : OK` | 30 min |
| Strong candidate (score ≥ `DISCORD_CANDIDATE_MIN_SCORE`) | 👀 symbol, reference market, score breakdown | per symbol 30 min |
| Entry decision | 🟢 why, slot, allocation, planned IOC order, estimated cost | none |
| Order **submitted** | 📨 `SOUMIS (pas encore exécuté)` | none |
| Entry **filled** | ✅ `EXÉCUTÉ`: average entry, quantity, cost, fee, reason, current bid, estimated net PnL, active protection | none |
| Entry not filled / rejected | ↩️ / ❌ | 10 min per error type |
| Target reached | 🎯 X2/X3 reached, floor armed | once per position |
| Stop-loss / floor triggered | 🛑 / 📉 bid, entry, PnL, "sending sell order" | 10 min |
| Exit **filled** (or partial) | 💰 qty @ price, fee, net PnL of the fill, remaining qty | none |
| Position closed | 📕 realized net PnL after fees, dust left | none |
| Reconciliation discrepancy | 🧩 kind, severity, details, "entries blocked" | 30 min |
| Unmanaged holding / recovered position | ⚠️ / 🚨 | 1 h / 30 min |
| Rate limit | ⏳ group, pause length | 30 min |
| No reliable price | 🚨 stop-loss cannot be evaluated | 30 min |
| Daily summary (21:00 Paris) | 📊 day and cumulative PnL, fees, win rate, drawdown, exposure, top rejection reasons | daily |
| Emergency / crash / shutdown | 🚨, plus a shutdown notice warning that monitoring has stopped | 10 min |

Every trade message states the asset, entry price and quantity, current price and estimated net PnL, the reason, the active
protection (always labelled **software monitoring**, plus any native order detected) and whether the order was submitted or filled.

All text passes through redaction: webhook URLs, API keys, private keys and signatures are removed. Messages are queued,
sent at most every 0.4 s, and Discord 429 responses are honoured.
