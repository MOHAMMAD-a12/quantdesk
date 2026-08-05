/**
 * Coinbase Exchange adapter.
 *
 * A third crypto source, disabled by default (`MARKET_COINBASE_ENABLED=false`).
 * Its value is jurisdictional and regulatory: Coinbase remains available where
 * Binance and Bybit are restricted, and USD spot pairs price differently from
 * USDT pairs during stablecoin dislocations.
 *
 * Coinbase quotes against USD rather than USDT, so canonical `BTCUSDT` maps to
 * `BTC-USD`. That is a real basis difference, not a naming detail — during a
 * USDT depeg the two genuinely diverge.
 */

import type { AssetClass, Candle, MarketSymbol, Quote, Timeframe } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { getJson, num } from '../http.js';
import {
  normaliseCandles,
  type CandleRequest,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';

/** Coinbase granularity is in seconds and only these values are accepted. */
const GRANULARITY: Record<Timeframe, number | null> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  // No native 30m/4h/1w — resampled from the nearest supported granularity.
  '30m': 900,
  '1h': 3600,
  '4h': 3600,
  '1d': 86400,
  '1w': 86400,
};

/** Rows are [time(s), low, high, open, close, volume] — note the ordering. */
type RawCandle = [number, number, number, number, number, number];

interface RawStats {
  open: string;
  high: string;
  low: string;
  volume: string;
  last: string;
}

interface RawTicker {
  price: string;
  volume: string;
  time: string;
}

export class CoinbaseProvider implements MarketDataProvider {
  readonly name = 'coinbase' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: false,
    orderBook: true,
    derivatives: false,
    websocket: true,
  };

  private get baseUrl(): string {
    return config.market.coinbase.baseUrl;
  }

  isConfigured(): boolean {
    return config.market.coinbase.enabled;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'crypto';
  }

  /** `BTCUSDT` → `BTC-USD`: Coinbase lists USD pairs, not USDT. */
  toProviderSymbol(symbol: MarketSymbol): string | null {
    if (symbol.assetClass !== 'crypto') return null;
    const quote = symbol.quote === 'USDT' || symbol.quote === 'USDC' ? 'USD' : symbol.quote;
    return `${symbol.base}-${quote}`;
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const pair = this.requirePair(symbol);
    const granularity = GRANULARITY[req.timeframe];
    if (granularity === null) {
      throw new ProviderError(this.name, `Unsupported timeframe ${req.timeframe}`);
    }

    // Coinbase caps at 300 candles per call and requires an explicit window when
    // more than the default page is needed.
    const rows = await getJson<RawCandle[]>({
      provider: this.name,
      url: `${this.baseUrl}/products/${pair}/candles`,
      query: { granularity, ...(req.since ? { start: new Date(req.since).toISOString() } : {}) },
    });

    const base = normaliseCandles(
      rows.map((r) => ({
        time: r[0] * 1000,
        low: num(r[1]),
        high: num(r[2]),
        open: num(r[3]),
        close: num(r[4]),
        volume: num(r[5]),
      })),
    );

    const resampled = resampleIfNeeded(base, req.timeframe);
    return resampled.slice(-req.limit);
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const pair = this.requirePair(symbol);

    // Stats gives the 24h window; ticker gives the freshest price.
    const [stats, ticker] = await Promise.all([
      getJson<RawStats>({
        provider: this.name,
        url: `${this.baseUrl}/products/${pair}/stats`,
      }),
      getJson<RawTicker>({
        provider: this.name,
        url: `${this.baseUrl}/products/${pair}/ticker`,
      }),
    ]);

    const price = num(ticker.price) || num(stats.last);
    const open = num(stats.open);

    return {
      symbol: symbol.symbol,
      price,
      change: price - open,
      changePercent: open === 0 ? 0 : ((price - open) / open) * 100,
      high24h: num(stats.high, price),
      low24h: num(stats.low, price),
      volume24h: num(stats.volume),
      timestamp: ticker.time ? Date.parse(ticker.time) : Date.now(),
      provider: this.name,
    };
  }

  async fetchOrderBook(symbol: MarketSymbol, depth: number) {
    const pair = this.requirePair(symbol);

    // level=2 returns aggregated top-50 depth, which is what liquidity analysis
    // needs; level=3 is the full uncompressed book and far too heavy.
    const book = await getJson<{ bids: [string, string, number][]; asks: [string, string, number][] }>({
      provider: this.name,
      url: `${this.baseUrl}/products/${pair}/book`,
      query: { level: 2 },
    });

    return {
      symbol: symbol.symbol,
      bids: (book.bids ?? []).slice(0, depth).map(([p, q]) => ({ price: num(p), quantity: num(q) })),
      asks: (book.asks ?? []).slice(0, depth).map(([p, q]) => ({ price: num(p), quantity: num(q) })),
      timestamp: Date.now(),
    };
  }

  async healthCheck(): Promise<boolean> {
    try {
      await getJson<unknown>({
        provider: this.name,
        url: `${this.baseUrl}/time`,
        attempts: 1,
        timeoutMs: 4_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private requirePair(symbol: MarketSymbol): string {
    const pair = this.toProviderSymbol(symbol);
    if (!pair) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);
    return pair;
  }
}

/**
 * Aggregate into a timeframe Coinbase does not serve natively.
 *
 * Buckets align to the UTC epoch so boundaries match the other providers —
 * see the equivalent note in the Finnhub adapter.
 */
function resampleIfNeeded(candles: Candle[], timeframe: Timeframe): Candle[] {
  const targetMs =
    timeframe === '30m' ? 1_800_000 : timeframe === '4h' ? 14_400_000 : timeframe === '1w' ? 604_800_000 : null;
  if (targetMs === null) return candles;

  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    // Weekly bars open Monday; the epoch was a Thursday, hence the 4-day shift.
    const bucketTime =
      targetMs === 604_800_000
        ? Math.floor((c.time + 345_600_000) / targetMs) * targetMs - 345_600_000
        : Math.floor(c.time / targetMs) * targetMs;

    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, { ...c, time: bucketTime });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    existing.close = c.close;
    existing.volume += c.volume;
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
