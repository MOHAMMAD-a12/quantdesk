/**
 * Binance adapter.
 *
 * The primary crypto source: no API key required for market data, deep history,
 * and it exposes funding rate and open interest through the futures endpoints,
 * which the derivatives context needs.
 *
 * Spot is used for candles and quotes; the USD-M futures API is used only for
 * derivatives, since perpetual funding has no spot equivalent.
 */

import type {
  AssetClass,
  Candle,
  DerivativesContext,
  MarketSymbol,
  OrderBook,
  Quote,
  Timeframe,
} from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { getJson, num } from '../http.js';
import {
  normaliseCandles,
  type CandleRequest,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';

/** Binance's own interval vocabulary. */
const INTERVALS: Record<Timeframe, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
};

/**
 * A kline row is a positional array, not an object:
 * [openTime, open, high, low, close, volume, closeTime, quoteVolume, ...]
 */
type RawKline = [number, string, string, string, string, string, number, string, ...unknown[]];

interface RawTicker24h {
  symbol: string;
  lastPrice: string;
  priceChange: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  volume: string;
  quoteVolume: string;
  closeTime: number;
}

interface RawDepth {
  bids: [string, string][];
  asks: [string, string][];
}

interface RawPremiumIndex {
  symbol: string;
  lastFundingRate: string;
  nextFundingTime: number;
}

interface RawOpenInterest {
  symbol: string;
  openInterest: string;
}

const FUTURES_BASE = 'https://fapi.binance.com';

export class BinanceProvider implements MarketDataProvider {
  readonly name = 'binance' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: true,
    orderBook: true,
    derivatives: true,
    websocket: true,
  };

  private get baseUrl(): string {
    return config.market.binance.baseUrl;
  }

  isConfigured(): boolean {
    // Public market data needs no credentials — only the operator's on/off flag.
    return config.market.binance.enabled;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'crypto';
  }

  toProviderSymbol(symbol: MarketSymbol): string | null {
    if (symbol.assetClass !== 'crypto') return null;
    return symbol.symbol.toUpperCase();
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const pair = this.toProviderSymbol(symbol);
    if (!pair) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);

    const rows = await getJson<RawKline[]>({
      provider: this.name,
      url: `${this.baseUrl}/api/v3/klines`,
      query: {
        symbol: pair,
        interval: INTERVALS[req.timeframe],
        // Binance caps at 1000 per request.
        limit: Math.min(req.limit, 1000),
        startTime: req.since,
      },
    });

    return normaliseCandles(
      rows.map((r) => ({
        time: r[0],
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5]),
      })),
    );
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const pair = this.toProviderSymbol(symbol);
    if (!pair) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);

    const t = await getJson<RawTicker24h>({
      provider: this.name,
      url: `${this.baseUrl}/api/v3/ticker/24hr`,
      query: { symbol: pair },
    });

    return this.toQuote(symbol.symbol, t);
  }

  /**
   * Batch quotes in one call.
   *
   * The dashboard shows every tracked symbol at once; issuing one request per
   * symbol would burn the weight budget and rate-limit the whole platform.
   */
  async fetchQuotes(symbols: MarketSymbol[]): Promise<Quote[]> {
    const pairs = symbols
      .map((s) => ({ canonical: s.symbol, provider: this.toProviderSymbol(s) }))
      .filter((p): p is { canonical: string; provider: string } => p.provider !== null);

    if (pairs.length === 0) return [];

    const tickers = await getJson<RawTicker24h[]>({
      provider: this.name,
      url: `${this.baseUrl}/api/v3/ticker/24hr`,
      query: { symbols: JSON.stringify(pairs.map((p) => p.provider)) },
    });

    const byPair = new Map(tickers.map((t) => [t.symbol, t]));
    const out: Quote[] = [];
    for (const p of pairs) {
      const t = byPair.get(p.provider);
      if (t) out.push(this.toQuote(p.canonical, t));
    }
    return out;
  }

  async fetchOrderBook(symbol: MarketSymbol, depth: number): Promise<OrderBook> {
    const pair = this.toProviderSymbol(symbol);
    if (!pair) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);

    const book = await getJson<RawDepth>({
      provider: this.name,
      url: `${this.baseUrl}/api/v3/depth`,
      // Binance only accepts specific depth values.
      query: { symbol: pair, limit: closestDepth(depth) },
    });

    return {
      symbol: symbol.symbol,
      bids: book.bids.map(([price, quantity]) => ({ price: num(price), quantity: num(quantity) })),
      asks: book.asks.map(([price, quantity]) => ({ price: num(price), quantity: num(quantity) })),
      timestamp: Date.now(),
    };
  }

  /**
   * Funding rate and open interest from the USD-M futures API.
   *
   * Only perpetual contracts have these. A symbol with no futures listing
   * returns a 400, which we surface as an absent context rather than an error —
   * missing derivatives data should not fail an analysis.
   */
  async fetchDerivatives(symbol: MarketSymbol): Promise<DerivativesContext> {
    const pair = this.toProviderSymbol(symbol);
    if (!pair) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);

    const [premium, oi] = await Promise.allSettled([
      getJson<RawPremiumIndex>({
        provider: this.name,
        url: `${FUTURES_BASE}/fapi/v1/premiumIndex`,
        query: { symbol: pair },
        attempts: 1,
      }),
      getJson<RawOpenInterest>({
        provider: this.name,
        url: `${FUTURES_BASE}/fapi/v1/openInterest`,
        query: { symbol: pair },
        attempts: 1,
      }),
    ]);

    const ctx: DerivativesContext = { symbol: symbol.symbol, timestamp: Date.now() };

    if (premium.status === 'fulfilled') {
      ctx.fundingRate = num(premium.value.lastFundingRate);
      ctx.nextFundingTime = premium.value.nextFundingTime;
    }
    if (oi.status === 'fulfilled') {
      ctx.openInterest = num(oi.value.openInterest);
    }

    return ctx;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await getJson<unknown>({
        provider: this.name,
        url: `${this.baseUrl}/api/v3/ping`,
        attempts: 1,
        timeoutMs: 4_000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private toQuote(canonicalSymbol: string, t: RawTicker24h): Quote {
    return {
      symbol: canonicalSymbol,
      price: num(t.lastPrice),
      change: num(t.priceChange),
      changePercent: num(t.priceChangePercent),
      high24h: num(t.highPrice),
      low24h: num(t.lowPrice),
      volume24h: num(t.volume),
      quoteVolume24h: num(t.quoteVolume),
      timestamp: t.closeTime || Date.now(),
      provider: this.name,
    };
  }
}

/** Binance rejects arbitrary depth values; snap to the nearest permitted one. */
function closestDepth(requested: number): number {
  const allowed = [5, 10, 20, 50, 100, 500, 1000, 5000];
  return allowed.find((d) => d >= requested) ?? 100;
}
