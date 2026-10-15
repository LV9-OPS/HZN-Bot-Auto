// npm run fetch-binance -- [--interval 1h] [--from 2017-08-17]
// Long-horizon research data (2017 -> today) for the coins Revolut X lists against USDC.
// Revolut X itself only serves candles from its own launch (2024), so multi-cycle research
// (2018 bear, 2020 crash, 2021 bull, 2022 LUNA/FTX, 2024-26) uses Binance PUBLIC spot klines
// (BASEUSDT) as the price reference. Execution costs are still modelled with Revolut X
// spreads and fees. Read-only, no API key, throttled well below Binance limits.
import fs from "node:fs";
import path from "node:path";
import { loadEnvFile, buildConfig } from "../src/config/index.js";
import { arg } from "../src/cli/common.js";
import { sleep } from "../src/util/time.js";

loadEnvFile();
const cfg = buildConfig({ ...process.env, BOT_MODE: "paper" });
const interval = arg("interval", "1h");
const from = Date.parse(arg("from", "2017-08-17"));
const bases = String(arg("bases", "BTC,ETH,SOL,XRP,DOGE,ADA,LINK,AVAX,BNB,BCH,DOT,LTC,TRX,TON,SUI,HBAR,XLM,ENA,JUP,PEPE,SHIB,BONK,TRUMP")).split(",");
const outDir = path.join(cfg.dataDir, `history-binance-${interval}`);
fs.mkdirSync(outDir, { recursive: true });
const stepMs = { "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[interval];
if (!stepMs) throw new Error("unsupported interval");

async function get(url) {
  for (let i = 0; i < 5; i++) {
    const res = await fetch(url);
    if (res.status === 429 || res.status === 418) {
      const ra = Number(res.headers.get("retry-after") || 30);
      console.warn(`rate limited, waiting ${ra}s`);
      await sleep(ra * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return res.json();
  }
  throw new Error("too many retries");
}

const meta = { source: "binance-spot-public", interval, fetchedAt: new Date().toISOString(), assets: [] };
for (const base of bases) {
  const symbol = `${base}USDT`;
  const file = path.join(outDir, `${base}.json`);
  let rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  let start = rows.length ? rows[rows.length - 1][0] + stepMs : from;
  let n = 0;
  try {
    while (start < Date.now() - stepMs) {
      const k = await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=1000`);
      if (!Array.isArray(k) || !k.length) {
        // symbol listed later: jump forward
        if (start === from || rows.length === 0) {
          const first = await get(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=0&limit=1`);
          if (!first.length) break;
          start = first[0][0];
          continue;
        }
        break;
      }
      for (const c of k) rows.push([c[0], +c[1], +c[2], +c[3], +c[4], +c[5], +c[7]]);
      start = k[k.length - 1][0] + stepMs;
      n += k.length;
      await sleep(150);
    }
  } catch (e) {
    console.warn(`${symbol}: ${e.message}`);
  }
  // de-duplicate + sort
  const m = new Map(rows.map((r) => [r[0], r]));
  rows = [...m.values()].sort((a, b) => a[0] - b[0]);
  fs.writeFileSync(file, JSON.stringify(rows));
  meta.assets.push({ base, symbol, rows: rows.length, from: rows[0] ? new Date(rows[0][0]).toISOString() : null, to: rows.length ? new Date(rows[rows.length - 1][0]).toISOString() : null });
  console.log(`${symbol.padEnd(10)} +${n} rows, total ${rows.length}, from ${meta.assets.at(-1).from}`);
}
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2));
console.log("saved to " + outDir);
process.exit(0);
