/**
 * Classic technical indicators.
 *
 * Each function takes OHLCV series and returns a full-length array aligned to
 * the input candles (see `series.ts` for the alignment convention). The
 * aggregate at the bottom, {@link computeIndicators}, assembles the
 * `IndicatorSnapshot` the rest of the platform consumes.
 *
 * Values are read at the **last** candle. Callers that need the last *closed*
 * candle should drop the forming bar before calling — the engine does this so an
 * in-progress candle cannot flip a signal from one poll to the next.
 */

import type {
  AdxValue,
  BollingerValue,
  Candle,
  Direction,
  IchimokuValue,
  IndicatorSnapshot,
  MacdValue,
  StochasticValue,
} from '@quantdesk/shared';
import { computeFibonacci, computeVolumeProfile } from './levels.js';
import {
  type Series,
  atr,
  clamp,
  ema,
  finite,
  highest,
  last,
  lowest,
  mean,
  nth,
  rma,
  rollingStdev,
  round,
  sma,
  subtract,
  toSeries,
  trueRange,
} from './series.js';

export { atr, toSeries, trueRange };
export type { Series };

/* -------------------------------------------------------------------------- */
/* Momentum                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Relative Strength Index (Wilder).
 *
 * Gains and losses are smoothed with `rma`, not `ema` — see the note in
 * `series.ts` on why the distinction matters.
 */
export function rsi(close: number[], period = 14): number[] {
  const out = new Array<number>(close.length).fill(Number.NaN);
  if (close.length <= period) return out;

  const gains = new Array<number>(close.length).fill(0);
  const losses = new Array<number>(close.length).fill(0);

  for (let i = 1; i < close.length; i++) {
    const change = (close[i] ?? 0) - (close[i - 1] ?? 0);
    gains[i] = change > 0 ? change : 0;
    losses[i] = change < 0 ? -change : 0;
  }

  // Index 0 has no change; smoothing starts from index 1.
  const avgGain = rma(gains.slice(1), period);
  const avgLoss = rma(losses.slice(1), period);

  for (let i = 0; i < avgGain.length; i++) {
    const g = avgGain[i];
    const l = avgLoss[i];
    if (g === undefined || l === undefined || !Number.isFinite(g) || !Number.isFinite(l)) continue;
    // All-gains window: RS is infinite, RSI saturates at 100.
    out[i + 1] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  return out;
}

/**
 * RSI divergence against price over a recent window.
 *
 * Compares the two most recent swing extremes in price with RSI at the same
 * bars: price makes a higher high while RSI makes a lower high → bearish.
 *
 * Deliberately conservative. Divergence is the single most over-called signal in
 * retail analysis, so both legs must clear a minimum separation before it counts.
 *
 * @returns The divergence direction, or null when none is present.
 */
export function rsiDivergence(
  high: number[],
  low: number[],
  rsiValues: number[],
  lookback = 60,
): Direction | null {
  const n = rsiValues.length;
  if (n < 20) return null;

  const from = Math.max(1, n - lookback);
  // Pivot separation: adjacent bars are noise, not a divergence.
  const minGap = 5;

  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = from + 2; i < n - 2; i++) {
    const h = high[i];
    const l = low[i];
    if (h === undefined || l === undefined) continue;

    const isHigh =
      h > (high[i - 1] ?? h) && h > (high[i - 2] ?? h) && h > (high[i + 1] ?? h) && h > (high[i + 2] ?? h);
    const isLow =
      l < (low[i - 1] ?? l) && l < (low[i - 2] ?? l) && l < (low[i + 1] ?? l) && l < (low[i + 2] ?? l);

    if (isHigh) pivotHighs.push(i);
    if (isLow) pivotLows.push(i);
  }

  const bearish = checkDivergence(pivotHighs, high, rsiValues, minGap, 'high');
  if (bearish) return 'bearish';

  const bullish = checkDivergence(pivotLows, low, rsiValues, minGap, 'low');
  if (bullish) return 'bullish';

  return null;
}

