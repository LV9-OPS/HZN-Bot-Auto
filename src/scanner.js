import { RevolutX } from "./revolut.js";

const api = new RevolutX();
const num = (value) => Number(value || 0);

function scoreTicker(ticker) {
  const price = num(ticker.last_price);
  const change24h = price > 0 ? (num(ticker.price_change_24h) / price) * 100 : 0;
  const quoteVolume = num(ticker.quote_volume_24h);
  const spread = price > 0 ? ((num(ticker.ask) - num(ticker.bid)) / price) * 100 : 999;

  let score = 0;
  if (change24h >= 3) score += 25;
  if (change24h >= 5) score += 20;
  if (quoteVolume >= 100000) score += 15;
  if (quoteVolume >= 1000000) score += 15;
  if (spread <= 0.5) score += 15;
  if (spread <= 0.2) score += 10;

  return { score, change24h, quoteVolume, spread };
}

export async function scan() {
  const response = await api.getTickers();
  return (response.data || [])
    .map((ticker) => ({ ticker, metrics: scoreTicker(ticker) }))
    .filter(({ ticker, metrics }) =>
      ticker.symbol &&
      metrics.change24h >= 3 &&
      metrics.quoteVolume >= 100000 &&
      metrics.spread <= 1
    )
    .sort((a, b) => b.metrics.score - a.metrics.score);
}

if (process.argv[1] && process.argv[1].endsWith("scanner.js")) {
  const candidates = await scan();
  console.table(candidates.slice(0, 10).map(({ ticker, metrics }) => ({
    symbol: ticker.symbol,
    price: ticker.last_price,
    change24hPct: metrics.change24h.toFixed(2),
    volume24h: metrics.quoteVolume.toFixed(0),
    spreadPct: metrics.spread.toFixed(3),
    score: metrics.score
  })));
}
