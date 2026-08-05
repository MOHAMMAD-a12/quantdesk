/**
 * Numeric series primitives.
 *
 * Every indicator in the engine is composed from these, so correctness here is
 * load-bearing. Two conventions hold throughout the analysis package:
 *
 *  1. **Output arrays are the same length as their input**, with `NaN` in the
 *     positions where the indicator has not yet warmed up. Returning a shorter
 *     array would force every caller to track its own offset, and an off-by-one
 *     in that arithmetic silently misaligns an indicator against the candle it
 *     describes — the kind of bug that produces a plausible chart and a wrong
 *     signal.
 *  2. **Nothing throws on short input.** A 20-bar series asked for a 200-period
 *     EMA returns all-`NaN`, and the confluence layer simply finds no factor
 *     there. A thrown error would take down analysis for a thinly-traded symbol.
 *
 * `Number.isFinite` is therefore the standard guard before using any value read
 * out of these arrays.
 */

import type { Candle } from '@quantdesk/shared';

/** OHLCV split into column arrays — the shape every indicator wants. */
export interface Series {
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  time: number[];
}

export function toSeries(candles: Candle[]): Series {
  return {
    open: candles.map((c) => c.open),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    volume: candles.map((c) => c.volume),
    time: candles.map((c) => c.time),
  };
}

/**
 * True Range per bar.
 *
 * Lives here rather than in `indicators.ts` because both the indicator layer and
 * the level/volatility layer need it, and a mutual import between those two
 * modules would be a cycle.
 *
 * The first bar has no previous close, so its true range is the bar's own range.
 */
export function trueRange(high: number[], low: number[], close: number[]): number[] {
  const out = new Array<number>(high.length).fill(Number.NaN);

  for (let i = 0; i < high.length; i++) {
    const h = high[i];
    const l = low[i];
    if (h === undefined || l === undefined) continue;

    if (i === 0) {
      out[i] = h - l;
      continue;
    }
    const prevClose = close[i - 1] ?? h;
    out[i] = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
  }
  return out;
}

/** Average True Range (Wilder-smoothed). */
export function atr(high: number[], low: number[], close: number[], period = 14): number[] {
  return rma(trueRange(high, low, close), period);
}

/** Last defined element, or `NaN` when the series is empty. */
export function last(values: number[]): number {
  return values.length > 0 ? (values[values.length - 1] ?? Number.NaN) : Number.NaN;
}

/** Element `n` back from the end (0 = last), or `NaN` when out of range. */
export function nth(values: number[], back: number): number {
  const idx = values.length - 1 - back;
  if (idx < 0 || idx >= values.length) return Number.NaN;
  return values[idx] ?? Number.NaN;
}

/** Arithmetic mean, ignoring non-finite entries. */
export function mean(values: number[]): number {
  let sum = 0;
  let count = 0;
  for (const v of values) {
    if (Number.isFinite(v)) {
      sum += v;
      count++;
    }
  }
  return count === 0 ? Number.NaN : sum / count;
}

/** Population standard deviation, ignoring non-finite entries. */
export function stdev(values: number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return Number.NaN;
  const avg = mean(finite);
  const variance = finite.reduce((acc, v) => acc + (v - avg) ** 2, 0) / finite.length;
  return Math.sqrt(variance);
}

/**
 * Simple moving average.
 *
 * Uses a running sum rather than re-summing each window: at 500 bars × several
 * periods × 4 timeframes × 17 symbols the quadratic version is measurable.
 */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] ?? 0;
    if (i >= period) sum -= values[i - period] ?? 0;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average.
 *
 * Seeded with the SMA of the first `period` values — the standard convention,
 * and the reason the first `period - 1` slots are `NaN`. Seeding from the first
 * value instead would make early readings depend on where the data happened to
 * start.
 */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return out;

  const k = 2 / (period + 1);

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    const value = values[i] ?? prev;
    prev = value * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's smoothing (RMA) — the average used by RSI, ATR and ADX.
 *
 * It is *not* the same as an EMA of the same period: Wilder uses `1/period`
 * where an EMA uses `2/(period+1)`. Substituting one for the other is a common
 * mistake that shifts RSI by several points and makes ATR-derived stops too
 * tight.
 */
