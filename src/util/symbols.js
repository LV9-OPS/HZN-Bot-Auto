// Revolut X uses "BTC/USDC" in tickers/configuration and "BTC-USDC" in paths and orders.
// Internally we always use the dash form.

export function normSymbol(s) {
  return String(s || "").trim().toUpperCase().replace("/", "-");
}

export function slashSymbol(s) {
  return normSymbol(s).replace("-", "/");
}

export function splitSymbol(s) {
  const [base, quote] = normSymbol(s).split("-");
  return { base, quote };
}

export const STABLE_OR_FIAT = new Set([
  "USDC", "USDT", "DAI", "EURC", "EURT", "FDUSD", "TUSD", "USDE", "PYUSD", "USDS", "RLUSD", "USDP", "GUSD",
  "USD", "EUR", "GBP", "CHF", "PLN", "RON", "CZK", "HUF", "SEK", "NOK", "DKK", "AUD", "CAD", "JPY"
]);