function checkDivergence(
  pivots: number[],
  price: number[],
  rsiValues: number[],
  minGap: number,
  kind: 'high' | 'low',
): boolean {
  if (pivots.length < 2) return false;

  const b = pivots[pivots.length - 1];
  const a = pivots[pivots.length - 2];
  if (a === undefined || b === undefined || b - a < minGap) return false;

  const priceA = price[a];
  const priceB = price[b];
  const rsiA = rsiValues[a];
  const rsiB = rsiValues[b];

  if (
    priceA === undefined ||
    priceB === undefined ||
    rsiA === undefined ||
    rsiB === undefined ||
    !Number.isFinite(rsiA) ||
    !Number.isFinite(rsiB)
  ) {
    return false;
  }

  // Require a meaningful RSI gap; 1–2 points is measurement noise.
  if (Math.abs(rsiB - rsiA) < 3) return false;

  return kind === 'high'
    ? priceB > priceA && rsiB < rsiA // higher high, weaker momentum
    : priceB < priceA && rsiB > rsiA; // lower low, stronger momentum
}

/** MACD line, signal line and histogram. */
export function macd(
  close: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fast = ema(close, fastPeriod);
  const slow = ema(close, slowPeriod);
  const macdLine = subtract(fast, slow);

  // The signal EMA must be seeded from where the MACD line actually begins,
  // otherwise the leading NaNs are treated as data and drag the first values.
  const firstValid = macdLine.findIndex((v) => Number.isFinite(v));
  const signal = new Array<number>(macdLine.length).fill(Number.NaN);

  if (firstValid !== -1) {
    const seeded = ema(macdLine.slice(firstValid), signalPeriod);
    for (let i = 0; i < seeded.length; i++) {
      signal[firstValid + i] = seeded[i] ?? Number.NaN;
    }
  }

  return { macd: macdLine, signal, histogram: subtract(macdLine, signal) };
}

/** Stochastic oscillator (%K smoothed, %D as the SMA of %K). */
export function stochastic(
  high: number[],
  low: number[],
  close: number[],
  kPeriod = 14,
  kSmooth = 3,
  dPeriod = 3,
): { k: number[]; d: number[] } {
  const hh = highest(high, kPeriod);
  const ll = lowest(low, kPeriod);
  const rawK = new Array<number>(close.length).fill(Number.NaN);

  for (let i = 0; i < close.length; i++) {
    const h = hh[i];
    const l = ll[i];
    const c = close[i];
    if (h === undefined || l === undefined || c === undefined) continue;
    if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
    const range = h - l;
    // A zero range means a perfectly flat window: neither overbought nor over-
    // sold, so 50 is the neutral reading rather than a division by zero.
    rawK[i] = range === 0 ? 50 : ((c - l) / range) * 100;
  }

  const k = kSmooth > 1 ? sma(rawK, kSmooth) : rawK;
  return { k, d: sma(k, dPeriod) };
}

/* -------------------------------------------------------------------------- */
/* Volatility                                                                 */
/* -------------------------------------------------------------------------- */

/** Bollinger Bands with normalised bandwidth and %B. */
export function bollinger(close: number[], period = 20, multiplier = 2): BollingerValue[] {
  const middle = sma(close, period);
  const sd = rollingStdev(close, period);

  return close.map((price, i) => {
    const m = middle[i];
    const s = sd[i];

    if (m === undefined || s === undefined || !Number.isFinite(m) || !Number.isFinite(s)) {
      return { upper: Number.NaN, middle: Number.NaN, lower: Number.NaN, bandwidth: Number.NaN, percentB: Number.NaN };
    }

    const upper = m + multiplier * s;
    const lower = m - multiplier * s;
    const width = upper - lower;

    return {
      upper,
      middle: m,
      lower,
      bandwidth: m === 0 ? 0 : width / m,
      // 0 = at the lower band, 1 = at the upper. Outside the bands exceeds that
      // range, which is meaningful and deliberately not clamped.
      percentB: width === 0 ? 0.5 : (price - lower) / width,
    };
  });
}

