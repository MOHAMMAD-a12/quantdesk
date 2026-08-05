/**
 * Polygon.io adapter.
 *
 * The highest-fidelity US equities and index source: true tick-level aggregates,
 * long intraday history, and native index support via the `I:` prefix. Preferred
 * over Finnhub for stocks and indices when both keys are present.
 *
 * Requires `MARKET_POLYGON_API_KEY`.
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

const BASE_URL = 'https://api.polygon.io';

/** Polygon expresses a timeframe as multiplier + timespan. */
const AGGREGATES: Record<Timeframe, { multiplier: number; timespan: string }> = {
  '1m': { multiplier: 1, timespan: 'minute' },
  '5m': { multiplier: 5, timespan: 'minute' },
  '15m': { multiplier: 15, timespan: 'minute' },
  '30m': { multiplier: 30, timespan: 'minute' },
  '1h': { multiplier: 1, timespan: 'hour' },
  '4h': { multiplier: 4, timespan: 'hour' },
  '1d': { multiplier: 1, timespan: 'day' },
  '1w': { multiplier: 1, timespan: 'week' },
};

interface RawAgg {
  t: number; // start ms
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
}

interface AggregatesResponse {
  status?: string;
  error?: string;
  resultsCount?: number;
  results?: RawAgg[];
}

interface SnapshotResponse {
  status?: string;
  error?: string;
  ticker?: {
    ticker: string;
    todaysChange?: number;
    todaysChangePerc?: number;
    day?: { o: number; h: number; l: number; c: number; v: number };
    prevDay?: { o: number; h: number; l: number; c: number; v: number };
    lastTrade?: { p: number; t: number };
    min?: { c: number; h: number; l: number; v: number };
  };
}

export class PolygonProvider implements MarketDataProvider {
  readonly name = 'polygon' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: false,
    orderBook: false,
    derivatives: false,
    websocket: true,
  };

  isConfigured(): boolean {
    return Boolean(config.market.polygon.apiKey);
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'stock' || assetClass === 'index' || assetClass === 'forex';
  }

  /**
   * Polygon namespaces non-equity tickers: `I:` for indices, `C:` for forex.
   * Equities are bare.
   */
  toProviderSymbol(symbol: MarketSymbol): string | null {
    switch (symbol.assetClass) {
      case 'stock':
        return symbol.symbol;
      case 'index': {
        const ticker = INDEX_TICKERS[symbol.symbol];
        return ticker ? `I:${ticker}` : null;
      }
      case 'forex':
        return `C:${symbol.base}${symbol.quote}`;
      default:
        return null;
    }
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const ticker = this.requireTicker(symbol);
    const agg = AGGREGATES[req.timeframe];

    const to = Date.now();
    // Widen the window well past the bar count: weekends and holidays mean
    // calendar span and bar count diverge sharply on daily/weekly series.
    const from = req.since ?? to - req.limit * BAR_MS[req.timeframe] * 3;

    const res = await getJson<AggregatesResponse>({
      provider: this.name,
      url:
        `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/` +
        `${agg.multiplier}/${agg.timespan}/${from}/${to}`,
      query: {
        adjusted: 'true',
        sort: 'asc',
        limit: 50_000,
        apiKey: config.market.polygon.apiKey,
      },
    });

    if (res.error) throw new ProviderError(this.name, res.error);
    if (!res.results || res.results.length === 0) return [];

    return normaliseCandles(
      res.results.map((a) => ({
        time: a.t,
        open: num(a.o),
        high: num(a.h),
        low: num(a.l),
        close: num(a.c),
        volume: num(a.v),
      })),
    ).slice(-req.limit);
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const ticker = this.requireTicker(symbol);

    // Indices have no trades, so the snapshot shape differs; fall back to the
    // most recent daily aggregate for them.
    if (symbol.assetClass === 'index') {
      return this.quoteFromAggregates(symbol, ticker);
    }

    const res = await getJson<SnapshotResponse>({
      provider: this.name,
      url: `${BASE_URL}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(ticker)}`,
      query: { apiKey: config.market.polygon.apiKey },
    });

    if (res.error) throw new ProviderError(this.name, res.error);
    const t = res.ticker;
    if (!t) throw new ProviderError(this.name, `No snapshot for ${ticker}`);

    const price = t.lastTrade?.p ?? t.day?.c ?? t.min?.c ?? 0;
    if (!price) throw new ProviderError(this.name, `No price in snapshot for ${ticker}`);

    return {
      symbol: symbol.symbol,
      price,
      change: t.todaysChange ?? 0,
      changePercent: t.todaysChangePerc ?? 0,
      high24h: t.day?.h ?? price,
      low24h: t.day?.l ?? price,
      volume24h: t.day?.v ?? 0,
      timestamp: t.lastTrade?.t ? Math.floor(t.lastTrade.t / 1e6) : Date.now(),
      provider: this.name,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const res = await getJson<{ status?: string }>({
        provider: this.name,
        url: `${BASE_URL}/v1/marketstatus/now`,
        query: { apiKey: config.market.polygon.apiKey },
        attempts: 1,
        timeoutMs: 5_000,
      });
      return typeof res.status === 'string';
    } catch {
      return false;
    }
  }

  /**
   * Derive a quote from the last two daily bars.
   *
   * Used for indices, which have no trade snapshot. The previous close is what
   * makes the change figure meaningful, so two bars are required.
   */
  private async quoteFromAggregates(symbol: MarketSymbol, ticker: string): Promise<Quote> {
    const to = Date.now();
    const from = to - 14 * 86_400_000;

    const res = await getJson<AggregatesResponse>({
      provider: this.name,
      url: `${BASE_URL}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}`,
      query: { adjusted: 'true', sort: 'asc', apiKey: config.market.polygon.apiKey },
    });

    const bars = res.results ?? [];
    const last = bars[bars.length - 1];
    if (!last) throw new ProviderError(this.name, `No recent bars for ${ticker}`);
    const prev = bars[bars.length - 2];

    const price = num(last.c);
    const prevClose = prev ? num(prev.c) : num(last.o);

    return {
      symbol: symbol.symbol,
      price,
      change: price - prevClose,
      changePercent: prevClose === 0 ? 0 : ((price - prevClose) / prevClose) * 100,
      high24h: num(last.h),
      low24h: num(last.l),
      volume24h: num(last.v),
      timestamp: last.t,
      provider: this.name,
    };
  }

  private requireTicker(symbol: MarketSymbol): string {
    const ticker = this.toProviderSymbol(symbol);
    if (!ticker) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);
    return ticker;
  }
}

const BAR_MS: Record<Timeframe, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};

/** Index tickers under Polygon's `I:` namespace. */
const INDEX_TICKERS: Record<string, string> = {
  SPX: 'SPX',
  NDX: 'NDX',
  DJI: 'DJI',
};
