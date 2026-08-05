/**
 * Candlestick pattern recognition.
 *
 * Every detector returns a `reliability` score rather than a bare boolean,
 * because textbook conformity is only half the question. A hammer in the middle
 * of a range is noise; the same hammer at a demand zone after a liquidity sweep
 * is a setup. This module scores conformity — how closely the geometry matches
 * the definition — and {@link contextualiseReliability} adjusts for location.
 *
 * Patterns are detected on the most recent bars only. A textbook engulfing from
 * 200 bars ago is history, not information, and surfacing it would pad the
 * pattern list with things no trader would act on.
 */

import type { Candle, CandlestickPattern, CandlestickPatternName, Direction } from '@quantdesk/shared';
import { atr, clamp, mean, round, toSeries } from './series.js';

/** Per-candle geometry, computed once and reused by every detector. */
interface Anatomy {
  candle: Candle;
  body: number;
  range: number;
  upperWick: number;
  lowerWick: number;
  bullish: boolean;
  bearish: boolean;
  /** Body as a share of the full range, 0–1. */
  bodyRatio: number;
  /** Range relative to ATR — is this a significant candle at all? */
  atrRatio: number;
  /** The ATR at this bar, for detectors that need an absolute tolerance. */
  atrValue: number;
}

function anatomise(candles: Candle[]): Anatomy[] {
  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const avgRange = mean(candles.map((c) => c.high - c.low)) || 1;

  return candles.map((candle, i) => {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    const barAtr = atrSeries[i];
    const reference =
      barAtr !== undefined && Number.isFinite(barAtr) && barAtr > 0 ? barAtr : avgRange;

    return {
      candle,
      body,
      range,
      upperWick: candle.high - Math.max(candle.open, candle.close),
      lowerWick: Math.min(candle.open, candle.close) - candle.low,
      bullish: candle.close > candle.open,
      bearish: candle.close < candle.open,
      // A zero-range candle is a halted or untraded bar; treating its body ratio
      // as 0 keeps it out of every pattern rather than dividing by zero.
      bodyRatio: range > 0 ? body / range : 0,
      atrRatio: reference > 0 ? range / reference : 0,
      atrValue: reference,
    };
  });
}

/** Prior trend direction over the bars leading into a pattern. */
function priorTrend(candles: Candle[], index: number, lookback = 8): Direction {
  const start = Math.max(0, index - lookback);
  const from = candles[start]?.close;
  const to = candles[index - 1]?.close ?? candles[index]?.close;
  if (from === undefined || to === undefined || from === 0) return 'neutral';

  const change = ((to - from) / from) * 100;
  // A 0.4% drift is not a trend on any timeframe the platform serves.
  if (change > 0.4) return 'bullish';
  if (change < -0.4) return 'bearish';
  return 'neutral';
}

/* -------------------------------------------------------------------------- */
/* Single-candle patterns                                                     */
/* -------------------------------------------------------------------------- */

type Detector = (a: Anatomy[], i: number, candles: Candle[]) => Omit<CandlestickPattern, 'time' | 'index'> | null;

const DOJI_BODY_RATIO = 0.1;

const detectDoji: Detector = (a, i) => {
  const c = a[i];
  if (!c || c.bodyRatio > DOJI_BODY_RATIO || c.atrRatio < 0.5) return null;

  const upperShare = c.range > 0 ? c.upperWick / c.range : 0;
  const lowerShare = c.range > 0 ? c.lowerWick / c.range : 0;

  // Dragonfly and gravestone are directional; a neutral doji is indecision only.
  let name: CandlestickPatternName = 'doji';
  let direction: Direction = 'neutral';

  if (lowerShare > 0.7) {
    name = 'dragonfly_doji';
    direction = 'bullish';
  } else if (upperShare > 0.7) {
    name = 'gravestone_doji';
    direction = 'bearish';
  }

  return {
    name,
    direction,
    reliability: round(clamp(50 + (1 - c.bodyRatio / DOJI_BODY_RATIO) * 20 + c.atrRatio * 10, 0, 80), 2),
    barCount: 1,
  };
};

