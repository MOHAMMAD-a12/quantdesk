/**
 * Finnhub adapter.
 *
 * Strong on US equities and it also backs the news module, so a single key
 * serves two subsystems. Free tiers restrict intraday candle history, which the
 * registry accounts for by preferring Polygon or Twelve Data when both are
 * configured.
 *
 * Requires `MARKET_FINNHUB_API_KEY`.
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

const BASE_URL = 'https://finnhub.io/api/v1';

/** Finnhub resolutions: minutes as digits, then D/W. */
const RESOLUTIONS: Record<Timeframe, string> = {
  '1m': '1',
  '5m': '5',
  '15m': '15',
  '30m': '30',
  '1h': '60',
  // No native 4h — resampled from 60m below.
  '4h': '60',
  '1d': 'D',
  '1w': 'W',
};

/** Columnar response: parallel arrays plus a status field. */
interface RawCandles {
  s: 'ok' | 'no_data';
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}

interface RawQuote {
  c: number; // current
  d: number | null; // change
  dp: number | null; // percent change
  h: number; // high
  l: number; // low
  o: number; // open
  pc: number; // previous close
  t: number; // unix seconds
}

export class FinnhubProvider implements MarketDataProvider {
  readonly name = 'finnhub' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    // Finnhub's quote endpoint is one symbol per call.
    batchQuotes: false,
    orderBook: false,
    derivatives: false,
    websocket: true,
  };

  isConfigured(): boolean {
    return Boolean(config.market.finnhub.apiKey);
  }

  supports(assetClass: AssetClass): boolean {
    return assetClass === 'stock' || assetClass === 'forex';
  }

  toProviderSymbol(symbol: MarketSymbol): string | null {
    if (symbol.assetClass === 'stock') return symbol.symbol;
    // FX uses an exchange-prefixed form.
    if (symbol.assetClass === 'forex') return `OANDA:${symbol.base}_${symbol.quote}`;
    return null;
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    const ticker = this.requireTicker(symbol);
    const resolution = RESOLUTIONS[req.timeframe];

    // Finnhub requires an explicit window, so derive one from the bar count.
    const perBarMs = BAR_MS[req.timeframe];
    const to = Math.floor(Date.now() / 1000);
    // Over-fetch: exchange closures mean calendar time yields fewer bars than
    // the arithmetic suggests, and a short series breaks the 200-EMA.
    const spanSec = Math.ceil((req.limit * perBarMs * 2.5) / 1000);
    const from = req.since ? Math.floor(req.since / 1000) : to - spanSec;

    const endpoint = symbol.assetClass === 'forex' ? 'forex/candle' : 'stock/candle';

    const res = await getJson<RawCandles>({
      provider: this.name,
      url: `${BASE_URL}/${endpoint}`,
      query: { symbol: ticker, resolution, from, to, token: config.market.finnhub.apiKey },
    });

    if (res.s === 'no_data' || !res.t || res.t.length === 0) return [];

    const candles = normaliseCandles(
      res.t.map((time, i) => ({
        time: time * 1000,
        open: num(res.o?.[i]),
        high: num(res.h?.[i]),
        low: num(res.l?.[i]),
        close: num(res.c?.[i]),
        volume: num(res.v?.[i]),
      })),
    );

    const finalCandles = req.timeframe === '4h' ? resampleTo4h(candles) : candles;
    return finalCandles.slice(-req.limit);
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    const ticker = this.requireTicker(symbol);

    const q = await getJson<RawQuote>({
      provider: this.name,
      url: `${BASE_URL}/quote`,
      query: { symbol: ticker, token: config.market.finnhub.apiKey },
    });

    // An unknown ticker returns zeros rather than an error status.
    if (!q.c) throw new ProviderError(this.name, `No quote data for ${ticker}`);

    return {
      symbol: symbol.symbol,
      price: q.c,
      change: q.d ?? q.c - q.pc,
      changePercent: q.dp ?? 0,
      high24h: q.h,
      low24h: q.l,
      // The quote endpoint carries no volume; the candle feed supplies it.
      volume24h: 0,
      timestamp: q.t ? q.t * 1000 : Date.now(),
      provider: this.name,
    };
  }

  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const q = await getJson<RawQuote>({
        provider: this.name,
        url: `${BASE_URL}/quote`,
        query: { symbol: 'AAPL', token: config.market.finnhub.apiKey },
        attempts: 1,
        timeoutMs: 5_000,
      });
      return Number.isFinite(q.c) && q.c > 0;
    } catch {
      return false;
    }
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

/**
 * Aggregate 1h bars into 4h buckets.
 *
 * Buckets align to 00:00 UTC so the boundaries match every other provider's 4h
 * series — otherwise the same instrument would show different candles depending
 * on which provider served it, and an order block found on one would not exist
 * on the other.
 */
function resampleTo4h(hourly: Candle[]): Candle[] {
  const buckets = new Map<number, Candle>();

  for (const c of hourly) {
    const bucketTime = Math.floor(c.time / 14_400_000) * 14_400_000;
    const existing = buckets.get(bucketTime);
    if (!existing) {
      buckets.set(bucketTime, { ...c, time: bucketTime });
      continue;
    }
    existing.high = Math.max(existing.high, c.high);
    existing.low = Math.min(existing.low, c.low);
    // Bars arrive ascending, so the last write is the bucket's close.
    existing.close = c.close;
    existing.volume += c.volume;
  }

  return [...buckets.values()].sort((a, b) => a.time - b.time);
}
