/**
 * Smart Money Concepts / ICT analysis.
 *
 * This module implements the structural reading a discretionary SMC trader
 * performs by eye: where the swings are, where structure broke, which candle the
 * institutional order sat on, which gaps remain unfilled, where stops are
 * resting, and whether they have already been raided.
 *
 * Two decisions shape everything below.
 *
 * **Swings are confirmed, never provisional.** A pivot requires `strength` bars
 * on *both* sides, so the most recent `strength` bars can never produce one. That
 * lag is deliberate: a "swing high" declared on the newest bar is just the
 * current high, and structure built on it repaints — a BOS that appears and
 * disappears between two polls is worse than one that arrives a few bars late.
 *
 * **Breaks require a close, not a wick.** Price piercing a swing high intrabar
 * and closing back below is a liquidity sweep, which is the *opposite* signal to
 * a break of structure. Using highs would classify every stop hunt as a bullish
 * BOS, which is precisely the trap the methodology exists to avoid.
 */

import type {
  Candle,
  Direction,
  FairValueGap,
  LiquidityPool,
  LiquiditySweep,
  MarketStructure,
  OrderBlock,
  SmcAnalysis,
  StructureEvent,
  SupplyDemandZone,
  SwingPoint,
  TrendDirection,
} from '@quantdesk/shared';
import { atr, clamp, last, mean, round, toSeries } from './series.js';

export interface SmcOptions {
  /** Bars required either side of a pivot. 3 suits intraday, 5 suits daily. */
  swingStrength?: number;
  /** Maximum structures of each kind to retain, newest first. */
  maxPerKind?: number;
}

// Typed as `number` rather than literal `3 | 12`: the defaults are used as
// default parameter values, and an `as const` literal would make every function
// accepting a caller-supplied `number` reject it at the call site.
const DEFAULTS: Required<Pick<SmcOptions, 'swingStrength' | 'maxPerKind'>> = {
  swingStrength: 3,
  maxPerKind: 12,
};

/* -------------------------------------------------------------------------- */
/* Swings                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Fractal swing pivots, labelled HH / LH / HL / LL.
 *
 * Labels are relative to the previous pivot of the *same kind*, which is what
 * makes a sequence of them readable as structure: HH→HL→HH is an uptrend,
 * LH→LL→LH is a downtrend.
 */
export function detectSwings(candles: Candle[], strength = DEFAULTS.swingStrength): SwingPoint[] {
  const swings: SwingPoint[] = [];
  if (candles.length < strength * 2 + 1) return swings;

  let previousHigh: number | null = null;
  let previousLow: number | null = null;

  for (let i = strength; i < candles.length - strength; i++) {
    const candle = candles[i];
    if (!candle) continue;

    let isHigh = true;
    let isLow = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (!other) continue;
      // `>=` rather than `>`: an equal high is not a pivot, it is a double top,
      // and treating it as a pivot produces two swings at the same price.
      if (other.high >= candle.high) isHigh = false;
      if (other.low <= candle.low) isLow = false;
    }

    if (isHigh) {
      swings.push({
        index: i,
        time: candle.time,
        price: candle.high,
        kind: 'high',
        label: previousHigh === null || candle.high > previousHigh ? 'HH' : 'LH',
      });
      previousHigh = candle.high;
    }

    if (isLow) {
      swings.push({
        index: i,
        time: candle.time,
        price: candle.low,
        kind: 'low',
        label: previousLow === null || candle.low < previousLow ? 'LL' : 'HL',
      });
      previousLow = candle.low;
    }
  }

  return swings.sort((a, b) => a.index - b.index);
}

/* -------------------------------------------------------------------------- */
/* Structure events                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Detect Break of Structure and Change of Character.
 *
 * The distinction is entirely about prevailing bias:
 *  - **BOS** — a break *with* the existing trend. Continuation.
 *  - **CHoCH** — the first break *against* it. Potential reversal.
 *
 * Walking the candles forward while tracking the most recent confirmed swing on
 * each side means a level can only be broken once; after a break the reference
 * advances, so a slow grind higher yields a sequence of BOS events rather than
 * one level firing on every bar.
 */
