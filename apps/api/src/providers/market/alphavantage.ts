/**
 * Alpha Vantage adapter.
 *
 * The last-resort non-crypto provider. Its free tier allows roughly 25 requests
 * per day, which cannot sustain live analysis — it exists so an operator with
 * only this key still gets *real* data for occasional lookups rather than
 * nothing, and the registry ranks it last for exactly that reason.
 *
 * The response shape is the most awkward of the seven: keys are human-readable
 * strings including their own numbering (`"1. open"`), and the series is a
 * date-keyed object rather than an array.
 *
 * Requires `MARKET_ALPHAVANTAGE_API_KEY`.
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

const BASE_URL = 'https://www.alphavantage.co/query';

/** Intraday intervals Alpha Vantage accepts. Others must be resampled. */
const INTRADAY_INTERVALS: Partial<Record<Timeframe, string>> = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min',
};

/** A bar object with Alpha Vantage's numbered keys. */
interface RawBar {
  '1. open': string;
  '2. high': string;
  '3. low': string;
  '4. close': string;
  '5. volume'?: string;
  /** FX series use "4. close" but omit volume entirely. */
  '6. volume'?: string;
}

/** Errors and throttling arrive as prose in these fields, with HTTP 200. */
interface ErrorEnvelope {
  'Error Message'?: string;
  Note?: string;
  Information?: string;
}

type SeriesResponse = ErrorEnvelope & Record<string, unknown>;

interface GlobalQuoteResponse extends ErrorEnvelope {
  'Global Quote'?: {
    '05. price': string;
    '06. volume': string;
    '08. previous close': string;
    '09. change': string;
    '10. change percent': string;
    '03. high': string;
    '04. low': string;
  };
}