/**
 * Average Directional Index with +DI / -DI.
 *
 * ADX measures trend *strength* without direction; the DI pair supplies
 * direction. Both are needed — a high ADX alone says nothing about which way to
 * trade.
 */
export function adx(
  high: number[],
  low: number[],
  close: number[],
  period = 14,
): AdxValue[] {
  const n = high.length;
  const empty: AdxValue = { adx: Number.NaN, plusDi: Number.NaN, minusDi: Number.NaN };
  if (n < period * 2) return new Array<AdxValue>(n).fill(empty);

  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);

  for (let i = 1; i < n; i++) {
    const upMove = (high[i] ?? 0) - (high[i - 1] ?? 0);
    const downMove = (low[i - 1] ?? 0) - (low[i] ?? 0);

    // Only the larger move counts, and only when positive — the two directional
    // movements are mutually exclusive by definition.
    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  const smoothedTr = rma(trueRange(high, low, close), period);
  const smoothedPlus = rma(plusDm, period);
  const smoothedMinus = rma(minusDm, period);

  const plusDi = new Array<number>(n).fill(Number.NaN);
  const minusDi = new Array<number>(n).fill(Number.NaN);
  const dx = new Array<number>(n).fill(Number.NaN);

  for (let i = 0; i < n; i++) {
    const tr = smoothedTr[i];
    const p = smoothedPlus[i];
    const m = smoothedMinus[i];
    if (tr === undefined || p === undefined || m === undefined) continue;
    if (!Number.isFinite(tr) || tr === 0 || !Number.isFinite(p) || !Number.isFinite(m)) continue;

    const pdi = (p / tr) * 100;
    const mdi = (m / tr) * 100;
    plusDi[i] = pdi;
    minusDi[i] = mdi;

    const sum = pdi + mdi;
    dx[i] = sum === 0 ? 0 : (Math.abs(pdi - mdi) / sum) * 100;
  }

  // ADX is a second smoothing of DX, which is why it warms up so late.
  const firstValid = dx.findIndex((v) => Number.isFinite(v));
  const adxValues = new Array<number>(n).fill(Number.NaN);

  if (firstValid !== -1) {
    const smoothed = rma(dx.slice(firstValid), period);
    for (let i = 0; i < smoothed.length; i++) {
      adxValues[firstValid + i] = smoothed[i] ?? Number.NaN;
    }
  }

  return Array.from({ length: n }, (_, i) => ({
    adx: adxValues[i] ?? Number.NaN,
    plusDi: plusDi[i] ?? Number.NaN,
    minusDi: minusDi[i] ?? Number.NaN,
  }));
}

/* -------------------------------------------------------------------------- */
/* Volume                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Volume-Weighted Average Price with standard-deviation bands.
 *
 * Anchored to the start of the supplied window rather than the session: the
 * platform analyses a rolling lookback across asset classes that have no common
 * session boundary (crypto never closes; FX rolls at 17:00 New York; equities
 * open at 09:30). A rolling anchor is consistent across all of them, and the
 * window is stated in the UI so the reading is not mistaken for session VWAP.
 */