export function detectStructureEvents(
  candles: Candle[],
  swings: SwingPoint[],
): StructureEvent[] {
  const events: StructureEvent[] = [];
  if (swings.length < 2) return events;

  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const avgVolume = mean(s.volume) || 1;

  let trend: Direction = 'neutral';

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];
    if (!candle) continue;

    // Only swings confirmed strictly before this bar are eligible: a pivot needs
    // bars after it, so using one that includes this bar would be lookahead.
    const eligible = swings.filter((sw) => sw.index < i);
    const lastHigh = findLast(eligible, (sw) => sw.kind === 'high');
    const lastLow = findLast(eligible, (sw) => sw.kind === 'low');

    const barAtr = atrSeries[i];
    const reference = Number.isFinite(barAtr) && (barAtr ?? 0) > 0 ? (barAtr as number) : candle.close * 0.01;

    if (lastHigh && candle.close > lastHigh.price) {
      // Already-broken levels are skipped by requiring the break to be new.
      if (!events.some((e) => e.brokenLevel === lastHigh.price && e.direction === 'bullish')) {
        events.push({
          type: trend === 'bearish' ? 'CHoCH' : 'BOS',
          direction: 'bullish',
          time: candle.time,
          brokenLevel: round(lastHigh.price, 8),
          confirmedAt: round(candle.close, 8),
          significance: significanceOf(candle.close - lastHigh.price, reference, candle.volume, avgVolume),
        });
        trend = 'bullish';
      }
    }

    if (lastLow && candle.close < lastLow.price) {
      if (!events.some((e) => e.brokenLevel === lastLow.price && e.direction === 'bearish')) {
        events.push({
          type: trend === 'bullish' ? 'CHoCH' : 'BOS',
          direction: 'bearish',
          time: candle.time,
          brokenLevel: round(lastLow.price, 8),
          confirmedAt: round(candle.close, 8),
          significance: significanceOf(lastLow.price - candle.close, reference, candle.volume, avgVolume),
        });
        trend = 'bearish';
      }
    }
  }

  return events;
}

/**
 * Score a break 0–100 on how convincing it was.
 *
 * Displacement is measured in ATR so the score means the same thing on any
 * instrument; volume confirms participation. A one-tick break on average volume
 * scores near zero and is correctly ignored by the confluence layer.
 */
function significanceOf(
  displacement: number,
  atrReference: number,
  volume: number,
  avgVolume: number,
): number {
  const displacementScore = clamp((displacement / atrReference) * 60, 0, 70);
  const volumeScore = clamp((volume / avgVolume - 1) * 40, 0, 30);
  return round(clamp(displacementScore + volumeScore, 0, 100), 2);
}

/* -------------------------------------------------------------------------- */
/* Market structure                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Classify the structural state: trend, clarity, dealing range, premium/discount.
 *
 * Clarity answers "how cleanly is this trending" and is what stops the engine
 * treating a choppy range as a tradeable trend. It combines label consistency
 * (are the last swings all HH/HL?) with the absence of conflicting breaks.
 */
