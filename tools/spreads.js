// Read-only: samples Revolut X tickers and reports median/p90 bid-ask spread and 24h volume.
// npm run spreads -- --assets BTC,ETH,SOL,XRP --quotes EUR,USD,USDC --samples 20 --every 15
import { setup, arg } from "../src/cli/common.js";
import { PRIORITY } from "../src/api/scheduler.js";

const { client } = setup({ overrides: { BOT_MODE: "paper" }, consoleLogs: false, level: "error" });
const assets = String(arg("assets", "BTC,ETH,SOL,XRP")).toUpperCase().split(",");
const quotes = String(arg("quotes", "EUR,USD,USDC")).toUpperCase().split(",");
const samples = Number(arg("samples", 20));
const every = Number(arg("every", 15)) * 1000;
const pairs = await client.getPairs();
const syms = assets.flatMap((a) => quotes.map((q) => `${a}-${q}`)).filter((s) => pairs.get(s)?.status === "active");
const obs = new Map(syms.map((s) => [s, []]));
const vol = new Map();
for (let i = 0; i < samples; i++) {
  const tks = await client.getTickers(syms, PRIORITY.RADAR);
  for (const s of syms) {
    const tk = tks.get(s);
    if (tk?.valid && Number.isFinite(tk.spreadPct)) obs.get(s).push(tk.spreadPct);
    if (tk?.quoteVolume24h) vol.set(s, tk.quoteVolume24h);
  }
  if (i < samples - 1) await new Promise((r) => setTimeout(r, every));
}
const q = (a, p) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : NaN; };
const rows = syms.map((s) => ({ symbol: s, medianSpreadPct: +q(obs.get(s), 0.5).toFixed(4), p90SpreadPct: +q(obs.get(s), 0.9).toFixed(4), n: obs.get(s).length, vol24hQuote: Math.round(vol.get(s) || 0), minQuote: pairs.get(s)?.minOrderSizeQuote ?? null, minBase: pairs.get(s)?.minOrderSize ?? null }));
console.table(rows);
if (arg("json")) console.log(JSON.stringify(rows));
