# Installation on Windows

1. **Node.js ≥ 20.12** (24.x tested): `node -v`. The bot has no npm dependencies, so `npm install` is optional.
2. **Code:** `C:\Users\insan\HZN-Bot-Auto`, branch `rebuild/v3` (`git checkout rebuild/v3`). The old code is on `legacy/pre-v3-snapshot`
   and `main`, with a file copy in `backups\pre-v3-*`.
3. **Revolut X API key:** create it in Revolut X → Profile → API keys, with an Ed25519 public key:
   ```powershell
   mkdir C:\Users\insan\HZN-Secrets\RevolutX -Force
   cd C:\Users\insan\HZN-Secrets\RevolutX
   openssl genpkey -algorithm ed25519 -out private.pem
   openssl pkey -in private.pem -pubout -out public.pem   # paste public.pem into Revolut X
   ```
   Keep the key outside the repository. Give the API key the **minimum permissions** (read + trade, never withdraw).
4. **Configuration:** copy `.env.example` to `.env` (or to `C:\Users\insan\HZN-Secrets\hzn.env` and set the user environment variable
   `HZN_ENV_FILE` to that path). Fill in `REVOLUT_API_KEY`, `REVOLUT_PRIVATE_KEY_PATH` and `DISCORD_WEBHOOK_URL`, and keep `BOT_MODE=paper`.
   Save the file as UTF-8 **without BOM** (Notepad "UTF-8", not "UTF-8 with BOM").
5. **Verify:**
   ```powershell
   npm run check; npm test
   npm run account      # read-only: balances and filled orders
   npm run reconcile    # read-only: what the bot would see at startup
   ```
6. **Run in paper mode:** `npm start` (foreground) or `powershell -ExecutionPolicy Bypass -File scripts\run-bot.ps1` (auto-restart).
7. **Autostart at logon (optional):** `powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1`.
   Set *Power Options → Sleep: Never*. A sleeping PC does not monitor stop-losses.
8. **Monitor:** `npm run status`, the dashboard at http://127.0.0.1:8787/ (local only), the `logs\hzn-YYYY-MM-DD.log` files (JSON lines,
   rotated daily and at 20 MB, kept 14 days), `logs\supervisor.log` and Discord.
