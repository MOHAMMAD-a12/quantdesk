/**
 * The analysis engine — the orchestrator that turns candles into a
 * {@link TechnicalAnalysis}.
 *
 * This is the object the API serves, the AI prompt serialises, and the signal
 * generator consumes. Everything in it is computed deterministically: given the
 * same candles it produces the same analysis, with no model call involved. That
 * property is what makes the platform's numbers auditable — a stop loss can be
 * traced back to an ATR that can be traced back to a bar.
 *
 * **The forming candle is dropped before anything is computed.** A bar that is
 * still open changes on every tick, so an RSI or a structure break derived from
 * it flickers between polls: a signal appears, the price moves two ticks, and it
 * vanishes. Analysing only closed bars costs at most one bar of latency and buys
 * a signal that means the same thing when the user reads it as when it fired.
 */

import type {
  Candle,
  CorrelationEntry,
  DerivativesContext,
  FearGreedIndex,
  MtfConfirmation,
  SentimentSnapshot,
  SignalEngineConfig,
  TechnicalAnalysis,
  Timeframe,
} from '@quantdesk/shared';
import { TIMEFRAME_MS } from '@quantdesk/shared';
import { DEFAULT_CATEGORY_WEIGHTS, buildConfluence, scoreConfluence } from './confluence.js';
import { compositeMomentum, computeIndicators, trendStrengthScore } from './indicators.js';
import { computeVolatility, detectLevels, hasUsablePrice } from './levels.js';
import { computeMtf } from './mtf.js';
import { detectPatterns } from './patterns.js';
import { clamp, pearson, round } from './series.js';
import { computeSmc } from './smc.js';

export interface AnalysisInput {
  symbol: string;
  timeframe: Timeframe;
  candles: Candle[];
  /** Crypto derivatives context, when the venue exposes it. */
  derivatives?: DerivativesContext | null;
  sentiment?: SentimentSnapshot | null;
  fearGreed?: FearGreedIndex | null;
  /** Pre-computed higher-timeframe confirmation, when the caller ran it. */
  mtf?: MtfConfirmation;
  correlations?: CorrelationEntry[];
  /** Category weights from the admin-editable engine config. */
  categoryWeights?: SignalEngineConfig['categoryWeights'];
  /**
   * Treat the final candle as closed. Set when the caller has already trimmed
   * the series, or when replaying history where every bar is closed by
   * definition.
   */
  assumeClosed?: boolean;
  /** Injected for deterministic tests; defaults to the wall clock. */
  now?: number;
}

/** Below this the structural layers cannot produce anything meaningful. */
export const MIN_CANDLES = 30;

export class InsufficientDataError extends Error {
  constructor(
    readonly symbol: string,
    readonly timeframe: Timeframe,
    readonly available: number,
  ) {
    super(
      `Not enough history to analyse ${symbol} ${timeframe}: ${available} candles available, ${MIN_CANDLES} required`,
    );
    this.name = 'InsufficientDataError';
  }
}

/**
 * Drop the final candle when its bucket has not yet closed.
 *
 * Checked against the clock rather than assumed, because providers differ: some
 * return the forming bar, some do not, and some omit it only outside market
 * hours. Blindly dropping the last element would silently discard a closed bar
 * from the providers that already exclude it.
 */
export function dropFormingCandle(candles: Candle[], timeframe: Timeframe, now = Date.now()): Candle[] {
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return candles;

  const bucketMs = TIMEFRAME_MS[timeframe];
  const closesAt = lastCandle.time + bucketMs;

  return now < closesAt ? candles.slice(0, -1) : candles;
}

/**
 * Run the full deterministic analysis.
 *
 * @throws {InsufficientDataError} when there is too little history for the
 *   structural layers. The indicator layer tolerates short input by design, but
 *   an SMC read built on twelve bars would be confidently meaningless, and
 *   returning it would be worse than declining.
 */
