/**
 * Twelve Data adapter.
 *
 * The widest-coverage non-crypto source: forex, equities, indices and metals
 * from one API and one key. That breadth makes it the default router target for
 * everything Binance and Bybit cannot price.
 *
 * Requires `MARKET_TWELVEDATA_API_KEY`. Without it the adapter reports
 * unconfigured and the registry never routes to it — the platform surfaces "no
 * provider for XAUUSD" rather than inventing a gold price.
 */

import type {
  AssetClass,
  Candle,
  MarketSymbol,
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

const BASE_URL = 'https://api.twelvedata.com';

const INTERVALS: Record<Timeframe, string> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
  '1w': '1week',
};

interface RawBar {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TimeSeriesResponse {
  status?: string;
  message?: string;
  code?: number;
  values?: RawBar[];
  meta?: { symbol: string; interval: string; exchange_timezone?: string };
}

interface QuoteResponse {
  status?: string;
  message?: string;
  code?: number;
  symbol?: string;
  close?: string;
  previous_close?: string;
  change?: string;
  percent_change?: string;
  high?: string;
  low?: string;
  volume?: string;
  timestamp?: number;
}

export class TwelveDataProvider implements MarketDataProvider {
  readonly name = 'twelvedata' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: true,
    orderBook: false,
    derivatives: false,
    websocket: false,
  };

  isConfigured(): boolean {
    return Boolean(config.market.twelveData.apiKey);
  }

  supports(assetClass: AssetClass): boolean {
    // Crypto is possible here too, but Binance/Bybit are free and deeper —
    // reserve the metered key for what only this provider can serve.
    return (
      assetClass === 'forex' ||
      assetClass === 'stock' ||
      assetClass === 'index' ||
      assetClass === 'commodity'
    );
  }

  /**
   * Twelve Data uses slash-separated pairs for FX and metals (`EUR/USD`,
   * `XAU/USD`) but bare tickers for equities, and index symbols are prefixed
   * with a caret.
   */
  toProviderSymbol(symbol: MarketSymbol): string | null {
    switch (symbol.assetClass) {
      case 'forex':
      case 'commodity':
        return `${symbol.base}/${symbol.quote}`;
      case 'stock':
        return symbol.symbol;
      case 'index':
        return INDEX_TICKERS[symbol.symbol] ?? null;
      default:
        return null;
    }
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const ticker = this.requireTicker(symbol);

    const res = await getJson<TimeSeriesResponse>({
      provider: this.name,
      url: `${BASE_URL}/time_series`,
      query: {
        symbol: ticker,
        interval: INTERVALS[req.timeframe],
        outputsize: Math.min(req.limit, 5000),
        apikey: config.market.twelveData.apiKey,
        // Force UTC so bar timestamps align with the crypto feeds.
        timezone: 'UTC',
        order: 'ASC',
      },
    });

    this.assertOk(res);

    return normaliseCandles(
      (res.values ?? []).map((b) => ({
        // `datetime` is UTC per the query above; append Z so Date parses it as
        // such rather than as local time.
        time: Date.parse(b.datetime.includes('T') ? `${b.datetime}Z` : `${b.datetime}T00:00:00Z`),
        open: num(b.open),
        high: num(b.high),
        low: num(b.low),
        close: num(b.close),
        // Indices and FX report no volume; 0 is honest, not a gap.
        volume: num(b.volume),
      })),
    );
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const ticker = this.requireTicker(symbol);

    const res = await getJson<QuoteResponse>({
      provider: this.name,
      url: `${BASE_URL}/quote`,
      query: { symbol: ticker, apikey: config.market.twelveData.apiKey, timezone: 'UTC' },
    });

    this.assertOk(res);
    return this.toQuote(symbol.symbol, res);
  }

  /**
   * Comma-separated symbols return a keyed object rather than an array — one
   * request instead of N, which matters on a metered plan.
   */
  async fetchQuotes(symbols: MarketSymbol[]): Promise<Quote[]> {
    const wanted = new Map<string, string>();
    for (const s of symbols) {
      const ticker = this.toProviderSymbol(s);
      if (ticker) wanted.set(ticker, s.symbol);
    }
    if (wanted.size === 0) return [];

    const tickers = [...wanted.keys()];
    if (tickers.length === 1) {
      const only = tickers[0] as string;
      const canonical = wanted.get(only) as string;
      const res = await getJson<QuoteResponse>({
        provider: this.name,
        url: `${BASE_URL}/quote`,
        query: { symbol: only, apikey: config.market.twelveData.apiKey, timezone: 'UTC' },
      });
      this.assertOk(res);
      return [this.toQuote(canonical, res)];
    }

    const res = await getJson<Record<string, QuoteResponse>>({
      provider: this.name,
      url: `${BASE_URL}/quote`,
      query: {
        symbol: tickers.join(','),
        apikey: config.market.twelveData.apiKey,
        timezone: 'UTC',
      },
    });

    const out: Quote[] = [];
    for (const [ticker, canonical] of wanted) {
      const q = res[ticker];
      // A per-symbol failure inside a batch must not void the whole batch.
      if (q && q.status !== 'error' && q.close !== undefined) {
        out.push(this.toQuote(canonical, q));
      }
    }
    return out;
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const res = await getJson<QuoteResponse>({
        provider: this.name,
        url: `${BASE_URL}/quote`,
        query: { symbol: 'EUR/USD', apikey: config.market.twelveData.apiKey },
        attempts: 1,
        timeoutMs: 5_000,
      });
      return res.status !== 'error';
    } catch {
      return false;
    }
  }

  private requireTicker(symbol: MarketSymbol): string {
    const ticker = this.toProviderSymbol(symbol);
    if (!ticker) throw new ProviderError(this.name, `Cannot express ${symbol.symbol}`);
    return ticker;
  }

  /**
   * Twelve Data signals errors in the body with HTTP 200 — notably code 429 for
   * plan limits, which is worth reading rather than treating as an empty series.
   */
  private assertOk(res: { status?: string; message?: string; code?: number }): void {
    if (res.status === 'error') {
      throw new ProviderError(this.name, res.message ?? `error code ${res.code ?? 'unknown'}`);
    }
  }

  private toQuote(canonicalSymbol: string, q: QuoteResponse): Quote {
    const price = num(q.close);
    const prev = num(q.previous_close);
    return {
      symbol: canonicalSymbol,
      price,
      change: q.change !== undefined ? num(q.change) : price - prev,
      changePercent: num(q.percent_change),
      high24h: num(q.high, price),
      low24h: num(q.low, price),
      volume24h: num(q.volume),
      timestamp: q.timestamp ? q.timestamp * 1000 : Date.now(),
      provider: this.name,
    };
  }
}

/** Index tickers as Twelve Data names them. */
const INDEX_TICKERS: Record<string, string> = {
  SPX: 'GSPC',
  NDX: 'NDX',
  DJI: 'DJI',
};
