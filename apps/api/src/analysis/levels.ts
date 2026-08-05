/**
 * Horizontal price structure: volume profile, Fibonacci, support/resistance, and
 * the volatility regime classification.
 *
 * These are the levels a trader actually places orders against, so the scoring
 * matters as much as the detection. A level list ranked only by touch count puts
 * a stale level from 400 bars ago above the one price is reacting to right now,
 * which is worse than no ranking at all — so every score here folds in recency
 * and traded volume alongside touch count.
 */

import type {
  Candle,
  FibonacciLevels,
  IndicatorSnapshot,
  PriceLevel,
  VolatilityState,
  VolumeProfile,
  VolumeProfileRow,
} from '@quantdesk/shared';
import { atr, clamp, last, percentileRank, rollingStdev, round, sma, toSeries } from './series.js';

/* -------------------------------------------------------------------------- */
/* Volume profile                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Volume profile over the supplied candles.
 *
 * Each candle's volume is spread evenly across the price buckets its range
 * covers, rather than dumped entirely at its close. Close-only assignment
 * produces a spiky profile that finds a Point of Control wherever the most
 * closes happened to land, which is not where the most volume traded.
 *
 * The Value Area expands outward from the POC — the standard construction —
 * until 70% of total volume is enclosed.
 */
export function computeVolumeProfile(candles: Candle[], buckets = 48): VolumeProfile {
  const empty: VolumeProfile = { rows: [], poc: 0, vah: 0, val: 0, totalVolume: 0 };
  if (candles.length === 0) return empty;

  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return empty;

  const bucketCount = Math.max(8, Math.min(buckets, 200));
  const step = (max - min) / bucketCount;
  const volumes = new Array<number>(bucketCount).fill(0);

  for (const candle of candles) {
    const range = candle.high - candle.low;
    const volume = candle.volume > 0 ? candle.volume : 1;

    if (range <= 0 || step <= 0) {
      // A doji with no range: all volume at its single price.
      const idx = clamp(Math.floor((candle.close - min) / step), 0, bucketCount - 1);
      volumes[idx] = (volumes[idx] ?? 0) + volume;
      continue;
    }

    const lowIdx = clamp(Math.floor((candle.low - min) / step), 0, bucketCount - 1);
    const highIdx = clamp(Math.floor((candle.high - min) / step), 0, bucketCount - 1);
    const spanned = highIdx - lowIdx + 1;
    const perBucket = volume / spanned;

    for (let i = lowIdx; i <= highIdx; i++) {
      volumes[i] = (volumes[i] ?? 0) + perBucket;
    }
  }

  const totalVolume = volumes.reduce((acc, v) => acc + v, 0);
  if (totalVolume <= 0) return empty;

  const rows: VolumeProfileRow[] = volumes.map((volume, i) => ({
    priceLow: round(min + i * step, 8),
    priceHigh: round(min + (i + 1) * step, 8),
    volume: round(volume, 4),
    share: round(volume / totalVolume, 6),
  }));

  // Point of Control: the busiest bucket, reported at its midpoint.
  let pocIdx = 0;
  for (let i = 1; i < volumes.length; i++) {
    if ((volumes[i] ?? 0) > (volumes[pocIdx] ?? 0)) pocIdx = i;
  }

  // Grow the value area from the POC, always taking the richer neighbour.
  const target = totalVolume * 0.7;
  let accumulated = volumes[pocIdx] ?? 0;
  let lowIdx = pocIdx;
  let highIdx = pocIdx;

  while (accumulated < target && (lowIdx > 0 || highIdx < bucketCount - 1)) {
    const below = lowIdx > 0 ? (volumes[lowIdx - 1] ?? 0) : -1;
    const above = highIdx < bucketCount - 1 ? (volumes[highIdx + 1] ?? 0) : -1;

    if (above >= below && above >= 0) {
      highIdx++;
      accumulated += above;
    } else if (below >= 0) {
      lowIdx--;
      accumulated += below;
    } else {
      break;
    }
  }

  return {
    rows,
    poc: round(min + (pocIdx + 0.5) * step, 8),
    vah: round(min + (highIdx + 1) * step, 8),
    val: round(min + lowIdx * step, 8),
    totalVolume: round(totalVolume, 4),
  };
}

/* -------------------------------------------------------------------------- */
/* Fibonacci                                                                  */
/* -------------------------------------------------------------------------- */

const RETRACEMENT_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.65, 0.705, 0.786] as const;
const EXTENSION_RATIOS = [1.272, 1.414, 1.618, 2.0, 2.618] as const;

/**
 * Fibonacci retracement and extension anchored to the dominant recent swing.
 *
 * Which extreme came *last* determines the direction: a low followed by a high is
 * an up-leg, so retracements are measured downward from the high. Getting this
 * backwards inverts every level, which is why the ordering is derived from bar
 * index rather than assumed.
 *
 * @returns null when the lookback contains no usable swing.
 */