export class AlphaVantageProvider implements MarketDataProvider {
  readonly name = 'alphavantage' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: false,
    orderBook: false,
    derivatives: false,
    websocket: false,
  };

  isConfigured(): boolean {
    return Boolean(config.market.alphaVantage.apiKey);
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'stock' || assetClass === 'forex' || assetClass === 'commodity';
  }

  toProviderSymbol(symbol: MarketSymbol): string | null {
    switch (symbol.assetClass) {
      case 'stock':
        return symbol.symbol;
      case 'forex':
      case 'commodity':
        // FX endpoints take from/to separately; the pair form is only a label.
        return `${symbol.base}${symbol.quote}`;
      default:
        return null;
    }
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const isFx = symbol.assetClass === 'forex' || symbol.assetClass === 'commodity';
    const intraday = INTRADAY_INTERVALS[req.timeframe];

    // Weekly is requested as daily and aggregated: the native weekly series
    // returns too little history for a 200-period average.
    const fn = this.resolveFunction(isFx, intraday !== undefined, req.timeframe);

    const query: Record<string, string | number | undefined> = {
      function: fn,
      apikey: config.market.alphaVantage.apiKey,
      outputsize: 'full',
    };

    if (isFx) {
      query.from_symbol = symbol.base;
      query.to_symbol = symbol.quote;
    } else {
      query.symbol = symbol.symbol;
    }
    if (intraday) query.interval = intraday;

    const res = await getJson<SeriesResponse>({
      provider: this.name,
      url: BASE_URL,
      query,
      // Rate limits here are daily, not per-second: retrying a throttled call
      // burns the remaining budget without any chance of succeeding.
      attempts: 1,
      timeoutMs: 15_000,
    });

    this.assertOk(res);

    const series = findSeries(res);
    if (!series) return [];

    const candles = normaliseCandles(
      Object.entries(series).map(([datetime, bar]) => ({
        // Intraday timestamps are US/Eastern without an offset; daily are dates.
        // Treating both as UTC keeps bars self-consistent, and the analysis is
        // relative (bar-to-bar) rather than absolute wall-clock.
        time: Date.parse(datetime.includes(' ') ? `${datetime.replace(' ', 'T')}Z` : `${datetime}T00:00:00Z`),
        open: num(bar['1. open']),
        high: num(bar['2. high']),
        low: num(bar['3. low']),
        close: num(bar['4. close']),
        volume: num(bar['5. volume'] ?? bar['6. volume']),
      })),
    );

    const finished = req.timeframe === '4h' || req.timeframe === '1w'
      ? resample(candles, req.timeframe)
      : candles;

    return finished.slice(-req.limit);
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    // FX has no GLOBAL_QUOTE equivalent, so derive it from the daily series.
    if (symbol.assetClass !== 'stock') {
      const candles = await this.fetchCandles(symbol, {
        symbol: symbol.symbol,
        timeframe: '1d',
        limit: 2,
      });
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      if (!last) throw new ProviderError(this.name, `No daily data for ${symbol.symbol}`);
      const prevClose = prev?.close ?? last.open;
      return {
        symbol: symbol.symbol,
        price: last.close,
        change: last.close - prevClose,
        changePercent: prevClose === 0 ? 0 : ((last.close - prevClose) / prevClose) * 100,
        high24h: last.high,
        low24h: last.low,
        volume24h: last.volume,
        timestamp: last.time,
        provider: this.name,
      };
    }

    const res = await getJson<GlobalQuoteResponse>({
      provider: this.name,
      url: BASE_URL,
      query: {
        function: 'GLOBAL_QUOTE',
        symbol: symbol.symbol,
        apikey: config.market.alphaVantage.apiKey,
      },
      attempts: 1,
    });

    this.assertOk(res);
    const q = res['Global Quote'];
    if (!q || !q['05. price']) {
      throw new ProviderError(this.name, `No quote for ${symbol.symbol}`);
    }

    return {
      symbol: symbol.symbol,
      price: num(q['05. price']),
      change: num(q['09. change']),
      // Arrives as e.g. "1.2345%" — strip the sign character before parsing.
      changePercent: num(q['10. change percent'].replace('%', '')),
      high24h: num(q['03. high']),
      low24h: num(q['04. low']),
      volume24h: num(q['06. volume']),
      timestamp: Date.now(),
      provider: this.name,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const res = await getJson<GlobalQuoteResponse>({
        provider: this.name,
        url: BASE_URL,
        query: {
          function: 'GLOBAL_QUOTE',
          symbol: 'AAPL',
          apikey: config.market.alphaVantage.apiKey,
        },
        attempts: 1,
        timeoutMs: 6_000,
      });
      // A throttle note means the key is valid but exhausted — still "reachable",
      // and reporting false would hide the real reason from the admin panel.
      return Boolean(res['Global Quote'] ?? res.Note);
    } catch {
      return false;
    }
  }

  private resolveFunction(isFx: boolean, isIntraday: boolean, timeframe: Timeframe): string {
    if (isFx) return isIntraday ? 'FX_INTRADAY' : 'FX_DAILY';
    if (isIntraday) return 'TIME_SERIES_INTRADAY';
    // 4h is built from 60min elsewhere; 1d/1w both start from the daily series.
    return timeframe === '1w' || timeframe === '1d' || timeframe === '4h'
      ? 'TIME_SERIES_DAILY'
      : 'TIME_SERIES_DAILY';
  }

  private assertOk(res: ErrorEnvelope): void {
    if (res['Error Message']) throw new ProviderError(this.name, res['Error Message']);
    // `Note` is the daily-limit message; `Information` covers premium-only calls.
    if (res.Note) throw new ProviderError(this.name, `Rate limited: ${res.Note}`);
    if (res.Information) throw new ProviderError(this.name, res.Information);
  }
}

/**
 * Locate the series object without hardcoding its key.
 *
 * The key varies by function and interval — "Time Series (5min)", "Time Series
 * (Daily)", "Time Series FX (Daily)". Matching on the shape is more robust than
 * enumerating every spelling.
 */
function findSeries(res: SeriesResponse): Record<string, RawBar> | null {
  for (const [key, value] of Object.entries(res)) {
    if (!key.toLowerCase().includes('time series')) continue;
    if (typeof value === 'object' && value !== null) {
      return value as Record<string, RawBar>;
    }
  }
  return null;
}

/** Aggregate daily/hourly bars into 4h or 1w buckets. */
function resample(candles: Candle[], timeframe: '4h' | '1w'): Candle[] {
  const targetMs = timeframe === '4h' ? 14_400_000 : 604_800_000;
  const buckets = new Map<number, Candle>();

  for (const c of candles) {
    const bucketTime =
      timeframe === '1w'
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
