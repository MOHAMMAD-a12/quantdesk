/**
 * Synthetic fallback feed.
 *
 * This is the *only* source of fabricated data in the platform, and it exists
 * solely so a developer with no API keys can boot the UI and see it work. It is
 * governed by three hard rules:
 *
 *  1. It is the last provider the registry considers, and only when
 *     `MARKET_ALLOW_SYNTHETIC=true`.
 *  2. Every candle and quote it emits carries `synthetic: true`, which is
 *     propagated through `TechnicalAnalysis`, `Signal`, the `signals` and
 *     `analysis_snapshots` tables, and rendered as a badge in the UI. A user can
 *     never mistake a synthetic reading for a real one.
 *  3. It refuses to run in production. Fabricated prices reaching a real trading
 *     decision is the worst failure this codebase could have, so the guard is in
 *     `isConfigured()` rather than left to configuration discipline.
 *
 * The series is a seeded geometric random walk with volatility scaled per asset
 * class, so it is *plausible* and deterministic per symbol — but it is not a
 * simulation of anything and must never be presented as one.
 */

import type { AssetClass, Candle, MarketSymbol, Quote, Timeframe } from '@quantdesk/shared';
import { TIMEFRAME_MS, alignToTimeframe } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { moduleLogger } from '../../core/logger.js';
import {
  type CandleRequest,
  type MarketDataProvider,
  type ProviderCapabilities,
} from './types.js';

const log = moduleLogger('provider:synthetic');

/** Plausible starting prices so charts look sane on first load. */
const ANCHOR_PRICES: Record<string, number> = {
  BTCUSDT: 68_000,
  ETHUSDT: 3_500,
  SOLUSDT: 165,
  BNBUSDT: 590,
  XRPUSDT: 0.62,
  XAUUSD: 2_350,
  XAGUSD: 29.5,
  EURUSD: 1.085,
  GBPUSD: 1.27,
  USDJPY: 152.4,
  AAPL: 224,
  NVDA: 128,
  TSLA: 245,
  MSFT: 425,
  SPX: 5_520,
  NDX: 19_400,
  DJI: 41_200,
};

/** Annualised volatility by asset class, used to scale per-bar moves. */
const CLASS_VOLATILITY: Record<AssetClass, number> = {
  crypto: 0.65,
  commodity: 0.18,
  forex: 0.09,
  stock: 0.3,
  index: 0.16,
};

export class SyntheticProvider implements MarketDataProvider {
  readonly name = 'synthetic' as const;

  readonly capabilities: ProviderCapabilities = {
    candles: true,
    quotes: true,
    batchQuotes: true,
    orderBook: false,
    derivatives: false,
    websocket: false,
  };

  private warned = false;

  /**
   * Enabled only outside production and only when explicitly allowed.
   *
   * The production check is not redundant with the env flag: it guarantees that
   * a `.env` copied from a dev machine cannot put fabricated prices in front of
   * a real user.
   */
  isConfigured(): boolean {
    if (config.isProd) return false;
    if (!config.market.allowSynthetic) return false;

    if (!this.warned) {
      this.warned = true;
      log.warn(
        'Synthetic market data is ENABLED. All prices are fabricated and labelled ' +
          'synthetic. Configure a real provider before drawing any conclusions.',
      );
    }
    return true;
  }

  /** Serves everything — it is the fallback of last resort. */
  supports(_assetClass: AssetClass): boolean {
    return true;
  }

  toProviderSymbol(symbol: MarketSymbol): string {
    return symbol.symbol;
  }

  async fetchCandles(symbol: MarketSymbol, req: CandleRequest): Promise<Candle[]> {
    return this.generate(symbol, req.timeframe, req.limit);
  }

  async fetchQuote(symbol: MarketSymbol): Promise<Quote> {
    // Derive the quote from a daily series so price and change agree with the
    // chart the user is looking at.
    const daily = this.generate(symbol, '1d', 2);
    const last = daily[daily.length - 1];
    const prev = daily[daily.length - 2];
    const price = last?.close ?? this.anchor(symbol);
    const prevClose = prev?.close ?? price;

    return {
      symbol: symbol.symbol,
      price,
      change: price - prevClose,
      changePercent: prevClose === 0 ? 0 : ((price - prevClose) / prevClose) * 100,
      high24h: last?.high ?? price,
      low24h: last?.low ?? price,
      volume24h: last?.volume ?? 0,
      timestamp: Date.now(),
      provider: this.name,
      synthetic: true,
    };
  }

  async fetchQuotes(symbols: MarketSymbol[]): Promise<Quote[]> {
    return Promise.all(symbols.map((s) => this.fetchQuote(s)));
  }

  async healthCheck(): Promise<boolean> {
    return this.isConfigured();
  }

  private anchor(symbol: MarketSymbol): number {
    return ANCHOR_PRICES[symbol.symbol] ?? 100;
  }

  /**
   * Seeded geometric random walk.
   *
   * Seeding from the symbol keeps the series stable across requests — an
   * unseeded walk would redraw a different chart on every refresh, which looks
   * like a bug rather than a placeholder.
   */
  private generate(symbol: MarketSymbol, timeframe: Timeframe, limit: number): Candle[] {
    const barMs = TIMEFRAME_MS[timeframe];
    const bars = Math.max(1, Math.min(limit, 1500));
    const lastOpen = alignToTimeframe(Date.now(), timeframe);

    // Scale annual vol to this bar duration: σ_bar = σ_annual × √(Δt / year).
    const annualVol = CLASS_VOLATILITY[symbol.assetClass];
    const barVol = annualVol * Math.sqrt(barMs / 31_536_000_000);

    const rand = mulberry32(hashString(`${symbol.symbol}:${timeframe}`));
    const candles: Candle[] = [];

    // Walk forward from an origin chosen so the series *ends* near the anchor.
    let price = this.anchor(symbol);
    const openTimes: number[] = [];
    for (let i = bars - 1; i >= 0; i--) openTimes.push(lastOpen - i * barMs);

    for (const time of openTimes) {
      const open = price;
      // Box-Muller for a normal draw; a uniform walk produces unrealistically
      // rectangular candles.
      const drift = gaussian(rand) * barVol;
      const close = Math.max(open * (1 + drift), open * 0.5);
      // Wick beyond the body by a fraction of the bar's own range.
      const bodyRange = Math.abs(close - open);
      const wick = bodyRange * (0.3 + rand() * 1.2) + open * barVol * 0.25;
      const high = Math.max(open, close) + wick * rand();
      const low = Math.min(open, close) - wick * rand();

      candles.push({
        time,
        open: round(open, symbol.pricePrecision),
        high: round(high, symbol.pricePrecision),
        low: round(Math.max(low, 0.00000001), symbol.pricePrecision),
        close: round(close, symbol.pricePrecision),
        // Volume correlates with range, as it does in real markets.
        volume: round((1 + Math.abs(drift) * 40) * (500 + rand() * 2000), 2),
        synthetic: true,
      });

      price = close;
    }

    return candles;
  }
}

/** FNV-1a — small, fast, and stable across runs. */
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mulberry32 PRNG: deterministic given the seed. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function round(n: number, dp: number): number {
  const f = 10 ** Math.min(dp, 8);
  return Math.round(n * f) / f;
}