export function vwap(
  high: number[],
  low: number[],
  close: number[],
  volume: number[],
): { vwap: number[]; upper1: number[]; lower1: number[]; upper2: number[]; lower2: number[] } {
  const n = close.length;
  const vwapLine = new Array<number>(n).fill(Number.NaN);
  const upper1 = new Array<number>(n).fill(Number.NaN);
  const lower1 = new Array<number>(n).fill(Number.NaN);
  const upper2 = new Array<number>(n).fill(Number.NaN);
  const lower2 = new Array<number>(n).fill(Number.NaN);

  let cumPv = 0;
  let cumVol = 0;
  let cumPv2 = 0;

  for (let i = 0; i < n; i++) {
    const h = high[i] ?? 0;
    const l = low[i] ?? 0;
    const c = close[i] ?? 0;
    // Typical price, the standard VWAP input.
    const tp = (h + l + c) / 3;
    // Zero-volume bars occur in thin FX and index feeds; weighting by 1 keeps the
    // line continuous instead of freezing it.
    const v = (volume[i] ?? 0) > 0 ? (volume[i] as number) : 1;

    cumPv += tp * v;
    cumPv2 += tp * tp * v;
    cumVol += v;

    if (cumVol === 0) continue;

    const value = cumPv / cumVol;
    vwapLine[i] = value;

    // Variance of a volume-weighted mean: E[x²] - E[x]².
    const variance = Math.max(0, cumPv2 / cumVol - value * value);
    const sd = Math.sqrt(variance);

    upper1[i] = value + sd;
    lower1[i] = value - sd;
    upper2[i] = value + sd * 2;
    lower2[i] = value - sd * 2;
  }

  return { vwap: vwapLine, upper1, lower1, upper2, lower2 };
}

/** On-Balance Volume — cumulative volume signed by the close-to-close move. */
export function obv(close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(0);
  let total = 0;

  for (let i = 1; i < close.length; i++) {
    const current = close[i] ?? 0;
    const previous = close[i - 1] ?? 0;
    const v = volume[i] ?? 0;

    if (current > previous) total += v;
    else if (current < previous) total -= v;
    // An unchanged close adds nothing — that is the definition, not an omission.

    out[i] = total;
  }
  return out;
}

/** Current volume as a multiple of its own average, e.g. 1.8 = 180% of normal. */
export function relativeVolume(volume: number[], period = 20): number {
  if (volume.length === 0) return 1;
  const avg = mean(volume.slice(-period - 1, -1));
  const current = last(volume);
  if (!Number.isFinite(avg) || avg === 0 || !Number.isFinite(current)) return 1;
  return current / avg;
}

/* -------------------------------------------------------------------------- */
/* Ichimoku                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ichimoku Kinkō Hyō.
 *
 * The leading span is reported **at the current bar** rather than displaced 26
 * bars forward, because the platform asks "where is price relative to the cloud
 * now" — a projected cloud has no price to compare against yet. Chart rendering
 * applies the displacement separately.
 *
 * @returns null when there is not enough history for the 52-period span.
 */