export function computeFibonacci(candles: Candle[], lookback = 120): FibonacciLevels | null {
  if (candles.length < 10) return null;

  const window = candles.slice(-Math.min(lookback, candles.length));

  let highIdx = 0;
  let lowIdx = 0;
  for (let i = 1; i < window.length; i++) {
    if ((window[i]?.high ?? -Infinity) > (window[highIdx]?.high ?? -Infinity)) highIdx = i;
    if ((window[i]?.low ?? Infinity) < (window[lowIdx]?.low ?? Infinity)) lowIdx = i;
  }

  const swingHigh = window[highIdx]?.high;
  const swingLow = window[lowIdx]?.low;
  if (swingHigh === undefined || swingLow === undefined) return null;

  const range = swingHigh - swingLow;
  // A range this small is noise; levels drawn on it would sit inside the spread.
  if (range <= 0 || swingLow <= 0 || range / swingLow < 0.001) return null;

  const upLeg = lowIdx < highIdx;

  const retracements: Record<string, number> = {};
  for (const ratio of RETRACEMENT_RATIOS) {
    retracements[String(ratio)] = round(
      upLeg ? swingHigh - range * ratio : swingLow + range * ratio,
      8,
    );
  }

  const extensions: Record<string, number> = {};
  for (const ratio of EXTENSION_RATIOS) {
    extensions[String(ratio)] = round(
      upLeg ? swingLow + range * ratio : swingHigh - range * ratio,
      8,
    );
  }

  const pocket = [retracements['0.618'], retracements['0.65']].filter(
    (v): v is number => v !== undefined,
  );

  return {
    swingHigh: round(swingHigh, 8),
    swingLow: round(swingLow, 8),
    direction: upLeg ? 'bullish' : 'bearish',
    retracements,
    extensions,
    goldenPocket: {
      low: round(Math.min(...pocket), 8),
      high: round(Math.max(...pocket), 8),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Support & resistance                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Detect support and resistance from pivot clustering.
 *
 * Three steps:
 *  1. Find fractal pivots (a high with `strength` lower highs either side).
 *  2. Cluster pivots whose prices fall within an ATR-scaled tolerance — a fixed
 *     percentage tolerance would merge unrelated levels on a volatile asset and
 *     split one real level on a quiet one.
 *  3. Score each cluster on touches, recency and volume, then classify it as
 *     support or resistance by its position relative to current price.
 *
 * The kind is assigned from *current* price, not from the pivot type, because a
 * broken resistance is now support and the level list must say so.
 */
export function detectLevels(
  candles: Candle[],
  options: { pivotStrength?: number; maxLevels?: number } = {},
): { support: PriceLevel[]; resistance: PriceLevel[] } {
  const { pivotStrength = 3, maxLevels = 8 } = options;
  if (candles.length < pivotStrength * 2 + 5) return { support: [], resistance: [] };

  const s = toSeries(candles);
  const atrValue = last(atr(s.high, s.low, s.close, 14));
  const price = last(s.close);

  if (!Number.isFinite(price) || price <= 0) return { support: [], resistance: [] };

  // Tolerance: half an ATR, floored at 0.05% so a very quiet market still
  // clusters, and capped at 2% so a volatile one does not merge everything.
  const tolerance = Number.isFinite(atrValue) && atrValue > 0
    ? clamp(atrValue * 0.5, price * 0.0005, price * 0.02)
    : price * 0.003;

  interface Pivot {
    price: number;
    time: number;
    index: number;
    volume: number;
  }

  const pivots: Pivot[] = [];

  for (let i = pivotStrength; i < candles.length - pivotStrength; i++) {
    const candle = candles[i];
    if (!candle) continue;

    let isHigh = true;
    let isLow = true;

    for (let j = i - pivotStrength; j <= i + pivotStrength; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (!other) continue;
      if (other.high >= candle.high) isHigh = false;
      if (other.low <= candle.low) isLow = false;
    }

    if (isHigh) pivots.push({ price: candle.high, time: candle.time, index: i, volume: candle.volume });
    if (isLow) pivots.push({ price: candle.low, time: candle.time, index: i, volume: candle.volume });
  }

  if (pivots.length === 0) return { support: [], resistance: [] };

  // Cluster by price proximity.
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Pivot[][] = [];
  let current: Pivot[] = [];

  for (const pivot of sorted) {
    const reference = current[0];
    if (!reference || Math.abs(pivot.price - reference.price) <= tolerance) {
      current.push(pivot);
    } else {
      clusters.push(current);
      current = [pivot];
    }
  }
  if (current.length > 0) clusters.push(current);

  const totalVolume = candles.reduce((acc, c) => acc + c.volume, 0) || 1;
  const avgVolume = totalVolume / candles.length;
  const lastIndex = candles.length - 1;

  const levels: PriceLevel[] = clusters.map((cluster) => {
    const avgPrice = cluster.reduce((acc, p) => acc + p.price, 0) / cluster.length;
    const lastTouchIndex = Math.max(...cluster.map((p) => p.index));
    const lastTouch = Math.max(...cluster.map((p) => p.time));

    // Touch count: the primary evidence, saturating at 5 — a level tested nine
    // times is not twice as significant as one tested four times.
    const touchScore = clamp((cluster.length / 5) * 100, 0, 100);

    // Recency: a level touched 300 bars ago is largely forgotten.
    const barsAgo = lastIndex - lastTouchIndex;
    const recencyScore = clamp(100 - (barsAgo / candles.length) * 100, 0, 100);

    // Volume at the level: institutional interest leaves a footprint.
    const clusterVolume = cluster.reduce((acc, p) => acc + p.volume, 0) / cluster.length;
    const volumeScore = clamp((clusterVolume / (avgVolume || 1)) * 50, 0, 100);

    const strength = round(
      (touchScore * 0.45 + recencyScore * 0.35 + volumeScore * 0.2),
      2,
    );

    return {
      price: round(avgPrice, 8),
      strength,
      touches: cluster.length,
      lastTouch,
      kind: avgPrice < price ? ('support' as const) : ('resistance' as const),
    };
  });

  // Nearest-and-strongest first: proximity decides which levels the trader cares
  // about, so sort support descending (nearest below) and resistance ascending.
  const support = levels
    .filter((l) => l.kind === 'support')
    .sort((a, b) => b.price - a.price)
    .slice(0, maxLevels);

  const resistance = levels
    .filter((l) => l.kind === 'resistance')
    .sort((a, b) => a.price - b.price)
    .slice(0, maxLevels);

  return { support, resistance };
}

/**
 * The nearest level in a direction, used for target and invalidation placement.
 *
 * @returns The level, or null when nothing lies that way.
 */
export function nearestLevel(levels: PriceLevel[], price: number, above: boolean): PriceLevel | null {
  const candidates = levels.filter((l) => (above ? l.price > price : l.price < price));
  if (candidates.length === 0) return null;

  return candidates.reduce((best, level) =>
    Math.abs(level.price - price) < Math.abs(best.price - price) ? level : best,
  );
}

/* -------------------------------------------------------------------------- */
/* Volatility regime                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Classify the current volatility regime.
 *
 * Position size and stop distance both depend on this, so it reports a
 * percentile against the instrument's own history rather than an absolute
 * threshold: 1.2% daily ATR is compressed for SOL and extreme for EURUSD.
 */
export function computeVolatility(candles: Candle[], indicators: IndicatorSnapshot): VolatilityState {
  const s = toSeries(candles);
  const price = last(s.close);
  const atrSeries = atr(s.high, s.low, s.close, 14);

  // ATR as a percentage of price, per bar — the cross-asset comparable form.
  const atrPercentSeries = atrSeries.map((value, i) => {
    const close = s.close[i];
    if (close === undefined || close <= 0 || !Number.isFinite(value)) return Number.NaN;
    return (value / close) * 100;
  });

  const currentAtrPercent = Number.isFinite(indicators.atrPercent)
    ? indicators.atrPercent
    : last(atrPercentSeries);

  const percentile = round(percentileRank(atrPercentSeries, currentAtrPercent), 1);

  const regime: VolatilityState['regime'] =
    percentile >= 90 ? 'extreme' : percentile >= 65 ? 'elevated' : percentile <= 20 ? 'compressed' : 'normal';

  // Squeeze: Bollinger bandwidth at a 60-bar low. This is the classic
  // pre-expansion condition and materially changes how a breakout is treated.
  // The bandwidth series is recomputed here from primitives rather than imported
  // from the indicator module, which would make the two modules mutually
  // dependent.
  const middle = sma(s.close, 20);
  const sd = rollingStdev(s.close, 20);
  const bandwidths: number[] = [];

  for (let i = Math.max(0, s.close.length - 60); i < s.close.length; i++) {
    const m = middle[i];
    const d = sd[i];
    if (m === undefined || d === undefined || !Number.isFinite(m) || !Number.isFinite(d)) continue;
    if (m === 0) continue;
    bandwidths.push((4 * d) / m); // (upper - lower) / middle, with a 2σ multiplier
  }

  const currentBandwidth = indicators.bollinger.bandwidth;
  const squeeze =
    bandwidths.length >= 20 &&
    Number.isFinite(currentBandwidth) &&
    currentBandwidth <= Math.min(...bandwidths) * 1.1;

  // Expanding when short-run ATR sits above its own medium-run average.
  const recent = atrPercentSeries.slice(-5).filter((v) => Number.isFinite(v));
  const baseline = atrPercentSeries.slice(-30, -5).filter((v) => Number.isFinite(v));
  const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : Number.NaN;
  const baselineAvg =
    baseline.length > 0 ? baseline.reduce((a, b) => a + b, 0) / baseline.length : Number.NaN;

  return {
    atrPercent: round(Number.isFinite(currentAtrPercent) ? currentAtrPercent : 0, 3),
    percentile,
    regime,
    squeeze,
    expanding:
      Number.isFinite(recentAvg) && Number.isFinite(baselineAvg) ? recentAvg > baselineAvg * 1.05 : false,
  };
}

/** Guard against a price series the engine cannot meaningfully analyse. */
export function hasUsablePrice(candles: Candle[]): boolean {
  const price = candles[candles.length - 1]?.close;
  return price !== undefined && Number.isFinite(price) && price > 0;
}
