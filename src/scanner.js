import { RevolutX } from "./revolut.js";

const api = new RevolutX();
const num = (value) => Number(value || 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ALLOWED_QUOTES = new Set(["USD", "USDC", "EUR"]);
const STABLE_BASES = new Set(["USDC", "USDT", "DAI", "EURC", "FDUSD", "TUSD", "USDE"]);
const MIN_QUOTE_VOLUME = num(process.env.MIN_QUOTE_VOLUME || 25000);
const MAX_PRELIMINARY = Math.max(8, num(process.env.MAX_PRELIMINARY_CANDIDATES || 8));

function pairParts(symbol) {
  const [base, quote] = String(symbol || "").split("/");
  return { base, quote };
}

function scoreTicker(ticker) {
  const price = num(ticker.last_price);
  const absoluteChange = num(ticker.price_change_24h);
  const basePrice = price - absoluteChange;
  const change24h = basePrice > 0 ? (absoluteChange / basePrice) * 100 : 0;
  const quoteVolume = num(ticker.quote_volume_24h);
  const spread = price > 0 ? ((num(ticker.ask) - num(ticker.bid)) / price) * 100 : 999;
  const range24h = price > 0
    ? ((num(ticker.high_24h) - num(ticker.low_24h)) / price) * 100
    : 0;

  let score = 0;
  if (change24h >= 2) score += 10;
  if (change24h >= 5) score += 10;
  if (change24h >= 10) score += 10;
  if (quoteVolume >= MIN_QUOTE_VOLUME) score += 10;
  if (quoteVolume >= 100000) score += 10;
  if (quoteVolume >= 1000000) score += 5;
  if (spread <= 1) score += 10;
  if (spread <= 0.5) score += 10;
  if (spread <= 0.2) score += 5;
  if (range24h >= 5) score += 5;
  if (range24h >= 10) score += 5;

  return { score, change24h, quoteVolume, spread, range24h };
}

function intradayMomentum(candles) {
  if (!candles || candles.length < 3) return null;
  const sorted = [...candles].sort((a, b) => Number(a.start) - Number(b.start));
  const first = num(sorted[0].open);
  const last = num(sorted.at(-1).close);
  const recent = sorted.slice(-3);
  const firstRecent = num(recent[0].open);
  const recentLast = num(recent.at(-1).close);
  const volume = sorted.reduce((sum, candle) => sum + num(candle.volume), 0);
  const recentVolume = recent.reduce((sum, candle) => sum + num(candle.volume), 0);
  const previous = sorted.slice(-6, -3);
  const previousVolume = previous.reduce((sum, candle) => sum + num(candle.volume), 0);
  const change60m = first > 0 ? ((last - first) / first) * 100 : 0;
  const change15m = firstRecent > 0 ? ((recentLast - firstRecent) / firstRecent) * 100 : 0;
  const volumeAcceleration = previousVolume > 0 ? recentVolume / previousVolume : 1;
  const volatility = sorted.reduce((sum, candle) => {
    const open = num(candle.open);
    const high = num(candle.high);
    const low = num(candle.low);
    return sum + (open > 0 ? ((high - low) / open) * 100 : 0);
  }, 0) / sorted.length;
  return { change60m, change15m, volume, volumeAcceleration, volatility };
}

export async function scan() {
  const [pairsResponse, tickerResponse] = await Promise.all([
    api.getPairs(),
    api.getTickers()
  ]);

  const pairs = pairsResponse.data || pairsResponse;
  const activePairs = new Map(
    Object.entries(pairs)
      .filter(([, config]) => config?.status === "active")
      .map(([symbol, config]) => [symbol, config])
  );

  const preliminary = (tickerResponse.data || [])
    .map((ticker) => {
      const { base, quote } = pairParts(ticker.symbol);
      const config = activePairs.get(ticker.symbol);
      return { ticker, config, base, quote, metrics: scoreTicker(ticker) };
    })
    .filter(({ ticker, config, base, quote, metrics }) =>
      Boolean(config) &&
      Boolean(ticker.symbol) &&
      ALLOWED_QUOTES.has(quote) &&
      !STABLE_BASES.has(base) &&
      metrics.change24h >= 1 &&
      metrics.quoteVolume >= MIN_QUOTE_VOLUME &&
      metrics.spread <= 1
    )
    .sort((a, b) => {
      const momentumA = Math.max(a.metrics.change24h, 0);
      const momentumB = Math.max(b.metrics.change24h, 0);
      return (b.metrics.score + momentumB) - (a.metrics.score + momentumA);
    })
    .slice(0, MAX_PRELIMINARY);

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

    if (momentum) {
      const confirmed =
        momentum.change15m >= 1.5 ||
        momentum.change60m >= 3 ||
        momentum.volumeAcceleration >= 1.5;

      if (confirmed) {
        const accelerationBonus = Math.min(15, Math.max(0, (momentum.volumeAcceleration - 1) * 10));
        const volatilityBonus = Math.min(10, Math.max(0, momentum.volatility));
        results.push({
          ...candidate,
          metrics: {
            ...candidate.metrics,
            ...momentum,
            score: candidate.metrics.score + 25 + accelerationBonus + volatilityBonus
          }
        });
      }
    }

    await sleep(1050);
  }

  return results.sort((a, b) => b.metrics.score - a.metrics.score);
}

if (process.argv[1] && process.argv[1].endsWith("scanner.js")) {
  const candidates = await scan();
  console.table(candidates.slice(0, 10).map(({ ticker, quote, metrics }) => ({
    symbol: ticker.symbol,
    quote,
    price: ticker.last_price,
    change15mPct: metrics.change15m.toFixed(2),
    change60mPct: metrics.change60m.toFixed(2),
    change24hPct: metrics.change24h.toFixed(2),
    volume24h: metrics.quoteVolume.toFixed(0),
    volumeAccel: metrics.volumeAcceleration.toFixed(2),
    volatilityPct: metrics.volatility.toFixed(2),
    spreadPct: metrics.spread.toFixed(3),
    score: metrics.score.toFixed(1)
  })));
}