export function analyse(input: AnalysisInput): TechnicalAnalysis {
  const {
    symbol,
    timeframe,
    derivatives = null,
    sentiment = null,
    fearGreed = null,
    categoryWeights = DEFAULT_CATEGORY_WEIGHTS,
    assumeClosed = false,
    now = Date.now(),
  } = input;

  const candles = assumeClosed ? input.candles : dropFormingCandle(input.candles, timeframe, now);

  if (candles.length < MIN_CANDLES || !hasUsablePrice(candles)) {
    throw new InsufficientDataError(symbol, timeframe, candles.length);
  }

  const lastCandle = candles[candles.length - 1] as Candle;
  const price = lastCandle.close;
  const lastIndex = candles.length - 1;

  // Higher timeframes warrant wider pivots: a 3-bar fractal on a daily chart
  // finds noise that a 5-bar one correctly ignores.
  const swingStrength = timeframe === '1d' || timeframe === '1w' ? 5 : timeframe === '4h' ? 4 : 3;

  const indicators = computeIndicators(candles);
  const smc = computeSmc(candles, { swingStrength });
  const patterns = detectPatterns(candles);
  const { support, resistance } = detectLevels(candles, { pivotStrength: swingStrength });
  const volatility = computeVolatility(candles, indicators);

  const confluence = buildConfluence({
    price,
    indicators,
    smc,
    patterns,
    supportLevels: support,
    resistanceLevels: resistance,
    volatility,
    lastIndex,
    derivatives,
    sentiment,
    fearGreed,
  });

  return {
    symbol,
    timeframe,
    price: round(price, 8),
    asOf: lastCandle.time,
    candleCount: candles.length,

    indicators,
    smc,
    patterns,
    supportLevels: support,
    resistanceLevels: resistance,
    volatility,

    trendStrength: trendStrengthScore(indicators, price, smc.structure.clarity),
    momentum: compositeMomentum(indicators),

    confluence,
    confluenceScore: scoreConfluence(confluence, categoryWeights),

    ...(input.mtf ? { mtf: input.mtf } : {}),
    ...(input.correlations ? { correlations: input.correlations } : {}),
    // Any synthetic bar taints the whole analysis: the UI badges it, and signals
    // derived from it are marked so they can never be mistaken for live reads.
    synthetic: candles.some((c) => c.synthetic === true),
  };
}

/**
 * Analyse several timeframes and attach the resulting MTF confirmation to each.
 *
 * The confirmation is computed once from all timeframes and shared, so the 15m
 * analysis carries the same alignment reading the 4h does — they are describing
 * one book, not four independent opinions.
 *
 * Timeframes that lack history are skipped rather than aborting the batch. A
 * newly-listed symbol with no weekly bars should still be analysable on the 1h.
 */
export function analyseMultiTimeframe(
  base: Omit<AnalysisInput, 'timeframe' | 'candles' | 'mtf'>,
  series: Array<{ timeframe: Timeframe; candles: Candle[] }>,
): { analyses: TechnicalAnalysis[]; mtf: MtfConfirmation } {
  const analyses: TechnicalAnalysis[] = [];

  for (const entry of series) {
    try {
      analyses.push(analyse({ ...base, timeframe: entry.timeframe, candles: entry.candles }));
    } catch (error) {
      if (error instanceof InsufficientDataError) continue;
      throw error;
    }
  }

  const mtf = computeMtf(analyses);

  // Re-attach so every returned analysis carries the shared confirmation.
  return { analyses: analyses.map((analysis) => ({ ...analysis, mtf })), mtf };
}

/**
 * Correlation of a symbol's returns against reference instruments.
 *
 * Computed on **returns**, not prices. Two assets in long-term uptrends have
 * near-perfectly correlated price series regardless of whether they move
 * together day to day, so a price-series correlation would report 0.98 for
 * essentially unrelated instruments and be useless for the thing it is for:
 * knowing whether two open positions are one position.
 *
 * Series are aligned by timestamp rather than by index, because a missing bar in
 * one feed would otherwise shift every subsequent comparison by one bar.
 */
export function computeCorrelations(
  base: Candle[],
  references: Array<{ symbol: string; candles: Candle[] }>,
  lookback = 120,
): CorrelationEntry[] {
  if (base.length < 20) return [];

  const baseByTime = new Map<number, number>();
  for (const candle of base) baseByTime.set(candle.time, candle.close);

  const out: CorrelationEntry[] = [];

  for (const reference of references) {
    if (reference.candles.length < 20) continue;

    const alignedBase: number[] = [];
    const alignedRef: number[] = [];

    for (const candle of reference.candles) {
      const baseClose = baseByTime.get(candle.time);
      if (baseClose === undefined) continue;
      alignedBase.push(baseClose);
      alignedRef.push(candle.close);
    }

    // Fewer than 20 shared bars is not enough to distinguish correlation from
    // coincidence, and a confident-looking coefficient from 6 bars is worse than
    // no coefficient.
    if (alignedBase.length < 20) continue;

    const window = Math.min(lookback, alignedBase.length);
    const baseReturns = toReturns(alignedBase.slice(-window));
    const refReturns = toReturns(alignedRef.slice(-window));

    out.push({
      symbol: reference.symbol,
      coefficient: round(clamp(pearson(baseReturns, refReturns), -1, 1), 4),
      lookbackBars: baseReturns.length,
    });
  }

  return out.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
}

/** Bar-to-bar percentage returns; length is one less than the input. */
function toReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const previous = closes[i - 1];
    const current = closes[i];
    if (previous === undefined || current === undefined || previous <= 0) {
      out.push(0);
      continue;
    }
    out.push((current - previous) / previous);
  }
  return out;
}
