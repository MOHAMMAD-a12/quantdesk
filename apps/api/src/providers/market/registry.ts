/**
 * Market data registry.
 *
 * The single entry point for market data. Everything upstream of this file works
 * with canonical symbols and shared types; everything downstream is a
 * replaceable adapter.
 *
 * Responsibilities:
 *
 *  - **Registration.** Only providers reporting `isConfigured()` are registered.
 *    An operator with no keys gets an honest empty registry, not a silently
 *    fabricating one.
 *  - **Routing.** Requests go to the highest-ranked provider that declares
 *    support for the symbol's asset class *and* can express its ticker.
 *  - **Failover.** On provider error the next candidate is tried. Exhausting all
 *    candidates raises `UnsupportedSymbolError` — the platform says "no provider
 *    can serve this" rather than returning made-up numbers.
 *  - **Caching.** Reads are memoised in Redis with a TTL matched to the
 *    timeframe, because a 1-day candle does not change every five seconds.
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
import { UnsupportedSymbolError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import { CacheKeys, CacheTtl, cacheWrap } from '../../db/redis.js';
import { AlphaVantageProvider } from './alphavantage.js';
import { BinanceProvider } from './binance.js';
import { BybitProvider } from './bybit.js';
import { CoinbaseProvider } from './coinbase.js';
import { FinnhubProvider } from './finnhub.js';
import { PolygonProvider } from './polygon.js';
import { SyntheticProvider } from './synthetic.js';
import { TwelveDataProvider } from './twelvedata.js';
import type { MarketDataProvider, MarketProviderName } from './types.js';

const log = moduleLogger('market:registry');

/**
 * Preference order per asset class.
 *
 * Ranked by data quality and cost: free-and-deep first, metered later,
 * `synthetic` always last. The registry filters this list down to what is
 * actually configured.
 */
const ROUTING: Record<AssetClass, MarketProviderName[]> = {
  crypto: ['binance', 'bybit', 'coinbase', 'synthetic'],
  forex: ['twelvedata', 'polygon', 'finnhub', 'alphavantage', 'synthetic'],
  stock: ['polygon', 'finnhub', 'twelvedata', 'alphavantage', 'synthetic'],
  index: ['polygon', 'twelvedata', 'synthetic'],
  commodity: ['twelvedata', 'alphavantage', 'synthetic'],
};

/** Every adapter the platform ships. Adding one means adding it here. */
function allProviders(): MarketDataProvider[] {
  return [
    new BinanceProvider(),
    new BybitProvider(),
    new CoinbaseProvider(),
    new TwelveDataProvider(),
    new FinnhubProvider(),
    new PolygonProvider(),
    new AlphaVantageProvider(),
    new SyntheticProvider(),
  ];
}

class MarketRegistry {
  private providers = new Map<MarketProviderName, MarketDataProvider>();
  private initialised = false;

  /**
   * Register the configured providers.
   *
   * Called at boot and again whenever the admin panel changes credentials, so
   * enabling a provider takes effect without a restart.
   */
  init(): void {
    this.providers.clear();

    for (const provider of allProviders()) {
      if (!provider.isConfigured()) continue;
      this.providers.set(provider.name, provider);
    }

    this.initialised = true;

    const names = [...this.providers.keys()];
    if (names.length === 0) {
      log.error(
        'No market data provider is configured. Market endpoints will return ' +
          'UNSUPPORTED_SYMBOL until a provider is set up in .env or the admin panel.',
      );
    } else {
      log.info({ providers: names }, 'Market data providers registered');
    }
  }

  private ensureInit(): void {
    if (!this.initialised) this.init();
  }

  /** Registered provider names, in registration order. */
  listProviders(): MarketProviderName[] {
    this.ensureInit();
    return [...this.providers.keys()];
  }

  get(name: MarketProviderName): MarketDataProvider | null {
    this.ensureInit();
    return this.providers.get(name) ?? null;
  }

  /** True when at least one real (non-synthetic) provider is available. */
  hasLiveProvider(): boolean {
    this.ensureInit();
    return [...this.providers.keys()].some((n) => n !== 'synthetic');
  }

  /**
   * Candidate providers for a symbol, best first.
   *
   * A symbol's `preferredProvider` (set per-symbol in the admin panel) is
   * promoted to the front when it is registered and capable — operator intent
   * outranks the default ranking.
   */
  candidatesFor(
    symbol: MarketSymbol,
    capability?: keyof MarketDataProvider['capabilities'],
    preferred?: string | null,
  ): MarketDataProvider[] {
    this.ensureInit();

    const ranked = ROUTING[symbol.assetClass] ?? ['synthetic'];
    const ordered = preferred
      ? [preferred as MarketProviderName, ...ranked.filter((n) => n !== preferred)]
      : ranked;

    const out: MarketDataProvider[] = [];
    for (const name of ordered) {
      const provider = this.providers.get(name);
      if (!provider) continue;
      if (!provider.supports(symbol.assetClass)) continue;
      if (capability && !provider.capabilities[capability]) continue;
      // Can this provider even name the instrument?
      if (provider.toProviderSymbol(symbol) === null) continue;
      out.push(provider);
    }
    return out;
  }

