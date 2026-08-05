/**
 * The market data provider contract.
 *
 * Every upstream — Binance, Bybit, Coinbase, Twelve Data, Finnhub, Polygon,
 * Alpha Vantage — is reduced to this interface. The analysis engine, the signal
 * generator and the API routes are written against it and never import a
 * concrete adapter, so swapping or adding a provider touches only this
 * directory.
 *
 * Two rules keep adapters honest:
 *
 *  1. **Declare, don't guess.** An adapter states which asset classes it serves
 *     via `supports()`. The registry routes on that declaration instead of
 *     trying providers blindly and interpreting failures.
 *  2. **Normalise fully.** Returned candles are ascending by time, gap-free at
 *     the provider's granularity, and use the shared `Candle` shape. Upstream
 *     quirks (Binance's string numerics, Polygon's `t/o/h/l/c/v` keys, Alpha
 *     Vantage's nested date maps) never escape the adapter.
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

/** Identifiers for the shipped adapters. */
export const MARKET_PROVIDERS = [
  'binance',
  'bybit',
  'coinbase',
  'twelvedata',
  'finnhub',
  'polygon',
  'alphavantage',
  'synthetic',
] as const;

export type MarketProviderName = (typeof MARKET_PROVIDERS)[number];

export interface CandleRequest {
  symbol: string;
  timeframe: Timeframe;
  /** Maximum bars to return, most recent last. */
  limit: number;
  /** Optional inclusive lower bound, epoch ms. */
  since?: number;
}

/**
 * What a provider can do.
 *
 * Capabilities are checked before dispatch so the registry never asks Alpha
 * Vantage for a funding rate.
 */
export interface ProviderCapabilities {
  candles: boolean;
  quotes: boolean;
  /** Batch quote fetch — avoids N round-trips on the dashboard. */
  batchQuotes: boolean;
  orderBook: boolean;
  /** Funding rate / open interest. Crypto venues only. */
  derivatives: boolean;
  /** Live push feed rather than polling. */
  websocket: boolean;
}

export interface MarketDataProvider {
  readonly name: MarketProviderName;

  /**
   * Whether this provider is usable *right now* — configured with credentials
   * where required and enabled by the operator.
   *
   * An unconfigured provider reports false and is never registered, which is how
   * the platform degrades instead of emitting fabricated data.
   */
  isConfigured(): boolean;

  readonly capabilities: ProviderCapabilities;

  /** Asset classes this provider can price. */
  supports(assetClass: AssetClass): boolean;

  /**
   * Translate the platform's canonical symbol into the provider's own.
   * Returns null when this provider cannot express the instrument at all —
   * e.g. Binance has no ticker for `SPX`.
   */
  toProviderSymbol(symbol: MarketSymbol): string | null;

  fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]>;

  fetchQuote(symbol: MarketSymbol): Promise<Quote>;

  /** Only called when `capabilities.batchQuotes` is true. */
  fetchQuotes?(symbols: MarketSymbol[]): Promise<Quote[]>;

  fetchOrderBook?(symbol: MarketSymbol, depth: number): Promise<OrderBook>;

  fetchDerivatives?(symbol: MarketSymbol): Promise<DerivativesContext>;

  /** Cheap liveness probe for the admin panel's provider health view. */
  healthCheck(): Promise<boolean>;
}

/** Timeframe translation table shared by adapters that use minute counts. */
export const TIMEFRAME_MINUTES: Record<Timeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

/**
 * Guard against a provider returning unusable bars.
 *
 * Corrupt OHLC silently poisons every downstream indicator — an inverted
 * high/low produces a negative true range and a nonsensical ATR, which then sets
 * a stop loss on the wrong side of entry. Rejecting at the boundary keeps the
 * failure legible.
 */
export function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume) &&
    c.high >= c.low &&
    c.high >= c.open &&
    c.high >= c.close &&
    c.low <= c.open &&
    c.low <= c.close &&
    c.open > 0 &&
    c.close > 0 &&
    c.volume >= 0
  );
}

/**
 * Normalise a raw candle series: drop invalid bars, sort ascending, dedupe by
 * open time. Every adapter runs its output through this before returning.
 */
export function normaliseCandles(candles: Candle[]): Candle[] {
  const byTime = new Map<number, Candle>();
  for (const c of candles) {
    if (!isValidCandle(c)) continue;
    // Later wins: providers sometimes resend the forming bar with fresher data.
    byTime.set(c.time, c);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}