const detectHammerFamily: Detector = (a, i, candles) => {
  const c = a[i];
  if (!c || c.range <= 0 || c.atrRatio < 0.6) return null;

  const trend = priorTrend(candles, i);
  const longLower = c.lowerWick >= c.body * 2 && c.lowerWick / c.range >= 0.55;
  const longUpper = c.upperWick >= c.body * 2 && c.upperWick / c.range >= 0.55;
  const smallOpposite = (wick: number): boolean => c.range > 0 && wick / c.range <= 0.2;

  // Hammer and hanging man are the same shape; only the prior trend separates
  // them. Same for inverted hammer and shooting star.
  if (longLower && smallOpposite(c.upperWick)) {
    const bullishContext = trend === 'bearish';
    return {
      name: bullishContext ? 'hammer' : 'hanging_man',
      direction: bullishContext ? 'bullish' : 'bearish',
      reliability: round(clamp(45 + (c.lowerWick / c.range) * 30 + c.atrRatio * 10, 0, 85), 2),
      barCount: 1,
    };
  }

  if (longUpper && smallOpposite(c.lowerWick)) {
    const bearishContext = trend === 'bullish';
    return {
      name: bearishContext ? 'shooting_star' : 'inverted_hammer',
      direction: bearishContext ? 'bearish' : 'bullish',
      reliability: round(clamp(45 + (c.upperWick / c.range) * 30 + c.atrRatio * 10, 0, 85), 2),
      barCount: 1,
    };
  }

  return null;
};

const detectMarubozu: Detector = (a, i) => {
  const c = a[i];
  if (!c || c.bodyRatio < 0.9 || c.atrRatio < 1.1) return null;

  return {
    name: c.bullish ? 'marubozu_bullish' : 'marubozu_bearish',
    direction: c.bullish ? 'bullish' : 'bearish',
    reliability: round(clamp(50 + c.bodyRatio * 20 + c.atrRatio * 12, 0, 88), 2),
    barCount: 1,
  };
};

/* -------------------------------------------------------------------------- */
/* Two-candle patterns                                                        */
/* -------------------------------------------------------------------------- */

const detectEngulfing: Detector = (a, i, candles) => {
  const prev = a[i - 1];
  const curr = a[i];
  if (!prev || !curr) return null;

  // A doji cannot be meaningfully engulfed — the pattern needs a real body to
  // swallow, otherwise every candle after a doji qualifies.
  if (prev.bodyRatio < 0.15 || curr.atrRatio < 0.8) return null;

  const bullish =
    curr.bullish &&
    prev.bearish &&
    curr.candle.close > prev.candle.open &&
    curr.candle.open < prev.candle.close;

  const bearish =
    curr.bearish &&
    prev.bullish &&
    curr.candle.close < prev.candle.open &&
    curr.candle.open > prev.candle.close;

  if (!bullish && !bearish) return null;

  const trend = priorTrend(candles, i);
  const engulfRatio = prev.body > 0 ? curr.body / prev.body : 1;
  // A reversal pattern against no trend is just a big candle.
  const contextBonus = (bullish && trend === 'bearish') || (bearish && trend === 'bullish') ? 12 : 0;

  return {
    name: bullish ? 'bullish_engulfing' : 'bearish_engulfing',
    direction: bullish ? 'bullish' : 'bearish',
    reliability: round(clamp(48 + clamp(engulfRatio * 12, 0, 24) + contextBonus + curr.atrRatio * 6, 0, 92), 2),
    barCount: 2,
  };
};

const detectHarami: Detector = (a, i, candles) => {
  const prev = a[i - 1];
  const curr = a[i];
  if (!prev || !curr || prev.bodyRatio < 0.5 || prev.atrRatio < 0.9) return null;

  const prevTop = Math.max(prev.candle.open, prev.candle.close);
  const prevBottom = Math.min(prev.candle.open, prev.candle.close);
  const currTop = Math.max(curr.candle.open, curr.candle.close);
  const currBottom = Math.min(curr.candle.open, curr.candle.close);

  const contained = currTop < prevTop && currBottom > prevBottom;
  if (!contained) return null;

  const bullish = prev.bearish && curr.bullish;
  const bearish = prev.bullish && curr.bearish;
  if (!bullish && !bearish) return null;

  const trend = priorTrend(candles, i);
  const contextBonus = (bullish && trend === 'bearish') || (bearish && trend === 'bullish') ? 10 : 0;
  const containment = prev.body > 0 ? 1 - curr.body / prev.body : 0;

  return {
    name: bullish ? 'bullish_harami' : 'bearish_harami',
    direction: bullish ? 'bullish' : 'bearish',
    reliability: round(clamp(40 + containment * 25 + contextBonus, 0, 82), 2),
    barCount: 2,
  };
};