export function ichimoku(
  high: number[],
  low: number[],
  close: number[],
  conversion = 9,
  base = 26,
  spanB = 52,
): IchimokuValue | null {
  if (close.length < spanB + base) return null;

  const midpoint = (period: number, offset = 0): number => {
    const end = high.length - offset;
    const start = end - period;
    if (start < 0) return Number.NaN;

    let hi = -Infinity;
    let lo = Infinity;
    for (let i = start; i < end; i++) {
      const h = high[i];
      const l = low[i];
      if (h !== undefined && h > hi) hi = h;
      if (l !== undefined && l < lo) lo = l;
    }
    return hi === -Infinity || lo === Infinity ? Number.NaN : (hi + lo) / 2;
  };

  const tenkan = midpoint(conversion);
  const kijun = midpoint(base);
  // Senkou A/B as they apply to *this* bar: computed from data `base` bars ago.
  const senkouA = (midpoint(conversion, base) + midpoint(base, base)) / 2;
  const senkouB = midpoint(spanB, base);
  const chikou = nth(close, base);
  const price = last(close);

  if (!Number.isFinite(senkouA) || !Number.isFinite(senkouB) || !Number.isFinite(price)) {
    return null;
  }

  const cloudTop = Math.max(senkouA, senkouB);
  const cloudBottom = Math.min(senkouA, senkouB);

  return {
    tenkan,
    kijun,
    senkouA,
    senkouB,
    chikou,
    cloudPosition: price > cloudTop ? 'above' : price < cloudBottom ? 'below' : 'inside',
    cloudDirection: senkouA > senkouB ? 'bullish' : senkouA < senkouB ? 'bearish' : 'neutral',
  };
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                  */
/* -------------------------------------------------------------------------- */

/** Moving-average periods the platform reports. */
export const EMA_PERIODS = [9, 21, 50, 100, 200] as const;
export const SMA_PERIODS = [20, 50, 100, 200] as const;

/**
 * Full indicator readout at the last candle.
 *
 * Never throws on short input: a symbol with 30 bars of history yields a
 * snapshot whose long-period fields are `NaN`, and the confluence layer skips
 * factors it cannot compute. That is strictly better than refusing to analyse.
 */
export function computeIndicators(candles: Candle[]): IndicatorSnapshot {
  const s = toSeries(candles);
  const price = last(s.close);

  const rsiSeries = rsi(s.close, 14);
  const macdSeries = macd(s.close);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const adxSeries = adx(s.high, s.low, s.close, 14);
  const bbSeries = bollinger(s.close, 20, 2);
  const stochSeries = stochastic(s.high, s.low, s.close);
  const vwapSeries = vwap(s.high, s.low, s.close, s.volume);
  const obvSeries = obv(s.close, s.volume);

  const emaMap: Record<number, number> = {};
  for (const period of EMA_PERIODS) emaMap[period] = round(last(ema(s.close, period)), 8);

  const smaMap: Record<number, number> = {};
  for (const period of SMA_PERIODS) smaMap[period] = round(last(sma(s.close, period)), 8);

  const atrValue = last(atrSeries);
  const lastAdx = adxSeries[adxSeries.length - 1] ?? {
    adx: Number.NaN,
    plusDi: Number.NaN,
    minusDi: Number.NaN,
  };
  const lastBb = bbSeries[bbSeries.length - 1] ?? {
    upper: Number.NaN,
    middle: Number.NaN,
    lower: Number.NaN,
    bandwidth: Number.NaN,
    percentB: Number.NaN,
  };

  const macdValue: MacdValue = {
    macd: round(last(macdSeries.macd), 8),
    signal: round(last(macdSeries.signal), 8),
    histogram: round(last(macdSeries.histogram), 8),
  };

  const stochValue: StochasticValue = {
    k: round(last(stochSeries.k), 2),
    d: round(last(stochSeries.d), 2),
  };

  return {
    rsi: round(last(rsiSeries), 2),
    rsiDivergence: rsiDivergence(s.high, s.low, rsiSeries),
    macd: macdValue,
    ema: emaMap,
    sma: smaMap,
    atr: round(atrValue, 8),
    atrPercent: price > 0 && Number.isFinite(atrValue) ? round((atrValue / price) * 100, 3) : 0,
    adx: {
      adx: round(lastAdx.adx, 2),
      plusDi: round(lastAdx.plusDi, 2),
      minusDi: round(lastAdx.minusDi, 2),
    },
    bollinger: {
      upper: round(lastBb.upper, 8),
      middle: round(lastBb.middle, 8),
      lower: round(lastBb.lower, 8),
      bandwidth: round(lastBb.bandwidth, 5),
      percentB: round(lastBb.percentB, 4),
    },
    stochastic: stochValue,
    ichimoku: ichimoku(s.high, s.low, s.close),
    vwap: round(last(vwapSeries.vwap), 8),
    vwapBands: {
      upper1: round(last(vwapSeries.upper1), 8),
      lower1: round(last(vwapSeries.lower1), 8),
      upper2: round(last(vwapSeries.upper2), 8),
      lower2: round(last(vwapSeries.lower2), 8),
    },
    volumeProfile: computeVolumeProfile(candles),
    fibonacci: computeFibonacci(candles),
    obv: round(last(obvSeries), 2),
    relativeVolume: round(clamp(relativeVolume(s.volume), 0, 50), 2),
  };
}

/**
 * Composite momentum, -100..100.
 *
 * Blends four independent momentum reads so no single indicator dominates. RSI
 * and Stochastic are re-centred on zero; MACD is normalised by ATR so the
 * histogram is comparable across a $0.60 XRP and a $68,000 BTC — an unnormalised
 * histogram would make every high-priced instrument look maximally momentous.
 */
export function compositeMomentum(indicators: IndicatorSnapshot): number {
  const parts: Array<{ value: number; weight: number }> = [];

  if (Number.isFinite(indicators.rsi)) {
    parts.push({ value: ((indicators.rsi - 50) / 50) * 100, weight: 1 });
  }

  if (Number.isFinite(indicators.stochastic.k)) {
    parts.push({ value: ((indicators.stochastic.k - 50) / 50) * 100, weight: 0.6 });
  }

  if (Number.isFinite(indicators.macd.histogram) && indicators.atr > 0) {
    const normalised = (indicators.macd.histogram / indicators.atr) * 100;
    parts.push({ value: clamp(normalised, -100, 100), weight: 1 });
  }

  const { plusDi, minusDi } = indicators.adx;
  if (Number.isFinite(plusDi) && Number.isFinite(minusDi)) {
    const total = plusDi + minusDi;
    if (total > 0) parts.push({ value: ((plusDi - minusDi) / total) * 100, weight: 0.8 });
  }

  if (parts.length === 0) return 0;

  const weightSum = parts.reduce((acc, p) => acc + p.weight, 0);
  const weighted = parts.reduce((acc, p) => acc + p.value * p.weight, 0);
  return round(clamp(weighted / weightSum, -100, 100), 2);
}

/**
 * Trend strength 0–100, blending ADX with EMA-stack alignment.
 *
 * ADX alone says a trend is strong but not whether the moving averages agree; a
 * clean 9 > 21 > 50 > 200 stack is corroborating evidence that the higher-order
 * structure points the same way.
 *
 * @param structureClarity 0–100 from the SMC layer, folded in when available.
 */
export function trendStrengthScore(
  indicators: IndicatorSnapshot,
  price: number,
  structureClarity?: number,
): number {
  const adxValue = Number.isFinite(indicators.adx.adx) ? indicators.adx.adx : 0;
  // ADX 25 is the conventional trending threshold, 50 is a strong trend.
  const adxComponent = clamp((adxValue / 50) * 100, 0, 100);

  const stack = [9, 21, 50, 200]
    .map((p) => indicators.ema[p])
    .filter((v): v is number => v !== undefined && Number.isFinite(v));

  let stackComponent = 50;
  if (stack.length >= 3) {
    let ordered = 0;
    for (let i = 0; i < stack.length - 1; i++) {
      const a = stack[i] as number;
      const b = stack[i + 1] as number;
      if (a > b) ordered++;
      else if (a < b) ordered--;
    }
    // Perfect ascending or descending order scores 100 either way — this measures
    // conviction, not direction.
    stackComponent = (Math.abs(ordered) / (stack.length - 1)) * 100;
  }

  // Price beyond the slowest EMA it has confirms participation.
  const anchor = indicators.ema[200] ?? indicators.ema[100] ?? indicators.ema[50];
  const anchorComponent =
    anchor !== undefined && Number.isFinite(anchor) && anchor > 0
      ? clamp((Math.abs(price - anchor) / anchor) * 100 * 8, 0, 100)
      : 50;

  const components: Array<{ value: number; weight: number }> = [
    { value: adxComponent, weight: 1.2 },
    { value: stackComponent, weight: 1 },
    { value: anchorComponent, weight: 0.5 },
  ];

  if (structureClarity !== undefined && Number.isFinite(structureClarity)) {
    components.push({ value: structureClarity, weight: 0.8 });
  }

  const weightSum = components.reduce((acc, c) => acc + c.weight, 0);
  const weighted = components.reduce((acc, c) => acc + c.value * c.weight, 0);
  return round(clamp(finite(weighted / weightSum), 0, 100), 2);
}
