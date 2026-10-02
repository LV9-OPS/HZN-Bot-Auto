# HZN Bot Auto

Automated crypto momentum scanner for Revolut X.

## Current status

- Revolut X public market data: enabled
- Momentum scanner: enabled
- Paper Trading: default
- Live order execution: intentionally disabled in v0.1.0
- Hard trade-size guard: 10 USDT-equivalent maximum
- Stop loss target: 3%
- Take profit target: 10%
- Discord: prepared through environment variable

## Security

Never commit .env, private.pem, API keys, or Discord webhooks.

The Revolut X API key is sent as-is in X-Revx-API-Key. Request signatures are generated with the local Ed25519 private key and Base64 encoded.

## Run

1. Copy .env.example to .env.
2. Set REVOLUT_API_KEY locally.
3. Keep REVOLUT_PRIVATE_KEY_PATH pointing to the protected private.pem.
4. Run npm start.

No real order is sent by this version.