const detectPiercingAndDarkCloud: Detector = (a, i, candles) => {
  const prev = a[i - 1];
  const curr = a[i];
  if (!prev || !curr || prev.bodyRatio < 0.5 || curr.bodyRatio < 0.5) return null;

  const midpoint = (prev.candle.open + prev.candle.close) / 2;

  // Piercing line: gap down, then close back above the midpoint of the prior
  // bearish body — but not fully engulfing, which would be a different pattern.
  const piercing =
    prev.bearish &&
    curr.bullish &&
    curr.candle.open < prev.candle.low &&
    curr.candle.close > midpoint &&
    curr.candle.close < prev.candle.open;

  const darkCloud =
    prev.bullish &&
    curr.bearish &&
    curr.candle.open > prev.candle.high &&
    curr.candle.close < midpoint &&
    curr.candle.close > prev.candle.open;

  if (!piercing && !darkCloud) return null;

  const penetration =
    prev.body > 0 ? Math.abs(curr.candle.close - midpoint) / (prev.body / 2) : 0;
  const trend = priorTrend(candles, i);
  const contextBonus = (piercing && trend === 'bearish') || (darkCloud && trend === 'bullish') ? 12 : 0;

  return {
    name: piercing ? 'piercing_line' : 'dark_cloud_cover',
    direction: piercing ? 'bullish' : 'bearish',
    reliability: round(clamp(50 + clamp(penetration * 20, 0, 20) + contextBonus, 0, 88), 2),
    barCount: 2,
  };
};

const detectTweezers: Detector = (a, i, candles) => {
  const prev = a[i - 1];
  const curr = a[i];
  if (!prev || !curr) return null;

  // "Equal" means within 10% of an ATR — exact equality effectively never occurs
  // on a continuous price feed. The ATR comes from the anatomy so the series is
  // not recomputed once per bar.
  const tolerance = curr.atrValue * 0.1;
  if (!(tolerance > 0)) return null;

  const equalHighs = Math.abs(curr.candle.high - prev.candle.high) <= tolerance;
  const equalLows = Math.abs(curr.candle.low - prev.candle.low) <= tolerance;

  const trend = priorTrend(candles, i);

  if (equalHighs && !equalLows && trend === 'bullish') {
    return { name: 'tweezer_top', direction: 'bearish', reliability: round(clamp(45 + curr.atrRatio * 12, 0, 78), 2), barCount: 2 };
  }
  if (equalLows && !equalHighs && trend === 'bearish') {
    return { name: 'tweezer_bottom', direction: 'bullish', reliability: round(clamp(45 + curr.atrRatio * 12, 0, 78), 2), barCount: 2 };
  }
  return null;
};

/* -------------------------------------------------------------------------- */
/* Three-candle patterns                                                      */
/* -------------------------------------------------------------------------- */

const detectStars: Detector = (a, i, candles) => {
  const first = a[i - 2];
  const middle = a[i - 1];
  const third = a[i];
  if (!first || !middle || !third) return null;

  // The middle candle must be small — that indecision is the whole pattern.
  if (middle.bodyRatio > 0.35) return null;
  if (first.bodyRatio < 0.5 || third.bodyRatio < 0.5) return null;

  const firstMid = (first.candle.open + first.candle.close) / 2;

  const morning = first.bearish && third.bullish && third.candle.close > firstMid;
  const evening = first.bullish && third.bearish && third.candle.close < firstMid;
  if (!morning && !evening) return null;

  const trend = priorTrend(candles, i - 2);
  const contextBonus = (morning && trend === 'bearish') || (evening && trend === 'bullish') ? 15 : 0;
  const recovery = first.body > 0 ? Math.abs(third.candle.close - firstMid) / (first.body / 2) : 0;

  return {
    name: morning ? 'morning_star' : 'evening_star',
    direction: morning ? 'bullish' : 'bearish',
    reliability: round(clamp(55 + clamp(recovery * 15, 0, 20) + contextBonus, 0, 93), 2),
    barCount: 3,
  };
};

