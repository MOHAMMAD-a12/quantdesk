/**
 * Bybit adapter (v5 API).
 *
 * Serves as the crypto failover behind Binance: same coverage, no credentials
 * for market data, and it remains reachable in jurisdictions where Binance
 * endpoints are blocked — which is the practical reason to keep two crypto
 * providers rather than one.
 *
 * Bybit wraps every response in `{ retCode, retMsg, result }` and returns HTTP
 * 200 even for logical failures, so `retCode` must be checked explicitly.
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

/** Bybit expresses intraday intervals as bare minute counts. */
const INTERVALS: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  '4h': '240',
  '1d': 'D',
  '1w': 'W',
};

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

/** Kline rows are string arrays: [start, open, high, low, close, volume, turnover]. */
type RawKline = [string, string, string, string, string, string, string];

interface RawTickerItem {
  symbol: string;
  lastPrice: string;
  prevPrice24h: string;
  price24hPcnt: string;
  highPrice24h: string;
  lowPrice24h: string;
  volume24h: string;
  turnover24h: string;
  fundingRate?: string;
  nextFundingTime?: string;
  openInterest?: string;
}

/**
 * Unwrap a Bybit envelope.
 *
 * `retCode !== 0` is a failure even though the HTTP status is 200; without this
 * check a caller would silently receive an empty result set.
 */
function unwrap<T>(envelope: BybitEnvelope<T>, provider: string): T {
  if (envelope.retCode !== 0) {
    throw new ProviderError(provider, `retCode ${envelope.retCode}: ${envelope.retMsg}`);
  }
  return envelope.result;
}

export class BybitProvider implements MarketDataProvider {
  readonly name = 'bybit' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: true,
    orderBook: true,
    derivatives: true,
    websocket: true,
  };

  private get baseUrl(): string {
    return config.market.bybit.baseUrl;
  }

  isConfigured(): boolean {
    return config.market.bybit.enabled;
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'crypto';
  }

  toProviderSymbol(symbol: MarketSymbol): string | null {
    if (symbol.assetClass !== 'crypto') return null;
    return symbol.symbol.toUpperCase();
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const pair = this.requirePair(symbol);

    const result = unwrap(
      await getJson<BybitEnvelope<{ list: RawKline[] }>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/kline`,
        query: {
          category: 'spot',
          symbol: pair,
          interval: INTERVALS[req.timeframe],
          limit: Math.min(req.limit, 1000),
          start: req.since,
        },
      }),
      this.name,
    );

    // Bybit returns newest-first; normaliseCandles sorts ascending.
    return normaliseCandles(
      (result.list ?? []).map((r) => ({
        time: num(r[0]),
        open: num(r[1]),
        high: num(r[2]),
        low: num(r[3]),
        close: num(r[4]),
        volume: num(r[5]),
      })),
    );
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const pair = this.requirePair(symbol);

    const result = unwrap(
      await getJson<BybitEnvelope<{ list: RawTickerItem[] }>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/tickers`,
        query: { category: 'spot', symbol: pair },
      }),
      this.name,
    );

    const t = result.list?.[0];
    if (!t) throw new ProviderError(this.name, `No ticker for ${pair}`);
    return this.toQuote(symbol.symbol, t);
  }

  /** One unfiltered tickers call covers every symbol we track. */
  async fetchQuotes(symbols: MarketSymbol[]): Promise<Quote[]> {
    const wanted = new Map<string, string>();
    for (const s of symbols) {
      const pair = this.toProviderSymbol(s);
      if (pair) wanted.set(pair, s.symbol);
    }
    if (wanted.size === 0) return [];

    const result = unwrap(
      await getJson<BybitEnvelope<{ list: RawTickerItem[] }>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/tickers`,
        query: { category: 'spot' },
      }),
      this.name,
    );

    const out: Quote[] = [];
    for (const t of result.list ?? []) {
      const canonical = wanted.get(t.symbol);
      if (canonical) out.push(this.toQuote(canonical, t));
    }
    return out;
  }

  async fetchOrderBook(symbol: MarketSymbol, depth: number): Promise<OrderBook> {
    const pair = this.requirePair(symbol);

    const result = unwrap(
      await getJson<BybitEnvelope<{ b: [string, string][]; a: [string, string][] }>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/orderbook`,
        query: { category: 'spot', symbol: pair, limit: Math.min(Math.max(depth, 1), 200) },
      }),
      this.name,
    );

    return {
      symbol: symbol.symbol,
      bids: (result.b ?? []).map(([p, q]) => ({ price: num(p), quantity: num(q) })),
      asks: (result.a ?? []).map(([p, q]) => ({ price: num(p), quantity: num(q) })),
      timestamp: Date.now(),
    };
  }

  /** Derivatives come from the `linear` category, where perpetuals live. */
  async fetchDerivatives(symbol: MarketSymbol): Promise<DerivativesContext> {
    const pair = this.requirePair(symbol);

    const result = unwrap(
      await getJson<BybitEnvelope<{ list: RawTickerItem[] }>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/tickers`,
        query: { category: 'linear', symbol: pair },
        attempts: 1,
      }),
      this.name,
    );

    const t = result.list?.[0];
    const ctx: DerivativesContext = { symbol: symbol.symbol, timestamp: Date.now() };
    if (!t) return ctx;

    if (t.fundingRate !== undefined) ctx.fundingRate = num(t.fundingRate);
    if (t.nextFundingTime !== undefined) ctx.nextFundingTime = num(t.nextFundingTime);
    if (t.openInterest !== undefined) ctx.openInterest = num(t.openInterest);
    return ctx;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await getJson<BybitEnvelope<unknown>>({
        provider: this.name,
        url: `${this.baseUrl}/v5/market/time`,
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

  private toQuote(canonicalSymbol: string, t: RawTickerItem): Quote {
    const last = num(t.lastPrice);
    const prev = num(t.prevPrice24h);
    return {
      symbol: canonicalSymbol,
      price: last,
      change: last - prev,
      // Bybit reports this as a decimal fraction, not a percentage.
      changePercent: num(t.price24hPcnt) * 100,
      high24h: num(t.highPrice24h),
      low24h: num(t.lowPrice24h),
      volume24h: num(t.volume24h),
      quoteVolume24h: num(t.turnover24h),
      timestamp: Date.now(),
      provider: this.name,
    };
  }
}
