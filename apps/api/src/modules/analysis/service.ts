/**
 * Analysis service — the layer that wires the deterministic engine to provider
 * data and the AI context.
 *
 * This module owns three responsibilities that the pure engine deliberately does
 * not: fetching candles from the market registry, enriching the analysis with
 * news and derivatives context, and caching the result so repeated dashboard
 * polls do not re-compute the same window.
 *
 * The cache is short (45 seconds) by design. An analysis includes the last
 * closed bar, which changes every bar in intraday timeframes — so a 1m read
 * cached for five minutes would show a price that is already four bars stale.
 * Longer caching belongs at the candle layer, where the provider call is what
 * costs time and rate limit.
 */

import type { Candle, Timeframe } from '@quantdesk/shared';
import { TIMEFRAMES } from '@quantdesk/shared';
import {
  type AnalysisInput,
  InsufficientDataError,
  analyse,
  analyseMultiTimeframe,
  computeCorrelations,
} from '../../analysis/index.js';
import { moduleLogger } from '../../core/logger.js';
import { CacheKeys, CacheTtl, cacheWrap } from '../../db/redis.js';
import { marketRegistry } from '../../providers/market/registry.js';
import * as markets from '../markets/repository.js';
import * as news from '../news/index.js';
import * as settings from '../settings/index.js';

const log = moduleLogger('analysis');

export interface AnalyseRequest {
  symbol: string;
  timeframe: Timeframe;
  /** Compute multi-timeframe confirmation. More expensive: one provider call per TF. */
  mtf?: boolean;
  /** Compute correlation against reference symbols. */
  correlations?: boolean;
  correlationSymbols?: string[];
  lookback?: number;
}

/**
 * Run the full analysis for one symbol/timeframe, with provider data and
 * sentiment context.
 *
 * Cached briefly: the dashboard polls this every few seconds, and re-running the
 * engine on the same bars is pure waste once the bar is closed. The TTL is short
 * enough that the next bar's close invalidates it naturally — no need for an
 * explicit purge on every tick.
 *
 * @throws {UnsupportedSymbolError} when the symbol is not in the tradable universe
 * @throws {InsufficientDataError} when there is not enough history
 * @throws {ProviderError} when no market data provider can serve the symbol
 */
export async function analyseSymbol(req: AnalyseRequest) {
  const { symbol, timeframe, mtf = false, correlations = false, lookback = 400 } = req;

  // The cache key includes the flags because they change the output shape.
  const cacheKey = `${CacheKeys.analysis(symbol, timeframe)}:mtf=${mtf ? '1' : '0'}:corr=${correlations ? '1' : '0'}`;

  return cacheWrap(cacheKey, CacheTtl.analysis, async () => {
    const record = await markets.requireSymbol(symbol);
    const config = await settings.getSignalEngineConfig();

    if (mtf) {
      return analyseWithMtf({
        symbol: record.symbol,
        timeframe,
        categoryWeights: config.categoryWeights,
        mtfTimeframes: config.mtfTimeframes,
        lookback,
        correlations,
        correlationSymbols: req.correlationSymbols,
      });
    }

    const candles = await marketRegistry.getCandles(
      record,
      timeframe,
      lookback,
      record.preferredProvider,
    );

    const [derivatives, sentimentSnapshot, fearGreedIndex] = await Promise.all([
      marketRegistry.getDerivatives(record),
      news.sentiment(record.symbol),
      news.fearGreed(),
    ]);

    const input: AnalysisInput = {
      symbol: record.symbol,
      timeframe,
      candles,
      derivatives,
      sentiment: sentimentSnapshot,
      fearGreed: fearGreedIndex,
      categoryWeights: config.categoryWeights,
    };

    if (correlations) {
      const correlationSymbols = req.correlationSymbols ?? DEFAULT_CORRELATION_UNIVERSE;
      input.correlations = await fetchCorrelations(record.symbol, timeframe, correlationSymbols);
    }

    return analyse(input);
  });
}

interface MtfRequest {
  symbol: string;
  timeframe: Timeframe;
  mtfTimeframes: Timeframe[];
  categoryWeights: AnalysisInput['categoryWeights'];
  lookback: number;
  correlations: boolean;
  correlationSymbols?: string[];
}

/**
 * Multi-timeframe analysis.
 *
 * Not cached independently: the single-timeframe path caches each TF on its own
 * key, so this batch benefits from those per-TF caches without needing a
 * combinatorial explosion of batch keys.
 */
