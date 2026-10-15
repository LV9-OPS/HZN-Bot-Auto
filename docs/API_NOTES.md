# Revolut X API notes (verified 15 Oct 2026)

Source: https://developer.revolut.com/docs/api/revolut-x-crypto-exchange (place-order, get-order, get-tickers, get-candles pages and the OpenAPI spec),
plus read-only calls made from the user's PC.

- **Base URL:** `https://revx.revolut.com/api`
- **Auth:** headers `X-Revx-API-Key`, `X-Revx-Timestamp` (ms), `X-Revx-Signature` = base64 Ed25519 signature of
  `timestamp + METHOD + /api/path + query (no '?') + minified JSON body`.
- **Order placement** `POST /1.0/orders`: `client_order_id`, `symbol` (`BTC-USDC`), `side` (`buy`/`sell`), `order_configuration` with
  **exactly one** of `limit {base_size|quote_size, price, time_in_force gtc|ioc, execution_instructions}` or `market {base_size|quote_size}`.
  The response contains `venue_order_id`, `client_order_id` and `state`.
  **No conditional, stop or TP/SL creation through the API.** Order objects can have the types `conditional`, `tpsl` and `twap` (created in the app),
  with `trigger_price`/`trigger_direction`. The API can read and cancel them.
- **Order status:** `pending_new, new, partially_filled, filled, cancelled, rejected, replaced`. Details include `filled_quantity`,
  `average_fill_price`, `filled_amount`, `total_fee`, `fee_currency` (optional: missing on the user's real XRP order).
- **Cancel:** `DELETE /1.0/orders/{id}` (one order). `DELETE /1.0/orders` cancels **all** orders and is intentionally not used.
- **Replace:** `PUT /1.0/orders/{id}` exists. It is not used, because the bot uses IOC orders.
- **Lists:** `GET /1.0/orders/active`, `GET /1.0/orders/historical` (filters `symbols`, `order_states`, `order_types`, `start_date`,
  `end_date`, `cursor`, `limit`; `metadata.next_cursor`). There is no lookup by `client_order_id`.
- **Market data:** `GET /1.0/tickers` (bid, ask, mid, index_price, last_price, 24h stats), `GET /1.0/candles/{symbol}` (intervals 1…40320 min,
  `since`/`until`, up to 5000 candles), `GET /1.0/order-book/{symbol}`, `GET /1.0/configuration/pairs` (`base_step`, `quote_step`,
  `min_order_size`, `min_order_size_quote`, `status`). Public `/public/...` versions need `region`. Without `region`, tickers are duplicated per region.
- **Rate limits:** public 1 req/s. Authenticated reads 100/s and 1000/min (1 token each). Historical orders, trades and transactions cost 1 token per day in range.
  Candles cost max(5000, count) tokens of 5,000,000/min. Orders 10/s and 1000/day. `429` carries `Retry-After` in **milliseconds**.
- **Fees:** maker 0 %, taker 0.09 % (revolut.com/legal/crypto-exchange-fees).
- **Observed market structure (EEA):** 23 active USDC pairs. USDC spreads are 0.15–1.2 % and about 75 % of 1-minute USDC candles have zero volume. The same coins
  quoted in USD/EUR are 10–20× more liquid.