export function analyseStructure(
  candles: Candle[],
  swings: SwingPoint[],
  events: StructureEvent[],
): MarketStructure {
  const price = candles[candles.length - 1]?.close ?? 0;
  const lastEvent = events.length > 0 ? (events[events.length - 1] ?? null) : null;

  // Label consistency over the last three pivots of each kind.
  const highs = swings.filter((s) => s.kind === 'high').slice(-3);
  const lows = swings.filter((s) => s.kind === 'low').slice(-3);

  const bullishLabels =
    highs.filter((s) => s.label === 'HH').length + lows.filter((s) => s.label === 'HL').length;
  const bearishLabels =
    highs.filter((s) => s.label === 'LH').length + lows.filter((s) => s.label === 'LL').length;
  const totalLabels = highs.length + lows.length;

  let trend: TrendDirection = 'ranging';
  if (totalLabels >= 3) {
    if (bullishLabels >= bearishLabels + 2) trend = 'uptrend';
    else if (bearishLabels >= bullishLabels + 2) trend = 'downtrend';
  }

  // A recent decisive event overrides stale labels — structure has just changed.
  if (lastEvent && lastEvent.significance >= 45) {
    const barsSince = candles.filter((c) => c.time > lastEvent.time).length;
    if (barsSince <= 10) {
      trend = lastEvent.direction === 'bullish' ? 'uptrend' : 'downtrend';
    }
  }

  const labelClarity = totalLabels === 0 ? 0 : (Math.abs(bullishLabels - bearishLabels) / totalLabels) * 100;

  // Conflicting recent events indicate chop, and should suppress clarity.
  const recentEvents = events.slice(-4);
  const bullishEvents = recentEvents.filter((e) => e.direction === 'bullish').length;
  const bearishEvents = recentEvents.filter((e) => e.direction === 'bearish').length;
  const eventClarity =
    recentEvents.length === 0
      ? 40
      : (Math.abs(bullishEvents - bearishEvents) / recentEvents.length) * 100;

  const clarity = round(clamp(labelClarity * 0.6 + eventClarity * 0.4, 0, 100), 2);

  // Dealing range: the most recent confirmed swing high and low. Premium above
  // equilibrium, discount below — the ICT framing for whether price is expensive.
  const recentHigh = findLast(swings, (s) => s.kind === 'high');
  const recentLow = findLast(swings, (s) => s.kind === 'low');

  let dealingRange: MarketStructure['dealingRange'] = null;
  let premiumDiscount: MarketStructure['premiumDiscount'] = 'equilibrium';

  if (recentHigh && recentLow && recentHigh.price > recentLow.price) {
    const equilibrium = (recentHigh.price + recentLow.price) / 2;
    dealingRange = {
      high: round(recentHigh.price, 8),
      low: round(recentLow.price, 8),
      equilibrium: round(equilibrium, 8),
    };

    const range = recentHigh.price - recentLow.price;
    const position = (price - recentLow.price) / range;
    // A 10% band around the midpoint counts as equilibrium; without it price
    // flickers between premium and discount on every tick near the middle.
    premiumDiscount = position > 0.55 ? 'premium' : position < 0.45 ? 'discount' : 'equilibrium';
  }

  return { trend, clarity, swings, events, lastEvent, premiumDiscount, dealingRange };
}

/* -------------------------------------------------------------------------- */
/* Order blocks                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Institutional order blocks.
 *
 * An order block is the last opposing candle before an impulsive move that broke
 * structure — the bar on which the institutional order is presumed to have been
 * filled. Anchoring detection to `events` rather than scanning for "big candles"
 * is what separates this from a generic momentum finder: the move has to have
 * *broken something* to imply intent.
 *
 * `mitigated` marks blocks price has already traded back into. Mitigated blocks
 * are kept, not discarded — a mitigated block is a used level, and knowing it was
 * used is what tells the confluence layer not to trade it again.
 */