async function analyseWithMtf(req: MtfRequest) {
  const {
    symbol,
    timeframe,
    mtfTimeframes,
    categoryWeights,
    lookback,
    correlations,
    correlationSymbols = DEFAULT_CORRELATION_UNIVERSE,
  } = req;

  const record = await markets.requireSymbol(symbol);

  // Fetch all timeframes concurrently. A failure in one TF is tolerated: the
  // engine skips it rather than aborting the batch, so a symbol with no weekly
  // bars can still be analysed on the 1h.
  const candleSets = await Promise.allSettled(
    mtfTimeframes.map(async (tf) => ({
      timeframe: tf,
      candles: await marketRegistry.getCandles(record, tf, lookback, record.preferredProvider),
    })),
  );

  const series = candleSets
    .filter((r): r is PromiseFulfilledResult<{ timeframe: Timeframe; candles: Candle[] }> =>
      r.status === 'fulfilled'
    )
    .map((r) => r.value);

  if (series.length === 0) {
    throw new InsufficientDataError(symbol, timeframe, 0);
  }

  const [derivatives, sentimentSnapshot, fearGreedIndex] = await Promise.all([
    marketRegistry.getDerivatives(record),
    news.sentiment(record.symbol),
    news.fearGreed(),
  ]);

  const base: Omit<AnalysisInput, 'timeframe' | 'candles' | 'mtf'> = {
    symbol: record.symbol,
    derivatives,
    sentiment: sentimentSnapshot,
    fearGreed: fearGreedIndex,
    categoryWeights,
  };

  if (correlations) {
    base.correlations = await fetchCorrelations(record.symbol, timeframe, correlationSymbols);
  }

  const { analyses } = analyseMultiTimeframe(base, series);

  // Return the analysis for the requested TF. The MTF confirmation is attached
  // to every analysis in the batch, so the caller gets both the single-TF read
  // and the cross-TF alignment in one response.
  const target = analyses.find((a) => a.timeframe === timeframe);
  if (!target) {
    // The requested timeframe failed its own fetch or lacked history. Not a
    // provider error — the candles came back — so reporting which other TFs
    // succeeded helps the operator diagnose whether the issue is upstream data
    // or a configuration mistake.
    log.warn(
      { symbol, timeframe, available: analyses.map((a) => a.timeframe) },
      'Requested timeframe unavailable in MTF batch',
    );
    throw new InsufficientDataError(
      symbol,
      timeframe,
      0,
    );
  }

  return target;
}

/**
 * Correlation against reference symbols.
 *
 * Computed on the same timeframe the analysis uses, so the lookback window and
 * alignment stay consistent with the rest of the read. Cached separately with a
 * longer TTL (10 minutes): correlation is a slow-moving property, and computing
 * it on every analysis refresh would turn a three-symbol reference into three
 * extra provider calls per poll.
 */
async function fetchCorrelations(
  baseSymbol: string,
  timeframe: Timeframe,
  referenceSymbols: string[],
) {
  return cacheWrap(CacheKeys.correlation(baseSymbol), CacheTtl.correlation, async () => {
    const base = await markets.requireSymbol(baseSymbol);
    const baseCandles = await marketRegistry.getCandles(base, timeframe, 200, base.preferredProvider);

    const references = await Promise.allSettled(
      referenceSymbols
        .filter((s) => s !== baseSymbol)
        .map(async (symbol) => {
          const record = await markets.requireSymbol(symbol);
          const candles = await marketRegistry.getCandles(
            record,
            timeframe,
            200,
            record.preferredProvider,
          );
          return { symbol: record.symbol, candles };
        }),
    );

    const resolved = references
      .filter((r): r is PromiseFulfilledResult<{ symbol: string; candles: Candle[] }> =>
        r.status === 'fulfilled'
      )
      .map((r) => r.value);

    return computeCorrelations(baseCandles, resolved, 120);
  });
}

/**
 * The default correlation universe.
 *
 * BTC and SPX are the two anchors everything else moves relative to. ETH and
 * Gold round it out to four — enough to show whether a move is idiosyncratic or
 * part of a broader risk-on/risk-off wave, without spending rate limit on ten
 * comparisons per poll.
 */
const DEFAULT_CORRELATION_UNIVERSE = ['BTCUSDT', 'ETHUSDT', 'SPX', 'XAUUSD'];

/**
 * Batch-analyse many symbols on one timeframe.
 *
 * Dashboard and scanner use: the full tradable universe in one call. Failures
 * are isolated so one dead ticker does not blank the grid. No MTF or correlation
 * by default — those are expensive enough to be opt-in.
 */
export async function analyseBatch(symbols: string[], timeframe: Timeframe) {
  const results = await Promise.allSettled(
    symbols.map((symbol) => analyseSymbol({ symbol, timeframe, mtf: false, correlations: false })),
  );

  const analyses = results
    .map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      // Log the failure but keep going — a batch is for overview, and one bad
      // symbol must not abort the rest.
      log.warn({ symbol: symbols[i], err: r.reason }, 'Batch analysis failed for symbol');
      return null;
    })
    .filter((a) => a !== null);

  return analyses;
}

/**
 * The symbols the scanner runs on.
 *
 * `scan_enabled` is the operator's way of saying "I have live data for this and
 * I want signals on it". The alternative — scanning every row in `market_symbols`
 * — would attempt AAPL on a deployment that only configured crypto providers and
 * log fifty `UnsupportedSymbolError`s per cycle.
 */
export async function listScannable() {
  return markets.listScanEnabled();
}

/**
 * Validate that every requested MTF timeframe is actually configured.
 *
 * Called before a batch run to fail early. Without this check a misconfigured
 * engine setting (`mtfTimeframes: ['3h']`) would silently produce no MTF data
 * for hours until an operator noticed the alignment always reads zero.
 */
export function validateMtfTimeframes(requested: Timeframe[]): string | null {
  const valid = new Set<Timeframe>(TIMEFRAMES);
  const invalid = requested.filter((tf) => !valid.has(tf));
  if (invalid.length > 0) {
    return `Invalid timeframes in mtfTimeframes: ${invalid.join(', ')}`;
  }
  return null;
}

export { InsufficientDataError };