export function rma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0 || values.length < period) return out;

  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i] ?? 0;
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    const value = values[i] ?? prev;
    prev = (prev * (period - 1) + value) / period;
    out[i] = prev;
  }
  return out;
}

/** Rolling highest value over `period`, `NaN` until warmed up. */
export function highest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0) return out;

  for (let i = period - 1; i < values.length; i++) {
    let max = -Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v !== undefined && Number.isFinite(v) && v > max) max = v;
    }
    out[i] = max === -Infinity ? Number.NaN : max;
  }
  return out;
}

/** Rolling lowest value over `period`, `NaN` until warmed up. */
export function lowest(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 0) return out;

  for (let i = period - 1; i < values.length; i++) {
    let min = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const v = values[j];
      if (v !== undefined && Number.isFinite(v) && v < min) min = v;
    }
    out[i] = min === Infinity ? Number.NaN : min;
  }
  return out;
}

/** Rolling standard deviation over `period`. */
export function rollingStdev(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(Number.NaN);
  if (period <= 1 || values.length < period) return out;

  for (let i = period - 1; i < values.length; i++) {
    out[i] = stdev(values.slice(i - period + 1, i + 1));
  }
  return out;
}

/** Element-wise difference `a - b`, propagating `NaN`. */
export function subtract(a: number[], b: number[]): number[] {
  const length = Math.min(a.length, b.length);
  const out = new Array<number>(length).fill(Number.NaN);
  for (let i = 0; i < length; i++) {
    const x = a[i];
    const y = b[i];
    out[i] = x !== undefined && y !== undefined ? x - y : Number.NaN;
  }
  return out;
}

/**
 * Pearson correlation between two equal-length series.
 *
 * Returns 0 rather than `NaN` when either series is flat: a constant series has
 * no correlation to anything, and 0 is the honest reading. `NaN` would poison
 * the correlation matrix in the UI.
 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;

  const xs = a.slice(a.length - n);
  const ys = b.slice(b.length - n);

  const mx = mean(xs);
  const my = mean(ys);
  if (!Number.isFinite(mx) || !Number.isFinite(my)) return 0;

  let num = 0;
  let dx2 = 0;
  let dy2 = 0;

  for (let i = 0; i < n; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined || y === undefined) continue;
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const dx = x - mx;
    const dy = y - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : clamp(num / denom, -1, 1);
}

/**
 * Percentile rank of `value` within `values`, 0–100.
 *
 * Used to turn a raw ATR into "this is the 87th-percentile volatility for this
 * instrument", which is comparable across assets in a way the raw number is not.
 */
export function percentileRank(values: number[], value: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0 || !Number.isFinite(value)) return 50;

  let below = 0;
  for (const v of finite) if (v < value) below++;
  return (below / finite.length) * 100;
}

/** Percent change from `from` to `to`; 0 when `from` is 0. */
export function percentChange(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

/** Constrain to `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Linearly map `value` from one range to another, clamped to the output range.
 *
 * The engine scores many raw quantities onto 0–100 or -100..100; doing that
 * inline each time invites inconsistent edge behaviour.
 */
export function scale(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (!Number.isFinite(value) || inMax === inMin) return outMin;
  const t = (value - inMin) / (inMax - inMin);
  return clamp(outMin + t * (outMax - outMin), Math.min(outMin, outMax), Math.max(outMin, outMax));
}

/** Round to `dp` decimal places, returning `NaN` unchanged. */
export function round(value: number, dp = 2): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Round for display while preserving significance on small-priced assets. */
export function roundPrice(value: number, precision: number): number {
  return round(value, Math.min(Math.max(precision, 0), 8));
}

/** Replace a non-finite value with a fallback. */
export function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}