const detectThreeSoldiers: Detector = (a, i) => {
  const first = a[i - 2];
  const second = a[i - 1];
  const third = a[i];
  if (!first || !second || !third) return null;

  const bodies = [first, second, third];
  if (!bodies.every((c) => c.bodyRatio >= 0.55 && c.atrRatio >= 0.7)) return null;

  const allBullish = bodies.every((c) => c.bullish);
  const allBearish = bodies.every((c) => c.bearish);
  if (!allBullish && !allBearish) return null;

  // Progressive closes are what distinguish this from three unrelated candles.
  const progressing = allBullish
    ? second.candle.close > first.candle.close && third.candle.close > second.candle.close
    : second.candle.close < first.candle.close && third.candle.close < second.candle.close;

  if (!progressing) return null;

  // Each open should sit inside the previous body: gaps make it a different,
  // less reliable pattern.
  const nested = allBullish
    ? second.candle.open > first.candle.open && second.candle.open < first.candle.close &&
      third.candle.open > second.candle.open && third.candle.open < second.candle.close
    : second.candle.open < first.candle.open && second.candle.open > first.candle.close &&
      third.candle.open < second.candle.open && third.candle.open > second.candle.close;

  const avgBodyRatio = (first.bodyRatio + second.bodyRatio + third.bodyRatio) / 3;

  return {
    name: allBullish ? 'three_white_soldiers' : 'three_black_crows',
    direction: allBullish ? 'bullish' : 'bearish',
    reliability: round(clamp(58 + avgBodyRatio * 20 + (nested ? 12 : 0), 0, 94), 2),
    barCount: 3,
  };
};

const DETECTORS: Detector[] = [
  detectStars,
  detectThreeSoldiers,
  detectEngulfing,
  detectPiercingAndDarkCloud,
  detectHarami,
  detectTweezers,
  detectHammerFamily,
  detectMarubozu,
  detectDoji,
];

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Detect candlestick patterns in the recent window.
 *
 * Detectors run in descending order of specificity, and **at most one pattern is
 * recorded per bar** — the first match wins. Without that rule a morning star
 * also reports as a bullish engulfing and a hammer on the same bar, which the
 * confluence layer would then count as three independent pieces of evidence for
 * what is one observation.
 *
 * @param lookback How many recent bars to scan. Older patterns are not actionable.
 */
export function detectPatterns(candles: Candle[], lookback = 20): CandlestickPattern[] {
  if (candles.length < 5) return [];

  const a = anatomise(candles);
  const patterns: CandlestickPattern[] = [];
  const start = Math.max(2, candles.length - lookback);

  for (let i = start; i < candles.length; i++) {
    for (const detect of DETECTORS) {
      const found = detect(a, i, candles);
      if (!found) continue;

      const candle = candles[i];
      if (!candle) break;

      patterns.push({ ...found, time: candle.time, index: i });
      break; // One pattern per bar.
    }
  }

  // Newest first: recency is the primary sort for the UI list.
  return patterns.reverse();
}

/**
 * Adjust a pattern's reliability for where it occurred.
 *
 * Location is what turns a shape into a setup. A bullish reversal pattern
 * landing on demand — a fresh order block, an unfilled gap, a support level —
 * is materially more likely to work than the same shape mid-range, and one
 * appearing at the opposite kind of level is actively discounted.
 *
 * @param zoneProximity 0–1, how close the pattern sits to a relevant zone.
 * @param aligned Whether the zone agrees with the pattern's direction.
 */
export function contextualiseReliability(
  base: number,
  zoneProximity: number,
  aligned: boolean,
): number {
  if (!aligned) return round(clamp(base * 0.7, 0, 100), 2);
  return round(clamp(base + zoneProximity * 15, 0, 100), 2);
}

/**
 * Net directional pressure from recent patterns, -100..100.
 *
 * Weighted by reliability and decayed by age, so a strong pattern on the last
 * bar dominates a weak one from fifteen bars ago.
 */
export function patternBias(patterns: CandlestickPattern[], lastIndex: number): number {
  if (patterns.length === 0) return 0;

  let weighted = 0;
  let totalWeight = 0;

  for (const pattern of patterns) {
    if (pattern.direction === 'neutral') continue;

    const age = lastIndex - pattern.index;
    // Linear decay to zero over 20 bars.
    const recency = clamp(1 - age / 20, 0, 1);
    if (recency === 0) continue;

    const weight = (pattern.reliability / 100) * recency;
    weighted += (pattern.direction === 'bullish' ? 1 : -1) * weight * 100;
    totalWeight += weight;
  }

  return totalWeight === 0 ? 0 : round(clamp(weighted / totalWeight, -100, 100), 2);
}