  /**
   * Try each candidate in order, returning the first success.
   *
   * Errors are collected rather than thrown immediately: a rate-limited primary
   * should hand off to the secondary, and the caller only cares that *no*
   * provider could serve the request.
   */
  private async withFailover<T>(
    symbol: MarketSymbol,
    capability: keyof MarketDataProvider['capabilities'],
    operation: string,
    fn: (provider: MarketDataProvider) => Promise<T>,
    preferred?: string | null,
  ): Promise<T> {
    const candidates = this.candidatesFor(symbol, capability, preferred);

    if (candidates.length === 0) {
      throw new UnsupportedSymbolError(symbol.symbol);
    }

    const failures: string[] = [];

    for (const provider of candidates) {
      try {
        const result = await fn(provider);
        // An empty candle array is a legitimate "no data here" for this
        // provider, so treat it as a failure worth failing over from.
        if (Array.isArray(result) && result.length === 0) {
          failures.push(`${provider.name}: empty result`);
          continue;
        }
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${message}`);
        log.warn(
          { provider: provider.name, symbol: symbol.symbol, operation, err },
          'Provider failed — trying next',
        );
      }
    }

    log.error(
      { symbol: symbol.symbol, operation, failures },
      'All market data providers failed',
    );
    throw new UnsupportedSymbolError(symbol.symbol);
  }

  /**
   * Candles, cached.
   *
   * The TTL is short for intraday and long for daily+: refetching a 1d bar every
   * 20 seconds spends rate limit on data that changes once a day.
   */
  async getCandles(
    symbol: MarketSymbol,
    timeframe: Timeframe,
    limit = 500,
    preferred?: string | null,
  ): Promise<Candle[]> {
    const ttl =
      timeframe === '1d' || timeframe === '1w' ? CacheTtl.candlesDaily : CacheTtl.candlesIntraday;

    return cacheWrap(CacheKeys.candles(symbol.symbol, timeframe, limit), ttl, () =>
      this.withFailover(
        symbol,
        'candles',
        'candles',
        (p) => p.fetchCandles(symbol, { symbol: symbol.symbol, timeframe, limit }),
        preferred,
      ),
    );
  }

  async getQuote(symbol: MarketSymbol, preferred?: string | null): Promise<Quote> {
    return cacheWrap(CacheKeys.quote(symbol.symbol), CacheTtl.quote, () =>
      this.withFailover(symbol, 'quotes', 'quote', (p) => p.fetchQuote(symbol), preferred),
    );
  }

  /**
   * Quotes for many symbols.
   *
   * Symbols are grouped by the provider that would serve them so batch-capable
   * providers make one call for their whole group. A per-symbol loop here would
   * turn a 17-symbol dashboard into 17 upstream requests.
   */
  async getQuotes(symbols: MarketSymbol[]): Promise<Quote[]> {
    this.ensureInit();
    if (symbols.length === 0) return [];

    const groups = new Map<MarketProviderName, { provider: MarketDataProvider; symbols: MarketSymbol[] }>();
    const unroutable: MarketSymbol[] = [];

    for (const symbol of symbols) {
      const [best] = this.candidatesFor(symbol, 'quotes');
      if (!best) {
        unroutable.push(symbol);
        continue;
      }
      const group = groups.get(best.name);
      if (group) group.symbols.push(symbol);
      else groups.set(best.name, { provider: best, symbols: [symbol] });
    }

    if (unroutable.length > 0) {
      log.warn(
        { symbols: unroutable.map((s) => s.symbol) },
        'No provider can serve these symbols — omitted from the quote batch',
      );
    }

    const results = await Promise.allSettled(
      [...groups.values()].map(async ({ provider, symbols: group }) => {
        if (provider.capabilities.batchQuotes && provider.fetchQuotes) {
          return provider.fetchQuotes(group);
        }
        // No batch support: fetch individually but tolerate partial failure, so
        // one dead ticker does not blank the dashboard.
        const settled = await Promise.allSettled(
          group.map((s) => this.getQuote(s).catch(() => null)),
        );
        return settled
          .filter((r): r is PromiseFulfilledResult<Quote | null> => r.status === 'fulfilled')
          .map((r) => r.value)
          .filter((q): q is Quote => q !== null);
      }),
    );

    const quotes: Quote[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') quotes.push(...r.value);
      else log.warn({ err: r.reason }, 'Quote group failed');
    }
    return quotes;
  }

  /**
   * Derivatives context. Returns null rather than throwing: funding rate and
   * open interest are enrichment, and an equity has none by definition.
   */
  async getDerivatives(symbol: MarketSymbol): Promise<DerivativesContext | null> {
    if (symbol.assetClass !== 'crypto') return null;

    try {
      return await cacheWrap(CacheKeys.derivatives(symbol.symbol), CacheTtl.derivatives, () =>
        this.withFailover(symbol, 'derivatives', 'derivatives', async (p) => {
          if (!p.fetchDerivatives) throw new Error('not supported');
          return p.fetchDerivatives(symbol);
        }),
      );
    } catch {
      return null;
    }
  }

  async getOrderBook(symbol: MarketSymbol, depth = 50): Promise<OrderBook | null> {
    try {
      return await this.withFailover(symbol, 'orderBook', 'orderBook', async (p) => {
        if (!p.fetchOrderBook) throw new Error('not supported');
        return p.fetchOrderBook(symbol, depth);
      });
    } catch {
      return null;
    }
  }

  /** Provider health for the admin panel. */
  async healthReport(): Promise<
    Array<{ name: MarketProviderName; configured: boolean; reachable: boolean }>
  > {
    const checks = allProviders().map(async (p) => {
      const configured = p.isConfigured();
      return {
        name: p.name,
        configured,
        reachable: configured ? await p.healthCheck().catch(() => false) : false,
      };
    });
    return Promise.all(checks);
  }
}

/** Process-wide singleton. */
export const marketRegistry = new MarketRegistry();
