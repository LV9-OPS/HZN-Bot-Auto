import { RevolutX } from "./revolut.js";

const api = new RevolutX();
const num = (value) => Number(value || 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function scoreTicker(ticker) {
  const price = num(ticker.last_price);
  const absoluteChange = num(ticker.price_change_24h);
  const basePrice = price - absoluteChange;
  const change24h = basePrice > 0 ? (absoluteChange / basePrice) * 100 : 0;
  const quoteVolume = num(ticker.quote_volume_24h);
  const spread = price > 0 ? ((num(ticker.ask) - num(ticker.bid)) / price) * 100 : 999;

  let score = 0;
  if (change24h >= 3) score += 20;
  if (change24h >= 5) score += 15;
  if (quoteVolume >= 100000) score += 15;
  if (quoteVolume >= 1000000) score += 15;
  if (spread <= 0.5) score += 15;
  if (spread <= 0.2) score += 10;

  return { score, change24h, quoteVolume, spread };
}

function intradayMomentum(candles) {
  if (!candles || candles.length < 3) return null;
  const sorted = [...candles].sort((a, b) => Number(a.start) - Number(b.start));
  const first = num(sorted[0].open);
  const last = num(sorted.at(-1).close);
  const recent = sorted.slice(-3);
  const firstRecent = num(recent[0].open);
  const recentLast = num(recent.at(-1).close);
  const change60m = first > 0 ? ((last - first) / first) * 100 : 0;
  const change15m = firstRecent > 0 ? ((recentLast - firstRecent) / firstRecent) * 100 : 0;
  const volume = sorted.reduce((sum, candle) => sum + num(candle.volume), 0);
  return { change60m, change15m, volume };
}

export async function scan() {
  const response = await api.getTickers();
  const preliminary = (response.data || [])
    .map((ticker) => ({ ticker, metrics: scoreTicker(ticker) }))
    .filter(({ ticker, metrics }) =>
      ticker.symbol &&
      ticker.symbol.EndsWith("/USDC") &&
      metrics.change24h >= 1 &&
      metrics.quoteVolume >= 100000 &&
      metrics.spread <= 1
    )
    .sort((a, b) => b.metrics.score - a.metrics.score)
    .slice(0, 8);

  const results = [];
  for (const candidate of preliminary) {
    const now = Date.now();
    const candlesResponse = await api.getCandles(
      candidate.ticker.symbol.replace("/", "-"),
      5,
      now - 60 * 60 * 1000,
      now
    );
    const momentum = intradayMomentum(candlesResponse.data || []);
    if (momentum && (momentum.change15m >= 2 || momentum.change60m >= 4)) {
      results.push({
        ...candidate,
        metrics: { ...candidate.metrics, ...momentum, score: candidate.metrics.score + 25 }
      });
    }
    await sleep(1050);
  }

  return results.sort((a, b) => b.metrics.score - a.metrics.score);
}

if (process.argv[1] && process.argv[1].endsWith("scanner.js")) {
  const candidates = await scan();
  console.table(candidates.slice(0, 10).map(({ ticker, metrics }) => ({
    symbol: ticker.symbol,
    price: ticker.last_price,
    change15mPct: metrics.change15m.toFixed(2),
    change60mPct: metrics.change60m.toFixed(2),
    change24hPct: metrics.change24h.toFixed(2),
    volume24h: metrics.quoteVolume.toFixed(0),
    spreadPct: metrics.spread.toFixed(3),
    score: metrics.score
  })));
}