export function detectOrderBlocks(
  candles: Candle[],
  events: StructureEvent[],
  maxBlocks = DEFAULTS.maxPerKind,
): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const avgVolume = mean(s.volume) || 1;

  const timeToIndex = new Map<number, number>();
  candles.forEach((c, i) => timeToIndex.set(c.time, i));

  for (const event of events) {
    const breakIndex = timeToIndex.get(event.time);
    if (breakIndex === undefined) continue;

    const wantBearishCandle = event.direction === 'bullish';

    // Walk back for the last opposing candle, bounded at 12 bars: beyond that
    // the candle is not plausibly the origin of this move.
    let originIndex = -1;
    for (let i = breakIndex; i >= Math.max(0, breakIndex - 12); i--) {
      const candle = candles[i];
      if (!candle) continue;
      const isBearish = candle.close < candle.open;
      if (isBearish === wantBearishCandle) {
        originIndex = i;
        break;
      }
    }

    if (originIndex === -1) continue;

    const origin = candles[originIndex];
    if (!origin) continue;

    const barAtr = atrSeries[originIndex];
    const reference =
      Number.isFinite(barAtr) && (barAtr ?? 0) > 0 ? (barAtr as number) : origin.close * 0.01;

    const top = Math.max(origin.open, origin.close, origin.high);
    const bottom = Math.min(origin.open, origin.close, origin.low);

    // Mitigation: has price since traded back inside the zone?
    let mitigated = false;
    let mitigatedAt: number | undefined;
    for (let i = breakIndex + 1; i < candles.length; i++) {
      const candle = candles[i];
      if (!candle) continue;
      const touched = event.direction === 'bullish' ? candle.low <= top : candle.high >= bottom;
      if (touched) {
        mitigated = true;
        mitigatedAt = candle.time;
        break;
      }
    }

    // Did the impulse leave an unfilled gap? That upgrades the block to breaker
    // quality — an imbalance is unfinished business price tends to return to.
    const hasImbalance = leavesImbalance(candles, originIndex, event.direction);

    const displacement = Math.abs(event.confirmedAt - event.brokenLevel);
    const strength = round(
      clamp(
        clamp((displacement / reference) * 45, 0, 45) +
          clamp((origin.volume / avgVolume - 1) * 25, 0, 25) +
          event.significance * 0.2 +
          (hasImbalance ? 10 : 0) +
          (event.type === 'CHoCH' ? 5 : 0),
        0,
        100,
      ),
      2,
    );

    blocks.push({
      direction: event.direction,
      top: round(top, 8),
      bottom: round(bottom, 8),
      time: origin.time,
      mitigated,
      ...(mitigatedAt !== undefined ? { mitigatedAt } : {}),
      strength,
      hasImbalance,
    });
  }

  // Newest first, deduplicated by zone: two events can resolve to the same origin
  // candle, and showing the same block twice implies twice the evidence.
  const seen = new Set<string>();
  return blocks
    .reverse()
    .filter((block) => {
      const key = `${block.time}:${block.direction}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxBlocks);
}

/** Whether the three bars from `index` leave a fair value gap in `direction`. */
function leavesImbalance(candles: Candle[], index: number, direction: Direction): boolean {
  const a = candles[index];
  const c = candles[index + 2];
  if (!a || !c) return false;
  return direction === 'bullish' ? c.low > a.high : c.high < a.low;
}

/* -------------------------------------------------------------------------- */
/* Fair value gaps                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Fair Value Gaps — three-candle imbalances where price moved so fast that one
 * side of the book went untouched.
 *
 * `fillRatio` is tracked rather than a boolean, because a 30%-filled gap and a
 * 95%-filled gap are different setups: the first still has room to act as a
 * magnet, the second is effectively spent.
 */
export function detectFairValueGaps(
  candles: Candle[],
  maxGaps = DEFAULTS.maxPerKind,
): FairValueGap[] {
  const gaps: FairValueGap[] = [];

  for (let i = 2; i < candles.length; i++) {
    const first = candles[i - 2];
    const third = candles[i];
    if (!first || !third) continue;

    let direction: Direction | null = null;
    let top = 0;
    let bottom = 0;

    if (third.low > first.high) {
      direction = 'bullish';
      top = third.low;
      bottom = first.high;
    } else if (third.high < first.low) {
      direction = 'bearish';
      top = first.low;
      bottom = third.high;
    }

    if (!direction) continue;

    const height = top - bottom;
    const price = third.close;
    if (height <= 0 || price <= 0) continue;

    const sizePercent = (height / price) * 100;
    // Sub-basis-point gaps are quote noise, not imbalances.
    if (sizePercent < 0.02) continue;

    // How far has price retraced into the gap since it formed?
    let deepest = direction === 'bullish' ? top : bottom;
    for (let j = i + 1; j < candles.length; j++) {
      const candle = candles[j];
      if (!candle) continue;
      if (direction === 'bullish') deepest = Math.min(deepest, candle.low);
      else deepest = Math.max(deepest, candle.high);
    }

    const filled =
      direction === 'bullish'
        ? clamp((top - deepest) / height, 0, 1)
        : clamp((deepest - bottom) / height, 0, 1);

    gaps.push({
      direction,
      top: round(top, 8),
      bottom: round(bottom, 8),
      time: third.time,
      fillRatio: round(filled, 3),
      // Fully traded through counts as mitigated; the 95% threshold avoids
      // calling a gap live because of a single tick left unfilled.
      mitigated: filled >= 0.95,
      sizePercent: round(sizePercent, 4),
    });
  }

  return gaps.reverse().slice(0, maxGaps);
}

/* -------------------------------------------------------------------------- */
/* Liquidity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Liquidity pools — clustered equal highs and lows where stop orders accumulate.
 *
 * Buyside liquidity sits above equal highs (short stops), sellside below equal
 * lows (long stops). Clustering tolerance is ATR-scaled for the same reason as in
 * `levels.ts`: a fixed percentage merges unrelated levels on a volatile asset.
 */
export function detectLiquidityPools(
  candles: Candle[],
  swings: SwingPoint[],
  maxPools = DEFAULTS.maxPerKind,
): LiquidityPool[] {
  if (swings.length === 0) return [];

  const s = toSeries(candles);
  const atrValue = last(atr(s.high, s.low, s.close, 14));
  const price = last(s.close);
  if (!Number.isFinite(price) || price <= 0) return [];

  const tolerance =
    Number.isFinite(atrValue) && atrValue > 0
      ? clamp(atrValue * 0.3, price * 0.0003, price * 0.01)
      : price * 0.002;

  const pools: LiquidityPool[] = [];

  for (const kind of ['high', 'low'] as const) {
    const points = swings.filter((sw) => sw.kind === kind).sort((a, b) => a.price - b.price);
    let cluster: SwingPoint[] = [];

    const flush = (): void => {
      if (cluster.length === 0) return;

      const avgPrice = cluster.reduce((acc, p) => acc + p.price, 0) / cluster.length;
      const lastIndex = Math.max(...cluster.map((p) => p.index));

      // Equal highs/lows are the strong case: a single pivot is a level, two or
      // more at the same price is resting liquidity.
      const clusterScore = clamp((cluster.length / 3) * 70, 0, 70);
      const recency = clamp(100 - ((candles.length - lastIndex) / candles.length) * 100, 0, 100);

      // Swept when a later candle wicked beyond the level but closed back inside.
      let swept = false;
      let sweptAt: number | undefined;
      for (let i = lastIndex + 1; i < candles.length; i++) {
        const candle = candles[i];
        if (!candle) continue;
        const pierced = kind === 'high' ? candle.high > avgPrice : candle.low < avgPrice;
        const closedBack = kind === 'high' ? candle.close < avgPrice : candle.close > avgPrice;
        if (pierced && closedBack) {
          swept = true;
          sweptAt = candle.time;
          break;
        }
      }

      pools.push({
        price: round(avgPrice, 8),
        kind: kind === 'high' ? 'buyside' : 'sellside',
        touches: cluster.length,
        strength: round(clamp(clusterScore + recency * 0.3, 0, 100), 2),
        swept,
        ...(sweptAt !== undefined ? { sweptAt } : {}),
      });

      cluster = [];
    };

    for (const point of points) {
      const reference = cluster[0];
      if (!reference || Math.abs(point.price - reference.price) <= tolerance) cluster.push(point);
      else {
        flush();
        cluster.push(point);
      }
    }
    flush();
  }

  // Unswept pools first — they are the ones still able to attract price — then by
  // strength.
  return pools
    .sort((a, b) => Number(a.swept) - Number(b.swept) || b.strength - a.strength)
    .slice(0, maxPools);
}

/**
 * Confirmed liquidity sweeps (stop hunts).
 *
 * A sweep is a wick through a liquidity level followed by a close back inside,
 * and it is the highest-value SMC entry trigger — but only when it *reverses*.
 * `reversed` is therefore verified against subsequent bars rather than assumed,
 * and `reversalBars` records how long confirmation took so a slow, grinding
 * "reversal" can be discounted.
 */
export function detectLiquiditySweeps(
  candles: Candle[],
  pools: LiquidityPool[],
  confirmationBars = 3,
): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);

  for (const pool of pools) {
    if (!pool.swept || pool.sweptAt === undefined) continue;

    const index = candles.findIndex((c) => c.time === pool.sweptAt);
    const candle = candles[index];
    if (index === -1 || !candle) continue;

    const barAtr = atrSeries[index];
    const reference =
      Number.isFinite(barAtr) && (barAtr ?? 0) > 0 ? (barAtr as number) : candle.close * 0.01;

    const buyside = pool.kind === 'buyside';
    const penetration = buyside ? candle.high - pool.price : pool.price - candle.low;
    if (penetration <= 0) continue;

    // A sweep raids stops *above* highs, so taking buyside liquidity is a
    // bearish event — the direction is the expected reaction, not the wick.
    const direction: Direction = buyside ? 'bearish' : 'bullish';

    let reversed = false;
    let reversalBars = 0;

    for (let i = index + 1; i <= Math.min(index + confirmationBars, candles.length - 1); i++) {
      const next = candles[i];
      if (!next) continue;
      reversalBars = i - index;
      const movedAway = buyside ? next.close < candle.low : next.close > candle.high;
      if (movedAway) {
        reversed = true;
        break;
      }
    }

    sweeps.push({
      direction,
      level: pool.price,
      time: candle.time,
      penetrationAtr: round(penetration / reference, 3),
      reversed,
      reversalBars,
    });
  }

  return sweeps.sort((a, b) => b.time - a.time);
}

/* -------------------------------------------------------------------------- */
/* Supply & demand                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Supply and demand zones, classified Rally-Base-Rally style.
 *
 * A zone is a *base* — a short cluster of small-range candles — bracketed by two
 * legs. The pattern name records what came in and what went out:
 *   RBR (rally-base-rally) and DBR are demand; RBD and DBD are supply.
 *
 * Continuation patterns (RBR, DBD) are weighted above reversal patterns because
 * the trend that produced them is still intact.
 */
export function detectSupplyDemandZones(
  candles: Candle[],
  maxZones = DEFAULTS.maxPerKind,
): SupplyDemandZone[] {
  const zones: SupplyDemandZone[] = [];
  if (candles.length < 12) return zones;

  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const ranges = candles.map((c) => c.high - c.low);
  const avgRange = mean(ranges) || 1;

  // A base candle is materially narrower than average; a leg candle materially
  // wider. Between those thresholds is ordinary price action.
  const baseMax = avgRange * 0.7;
  const legMin = avgRange * 1.4;

  for (let i = 3; i < candles.length - 3; i++) {
    // Bases of 1–3 candles. Longer bases are consolidation, not a zone.
    for (let baseLength = 1; baseLength <= 3; baseLength++) {
      const baseStart = i;
      const baseEnd = i + baseLength - 1;
      if (baseEnd + 1 >= candles.length) break;

      const base = candles.slice(baseStart, baseEnd + 1);
      if (base.length !== baseLength) break;
      if (!base.every((c) => c.high - c.low <= baseMax)) continue;

      const incoming = candles[baseStart - 1];
      const outgoing = candles[baseEnd + 1];
      if (!incoming || !outgoing) continue;

      const outgoingRange = outgoing.high - outgoing.low;
      if (outgoingRange < legMin) continue;

      const incomingUp = incoming.close > incoming.open;
      const outgoingUp = outgoing.close > outgoing.open;

      const pattern: SupplyDemandZone['pattern'] = incomingUp
        ? outgoingUp
          ? 'RBR'
          : 'RBD'
        : outgoingUp
          ? 'DBR'
          : 'DBD';

      // The departure direction decides the zone's kind: price left upward, so
      // the base is demand.
      const kind: SupplyDemandZone['kind'] = outgoingUp ? 'demand' : 'supply';

      const top = Math.max(...base.map((c) => c.high));
      const bottom = Math.min(...base.map((c) => c.low));

      const barAtr = atrSeries[baseEnd + 1];
      const reference =
        Number.isFinite(barAtr) && (barAtr ?? 0) > 0 ? (barAtr as number) : outgoing.close * 0.01;

      // Has price come back to test it, and how often?
      let testCount = 0;
      for (let j = baseEnd + 2; j < candles.length; j++) {
        const candle = candles[j];
        if (!candle) continue;
        if (candle.low <= top && candle.high >= bottom) testCount++;
      }

      const departure = clamp((outgoingRange / reference) * 40, 0, 45);
      const tightness = clamp((1 - (top - bottom) / (avgRange * 3)) * 25, 0, 25);
      const freshness = testCount === 0 ? 20 : clamp(20 - testCount * 5, 0, 20);
      const continuation = pattern === 'RBR' || pattern === 'DBD' ? 10 : 5;

      zones.push({
        kind,
        top: round(top, 8),
        bottom: round(bottom, 8),
        time: base[0]?.time ?? outgoing.time,
        pattern,
        strength: round(clamp(departure + tightness + freshness + continuation, 0, 100), 2),
        tested: testCount > 0,
        testCount,
      });

      // One zone per base: longer variants of the same base would double-count.
      break;
    }
  }

  // Newest first, strongest retained.
  return zones
    .sort((a, b) => b.time - a.time || b.strength - a.strength)
    .slice(0, maxZones);
}

/* -------------------------------------------------------------------------- */
/* Institutional footprint                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Institutional activity score, 0–100.
 *
 * A composite of the evidence that something larger than retail flow has been
 * active: displacement candles on elevated volume, unmitigated order blocks and
 * gaps, confirmed sweeps, and decisive structure breaks.
 *
 * This is an *estimate from price and volume*, not order-flow data. It is
 * labelled as a footprint score in the UI rather than presented as observed
 * institutional positioning, because the platform cannot see the tape.
 */
export function institutionalFootprint(
  candles: Candle[],
  blocks: OrderBlock[],
  gaps: FairValueGap[],
  sweeps: LiquiditySweep[],
  events: StructureEvent[],
): number {
  const s = toSeries(candles);
  const atrSeries = atr(s.high, s.low, s.close, 14);
  const avgVolume = mean(s.volume) || 1;

  // Displacement candles in the recent window: large range *and* large volume.
  const window = Math.min(30, candles.length);
  let displacementCount = 0;

  for (let i = candles.length - window; i < candles.length; i++) {
    const candle = candles[i];
    const barAtr = atrSeries[i];
    if (!candle || barAtr === undefined || !Number.isFinite(barAtr) || barAtr <= 0) continue;

    const range = candle.high - candle.low;
    const body = Math.abs(candle.close - candle.open);
    // Body-dominant, not just wide: a wide indecision candle is not displacement.
    if (range > barAtr * 1.5 && body > range * 0.6 && candle.volume > avgVolume * 1.3) {
      displacementCount++;
    }
  }

  const displacementScore = clamp((displacementCount / Math.max(1, window * 0.2)) * 30, 0, 30);
  const blockScore = clamp(blocks.filter((b) => !b.mitigated).length * 6, 0, 20);
  const gapScore = clamp(gaps.filter((g) => !g.mitigated).length * 4, 0, 16);
  const sweepScore = clamp(sweeps.filter((s2) => s2.reversed).length * 8, 0, 20);
  const eventScore = clamp(
    events.slice(-5).reduce((acc, e) => acc + e.significance / 100, 0) * 5,
    0,
    14,
  );

  return round(
    clamp(displacementScore + blockScore + gapScore + sweepScore + eventScore, 0, 100),
    2,
  );
}

/* -------------------------------------------------------------------------- */
/* Aggregate                                                                  */
/* -------------------------------------------------------------------------- */

/** Full SMC/ICT readout for one timeframe. */
export function computeSmc(candles: Candle[], options: SmcOptions = {}): SmcAnalysis {
  const swingStrength = options.swingStrength ?? DEFAULTS.swingStrength;
  const maxPerKind = options.maxPerKind ?? DEFAULTS.maxPerKind;

  const swings = detectSwings(candles, swingStrength);
  const events = detectStructureEvents(candles, swings);
  const structure = analyseStructure(candles, swings, events);

  const orderBlocks = detectOrderBlocks(candles, events, maxPerKind);
  const fairValueGaps = detectFairValueGaps(candles, maxPerKind);
  const liquidityPools = detectLiquidityPools(candles, swings, maxPerKind);
  const liquiditySweeps = detectLiquiditySweeps(candles, liquidityPools);
  const supplyDemandZones = detectSupplyDemandZones(candles, maxPerKind);

  return {
    structure,
    orderBlocks,
    fairValueGaps,
    liquidityPools,
    liquiditySweeps,
    supplyDemandZones,
    institutionalFootprint: institutionalFootprint(
      candles,
      orderBlocks,
      fairValueGaps,
      liquiditySweeps,
      events,
    ),
  };
}

/** `Array.prototype.findLast`, written out for the project's ES target. */
function findLast<T>(items: T[], predicate: (item: T) => boolean): T | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return item;
  }
  return null;
}
