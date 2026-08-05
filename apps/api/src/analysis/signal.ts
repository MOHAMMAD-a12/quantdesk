/**
 * Signal generation.
 *
 * Everything here is deterministic. Entry, stop, targets, risk-reward,
 * confidence and probability are all computed from the analysis — the AI layer
 * later replaces the narrative fields with better prose, but it never touches a
 * number. A model asked to place a stop loss will produce a plausible one that no
 * test can falsify; a stop derived from an ATR and an invalidating swing can be
 * checked against the chart.
 *
 * The default answer is WAIT. A platform that emits a directional call on every
 * poll is a random number generator with a chart attached, so every gate below
 * — confluence magnitude, risk-reward, MTF permission, SMC confluence — can
 * independently return WAIT, and the reason is recorded rather than swallowed.
 */

import { randomUUID } from 'node:crypto';
import type {
  ConfidenceBreakdown,
  ConfluenceFactor,
  Direction,
  MtfConfirmation,
  Signal,
  SignalAction,
  SignalEngineConfig,
  SignalQuality,
  TakeProfitTarget,
  TechnicalAnalysis,
  TrendDirection,
} from '@quantdesk/shared';
import { TIMEFRAME_MS } from '@quantdesk/shared';
import { scoreByCategory, topFactors } from './confluence.js';
import { higherTimeframePermits } from './mtf.js';
import { nearestLevel } from './levels.js';
import { clamp, round, scale } from './series.js';

export interface SignalInput {
  analysis: TechnicalAnalysis;
  config: SignalEngineConfig;
  /** Decimal places for the instrument, from `MarketSymbol.pricePrecision`. */
  pricePrecision: number;
  /** Attributed when a user requested this analysis explicitly. */
  generatedBy?: string | null;
  now?: number;
}

/** A generated signal plus the machine-readable reason it came out that way. */
export interface SignalResult {
  signal: Signal;
  /** Populated on WAIT — which gate rejected the setup. */
  waitReason: string | null;
}

/** How stop placement is derived, recorded so the UI can explain it. */
interface TradePlan {
  entry: number;
  entryZone: { low: number; high: number };
  stopLoss: number;
  takeProfits: TakeProfitTarget[];
  riskRewardRatio: number;
  stopRationale: string;
}

/* -------------------------------------------------------------------------- */
/* Direction & confidence                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Confidence, decomposed.
 *
 * Each component is mapped to 0–100 where 50 is neutral, so a component that
 * contributes nothing pulls toward the middle rather than toward zero. The
 * overall figure is a weighted blend, then penalised for conditions that make any
 * read less trustworthy regardless of how the components scored.
 *
 * @param aiConviction The model's own 0–100 conviction, or null on the
 *   deterministic-only path — in which case the technical score stands in, since
 *   substituting 50 would systematically drag every deterministic signal below
 *   the threshold and silently disable the no-AI mode.
 */
export function buildConfidence(
  analysis: TechnicalAnalysis,
  direction: Direction,
  aiConviction: number | null,
): ConfidenceBreakdown {
  const categories = scoreByCategory(analysis.confluence);
  const sign = direction === 'bearish' ? -1 : 1;

  // A category score is -100..100 signed by direction; aligning it to the trade
  // direction and re-centring on 50 gives "how much does this support the trade".
  const align = (score: number): number => round(clamp(50 + (score * sign) / 2, 0, 100), 2);

  const technical = align(analysis.confluenceScore);
  const structure = align(categories.structure);
  const volume = align(categories.volume);
  const sentiment = align(categories.sentiment);

  const mtfAlignment = analysis.mtf
    ? round(
        analysis.mtf.dominantBias === direction
          ? clamp(50 + analysis.mtf.alignmentScore / 2, 0, 100)
          : analysis.mtf.dominantBias === 'neutral'
            ? 50
            : clamp(50 - analysis.mtf.alignmentScore / 2, 0, 100),
        2,
      )
    : 50;

  const conviction = aiConviction === null ? technical : clamp(aiConviction, 0, 100);

  const components: Array<{ value: number; weight: number }> = [
    { value: technical, weight: 1.4 },
    { value: mtfAlignment, weight: 1.1 },
    { value: structure, weight: 1.2 },
    { value: volume, weight: 0.7 },
    { value: sentiment, weight: 0.35 },
    { value: conviction, weight: 0.8 },
  ];

  const weightSum = components.reduce((acc, c) => acc + c.weight, 0);
  let overall = components.reduce((acc, c) => acc + c.value * c.weight, 0) / weightSum;

  // Penalties. These are multiplicative and deliberately blunt: they describe
  // conditions under which the *whole* read is less reliable, not conditions that
  // argue for the other side.
  if (analysis.volatility.regime === 'extreme') overall *= 0.88;
  if (analysis.smc.structure.clarity < 35) overall *= 0.9;
  if (analysis.mtf && analysis.mtf.conflicts.length >= 2) overall *= 0.85;
  if (analysis.candleCount < 120) overall *= 0.93;
  // Synthetic data can produce a technically perfect read of a fiction.
  if (analysis.synthetic) overall *= 0.5;

  return {
    overall: round(clamp(overall, 0, 100), 2),
    technical,
    mtfAlignment,
    structure,
    volume,
    sentiment,
    aiConviction: round(conviction, 2),
  };
}

/**
 * Probability that TP1 is reached before the stop.
 *
 * Anchored on the break-even win rate implied by the risk-reward — a 3R trade
 * only needs to work 25% of the time — then adjusted by confidence. This is a
 * *model*, not a measured frequency, and it is deliberately conservative: it
 * never returns above 85, because nothing in discretionary trading is 85%
 * certain and a number above that invites position sizes that blow up accounts.
 */
export function probabilityOfTarget(riskReward: number, confidence: number): number {
  if (!Number.isFinite(riskReward) || riskReward <= 0) return 0;

  // Break-even hit rate for this RR, as a percentage.
  const breakEven = (1 / (1 + riskReward)) * 100;

  // Confidence above 50 pushes the estimate above break-even, below pushes under.
  const edge = (confidence - 50) / 50; // -1..1
  const estimate = breakEven + edge * 20;

  return round(clamp(estimate, 5, 85), 2);
}

/**
 * Risk score 0–100, higher = riskier.
 *
 * Distinct from confidence and deliberately not its inverse: a high-confidence
 * trade into extreme volatility with a wide stop is both likely to work *and*
 * risky, and collapsing the two would hide that from position sizing.
 */
export function riskScore(analysis: TechnicalAnalysis, riskReward: number, stopDistancePercent: number): number {
  const components: Array<{ value: number; weight: number }> = [];

  // Volatility percentile maps almost directly onto risk.
  components.push({ value: clamp(analysis.volatility.percentile, 0, 100), weight: 1.2 });

  // A wide stop is a large loss when wrong, regardless of probability.
  components.push({ value: scale(stopDistancePercent, 0.3, 6, 10, 100), weight: 1 });

  // Poor RR means the trade must be right often to break even.
  components.push({ value: scale(riskReward, 4, 1, 10, 90), weight: 1 });

  // Unclear structure means the invalidation level is itself uncertain.
  components.push({ value: clamp(100 - analysis.smc.structure.clarity, 0, 100), weight: 0.8 });

  if (analysis.mtf) {
    components.push({ value: clamp(analysis.mtf.conflicts.length * 30, 0, 100), weight: 0.7 });
  }

  const weightSum = components.reduce((acc, c) => acc + c.weight, 0);
  const weighted = components.reduce((acc, c) => acc + c.value * c.weight, 0);
  return round(clamp(weighted / weightSum, 0, 100), 2);
}

/** Quality band from confidence, RR and risk together. */
export function qualityOf(confidence: number, riskReward: number, risk: number): SignalQuality {
  // A high-confidence, high-RR, low-risk setup is the only thing that earns
  // "premium" — the label has to be scarce to mean anything.
  const composite = confidence * 0.5 + clamp(riskReward * 20, 0, 100) * 0.3 + (100 - risk) * 0.2;

  if (composite >= 80 && riskReward >= 2.5) return 'premium';
  if (composite >= 70) return 'high';
  if (composite >= 58) return 'good';
  if (composite >= 45) return 'fair';
  return 'low';
}

/* -------------------------------------------------------------------------- */
/* Trade plan                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Place entry, stop and targets.
 *
 * **The stop goes beyond the structure that invalidates the idea, not at a fixed
 * ATR multiple.** A stop at 1.5×ATR sits wherever the arithmetic lands, which is
 * frequently just inside the swing low every other trader is also watching — the
 * exact price the market reaches for before continuing. So the anchor is the
 * invalidating swing (or order block edge), padded by a fraction of ATR to clear
 * the wick, with the ATR multiple acting only as a floor for when no structure is
 * close enough to be useful.
 *
 * @returns null when no coherent plan exists — a stop that would be 12% away, or
 *   a target with no room before the next opposing level.
 */
export function buildTradePlan(
  analysis: TechnicalAnalysis,
  direction: Direction,
  precision: number,
): TradePlan | null {
  if (direction === 'neutral') return null;

  const price = analysis.price;
  const atr = analysis.indicators.atr;
  if (!(price > 0) || !Number.isFinite(atr) || atr <= 0) return null;

  const long = direction === 'bullish';

  // Entry is a zone, not a point: SMC entries are areas, and an exact-price limit
  // order frequently misses by a tick.
  const entryHalfWidth = atr * 0.15;
  const entry = price;
  const entryZone = {
    low: round(entry - entryHalfWidth, precision),
    high: round(entry + entryHalfWidth, precision),
  };

  // --- Stop placement -------------------------------------------------------
  const structuralAnchor = findInvalidationAnchor(analysis, long);
  const padding = atr * 0.25;
  const atrFloorStop = long ? price - atr * 1.5 : price + atr * 1.5;

  let stopLoss: number;
  let stopRationale: string;

  if (structuralAnchor !== null) {
    const structural = long ? structuralAnchor.price - padding : structuralAnchor.price + padding;
    const structuralDistance = Math.abs(price - structural);

    // Reject a structural stop that is absurdly far: better to fall back to ATR
    // than to propose a trade whose risk is 9% of capital-at-risk per unit.
    if (structuralDistance > atr * 4) {
      stopLoss = atrFloorStop;
      stopRationale = `1.5×ATR (${round(atr, precision)}) — nearest invalidation at ${round(structuralAnchor.price, precision)} is too far to use`;
    } else {
      // Take whichever is further from price: a structural stop tighter than
      // 0.6×ATR will be taken out by noise alone.
      const minDistance = atr * 0.6;
      const useStructural = structuralDistance >= minDistance;

      stopLoss = useStructural ? structural : long ? price - minDistance : price + minDistance;
      stopRationale = useStructural
        ? `Beyond ${structuralAnchor.label} at ${round(structuralAnchor.price, precision)}, padded 0.25×ATR`
        : `0.6×ATR minimum — ${structuralAnchor.label} at ${round(structuralAnchor.price, precision)} is inside the noise band`;
    }
  } else {
    stopLoss = atrFloorStop;
    stopRationale = `1.5×ATR (${round(atr, precision)}) — no invalidating structure within range`;
  }

  stopLoss = round(stopLoss, precision);
  const risk = Math.abs(entry - stopLoss);

  // A stop wider than 8% is not a trade this platform should propose; the
  // position size required to keep risk sane rounds to nothing.
  if (!(risk > 0) || risk / price > 0.08) return null;

  // --- Targets --------------------------------------------------------------
  const takeProfits = buildTargets(analysis, direction, entry, risk, precision);
  const first = takeProfits[0];
  if (!first) return null;

  return {
    entry: round(entry, precision),
    entryZone,
    stopLoss,
    takeProfits,
    riskRewardRatio: first.rr,
    stopRationale,
  };
}

/** The structure whose violation would mean the idea is wrong. */
function findInvalidationAnchor(
  analysis: TechnicalAnalysis,
  long: boolean,
): { price: number; label: string } | null {
  const price = analysis.price;
  const candidates: Array<{ price: number; label: string }> = [];

  // The order block being traded from is the primary invalidation: price closing
  // through it means the institutional bid/offer was not there.
  const block = analysis.smc.orderBlocks
    .filter((b) => b.direction === (long ? 'bullish' : 'bearish'))
    .filter((b) => (long ? b.bottom < price : b.top > price))
    .sort((a, b) => (long ? b.bottom - a.bottom : a.top - b.top))[0];

  if (block) {
    candidates.push({ price: long ? block.bottom : block.top, label: `${block.direction} order block` });
  }

  // The most recent confirmed swing in the opposing direction.
  const swing = [...analysis.smc.structure.swings]
    .reverse()
    .find((s) => (long ? s.kind === 'low' && s.price < price : s.kind === 'high' && s.price > price));

  if (swing) {
    candidates.push({ price: swing.price, label: `swing ${swing.label}` });
  }

  // A support/resistance level below/above price.
  const level = nearestLevel(long ? analysis.supportLevels : analysis.resistanceLevels, price, !long);
  if (level) {
    candidates.push({ price: level.price, label: `${level.kind} at ${level.price}` });
  }

  // A recent sweep wick — price returning below it invalidates the reversal.
  const sweep = analysis.smc.liquiditySweeps.find((s) => s.reversed && s.direction === (long ? 'bullish' : 'bearish'));
  if (sweep) {
    candidates.push({ price: sweep.level, label: 'swept liquidity level' });
  }

  if (candidates.length === 0) return null;

  // Nearest valid anchor: the tightest invalidation that still respects
  // structure. A further one would only widen risk for no additional protection.
  return candidates
    .filter((c) => (long ? c.price < price : c.price > price))
    .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0] ?? null;
}

/**
 * Three targets, preferring real structure over round R multiples.
 *
 * TP1 aims at the nearest opposing level — where price is genuinely likely to
 * react — while TP2 and TP3 extend to further structure or fall back to fixed R
 * multiples. Allocations front-load: taking partial profit at the level most
 * likely to be hit is what converts a good read into a realised gain.
 */
function buildTargets(
  analysis: TechnicalAnalysis,
  direction: Direction,
  entry: number,
  risk: number,
  precision: number,
): TakeProfitTarget[] {
  const long = direction === 'bullish';
  const opposing = long ? analysis.resistanceLevels : analysis.supportLevels;

  // Structural candidates ahead of price, nearest first.
  const structural: Array<{ price: number; rationale: string }> = [];

  for (const level of opposing) {
    if (long ? level.price > entry : level.price < entry) {
      structural.push({ price: level.price, rationale: `${level.kind} (${level.touches} touches)` });
    }
  }

  // Unfilled gaps ahead act as draws on liquidity.
  for (const gap of analysis.smc.fairValueGaps) {
    if (gap.mitigated) continue;
    const mid = (gap.top + gap.bottom) / 2;
    if (long ? mid > entry : mid < entry) {
      structural.push({ price: mid, rationale: 'unfilled fair value gap' });
    }
  }

  // Liquidity pools are where stops rest, and price reaches for them.
  for (const pool of analysis.smc.liquidityPools) {
    if (pool.swept) continue;
    if (long ? pool.price > entry : pool.price < entry) {
      structural.push({ price: pool.price, rationale: `${pool.kind} liquidity` });
    }
  }

  // Fibonacci extensions of the active leg.
  const fib = analysis.indicators.fibonacci;
  if (fib) {
    for (const [ratio, value] of Object.entries(fib.extensions)) {
      if (long ? value > entry : value < entry) {
        structural.push({ price: value, rationale: `${ratio} Fibonacci extension` });
      }
    }
  }

  const ordered = structural
    .filter((c) => Number.isFinite(c.price))
    .sort((a, b) => (long ? a.price - b.price : b.price - a.price));

  // Deduplicate: several structures within a fifth of the risk distance are one
  // target, and reporting them as three would imply precision that is not there.
  const deduped: Array<{ price: number; rationale: string }> = [];
  for (const candidate of ordered) {
    const clash = deduped.some((d) => Math.abs(d.price - candidate.price) < risk * 0.2);
    if (!clash) deduped.push(candidate);
  }

  // Minimum R multiples per target — a "target" at 0.4R is not worth the spread.
  const minR = [1, 1.8, 3];
  const allocations = [0.5, 0.3, 0.2];
  const targets: TakeProfitTarget[] = [];

  for (let i = 0; i < 3; i++) {
    const floorR = minR[i] ?? 1;
    const floorPrice = long ? entry + risk * floorR : entry - risk * floorR;

    const structuralHit = deduped.find((candidate) => {
      const beyondFloor = long ? candidate.price >= floorPrice : candidate.price <= floorPrice;
      const beyondPrevious =
        targets.length === 0 ||
        (long
          ? candidate.price > (targets[targets.length - 1] as TakeProfitTarget).price
          : candidate.price < (targets[targets.length - 1] as TakeProfitTarget).price);
      return beyondFloor && beyondPrevious;
    });

    const chosen = structuralHit ?? { price: floorPrice, rationale: `${floorR}R fixed target` };
    if (structuralHit) deduped.splice(deduped.indexOf(structuralHit), 1);

    const reward = Math.abs(chosen.price - entry);
    targets.push({
      level: (i + 1) as 1 | 2 | 3,
      price: round(chosen.price, precision),
      rr: round(reward / risk, 2),
      allocation: allocations[i] ?? 0,
      rationale: chosen.rationale,
    });
  }

  return targets;
}

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/** Expected holding period from timeframe and expected move. */
function expectedDuration(
  timeframe: TechnicalAnalysis['timeframe'],
  barsToTarget: number,
): { label: string; ms: number } {
  const bucketMs = TIMEFRAME_MS[timeframe];
  const ms = bucketMs * barsToTarget;
  const hours = ms / 3_600_000;

  if (hours < 1) return { label: `${Math.max(5, Math.round(ms / 60_000))}–${Math.round((ms / 60_000) * 2)} minutes`, ms };
  if (hours < 24) return { label: `${Math.round(hours)}–${Math.round(hours * 2)} hours`, ms };

  const days = hours / 24;
  return { label: `${Math.round(days)}–${Math.round(days * 2)} days`, ms };
}

/**
 * Generate a signal from a completed analysis.
 *
 * The narrative fields are populated deterministically here. The AI layer
 * overwrites `reasoning`, `marketStructureExplanation`, `keyFactors` and
 * `invalidation` when a provider is available — so a platform running with no AI
 * configured still produces complete, readable signals rather than blank ones.
 */
export function generateSignal(input: SignalInput): SignalResult {
  const { analysis, config, pricePrecision, generatedBy = null, now = Date.now() } = input;

  const score = analysis.confluenceScore;
  const direction: Direction = score > 0 ? 'bullish' : score < 0 ? 'bearish' : 'neutral';
  const trendDirection: TrendDirection = analysis.smc.structure.trend;

  const factors = analysis.confluence;
  const ranked = topFactors(factors, 6, config.categoryWeights);

  const wait = (reason: string, confidence: number, breakdown: ConfidenceBreakdown): SignalResult => ({
    signal: assemble({
      analysis,
      action: 'WAIT',
      bias: direction,
      trendDirection,
      confidence,
      breakdown,
      probability: 0,
      risk: 50,
      quality: 'low',
      plan: null,
      factors,
      ranked,
      reasoning: `No actionable setup: ${reason}`,
      structureExplanation: describeStructure(analysis),
      invalidation: 'Not applicable — no position proposed.',
      duration: { label: 'n/a', ms: TIMEFRAME_MS[analysis.timeframe] * 12 },
      expectedMovePercent: 0,
      generatedBy,
      now,
    }),
    waitReason: reason,
  });

  const provisional = buildConfidence(analysis, direction === 'neutral' ? 'bullish' : direction, null);

  // --- Gates ----------------------------------------------------------------

  if (direction === 'neutral' || Math.abs(score) < 15) {
    return wait(
      `confluence is balanced (net ${score.toFixed(1)}), with no side holding an edge`,
      provisional.overall,
      provisional,
    );
  }

  if (analysis.mtf && analysis.mtf.alignmentScore < config.minMtfAlignment) {
    return wait(
      `multi-timeframe alignment ${analysis.mtf.alignmentScore.toFixed(0)} is below the ${config.minMtfAlignment} minimum${analysis.mtf.conflicts.length > 0 ? ` (${analysis.mtf.conflicts.join(', ')} disagree)` : ''}`,
      provisional.overall,
      provisional,
    );
  }

  if (analysis.mtf && !higherTimeframePermits(analysis.mtf, direction)) {
    return wait(
      `higher timeframes are convicted ${analysis.mtf.dominantBias} against this ${direction} setup`,
      provisional.overall,
      provisional,
    );
  }

  if (config.requireSmcConfluence && !hasSmcConfluence(analysis, direction)) {
    return wait(
      'no unmitigated order block, unfilled gap or fresh zone supports an entry here',
      provisional.overall,
      provisional,
    );
  }

  const plan = buildTradePlan(analysis, direction, pricePrecision);
  if (!plan) {
    return wait(
      'no coherent stop and target placement exists at current price',
      provisional.overall,
      provisional,
    );
  }

  if (plan.riskRewardRatio < config.minRiskReward) {
    return wait(
      `risk-reward to the first target is ${plan.riskRewardRatio.toFixed(2)}, below the ${config.minRiskReward} minimum`,
      provisional.overall,
      provisional,
    );
  }

  // --- The setup passed -----------------------------------------------------

  const breakdown = buildConfidence(analysis, direction, null);
  const stopDistancePercent = (Math.abs(plan.entry - plan.stopLoss) / plan.entry) * 100;
  const risk = riskScore(analysis, plan.riskRewardRatio, stopDistancePercent);
  const probability = probabilityOfTarget(plan.riskRewardRatio, breakdown.overall);
  const quality = qualityOf(breakdown.overall, plan.riskRewardRatio, risk);

  const firstTarget = plan.takeProfits[0] as TakeProfitTarget;
  const expectedMovePercent = round(((firstTarget.price - plan.entry) / plan.entry) * 100, 3);

  // Bars-to-target scales with how far the target is in ATR units — a 4×ATR move
  // takes materially longer than a 1×ATR one on the same timeframe.
  const atrMultiples = analysis.indicators.atr > 0
    ? Math.abs(firstTarget.price - plan.entry) / analysis.indicators.atr
    : 2;
  const duration = expectedDuration(analysis.timeframe, clamp(Math.round(atrMultiples * 4), 3, 60));

  const action: SignalAction = direction === 'bullish' ? 'BUY' : 'SELL';

  return {
    signal: assemble({
      analysis,
      action,
      bias: direction,
      trendDirection,
      confidence: breakdown.overall,
      breakdown,
      probability,
      risk,
      quality,
      plan,
      factors,
      ranked,
      reasoning: describeSetup(analysis, direction, plan, ranked),
      structureExplanation: describeStructure(analysis),
      invalidation: `A close ${direction === 'bullish' ? 'below' : 'above'} ${plan.stopLoss} invalidates the idea. Stop placement: ${plan.stopRationale}.`,
      duration,
      expectedMovePercent,
      generatedBy,
      now,
    }),
    waitReason: null,
  };
}

/** Whether an SMC structure supports an entry in this direction right now. */
function hasSmcConfluence(analysis: TechnicalAnalysis, direction: Direction): boolean {
  const price = analysis.price;
  if (price <= 0) return false;

  const within = (value: number, tolerance: number): boolean => Math.abs(price - value) / price <= tolerance;

  const block = analysis.smc.orderBlocks.some(
    (b) => !b.mitigated && b.direction === direction && within((b.top + b.bottom) / 2, 0.03),
  );
  if (block) return true;

  const gap = analysis.smc.fairValueGaps.some(
    (g) => !g.mitigated && g.direction === direction && within((g.top + g.bottom) / 2, 0.03),
  );
  if (gap) return true;

  const zone = analysis.smc.supplyDemandZones.some(
    (z) => z.kind === (direction === 'bullish' ? 'demand' : 'supply') && within((z.top + z.bottom) / 2, 0.025),
  );
  if (zone) return true;

  return analysis.smc.liquiditySweeps.some((s) => s.reversed && s.direction === direction);
}

/** Deterministic structural narrative, replaced by the AI layer when available. */
function describeStructure(analysis: TechnicalAnalysis): string {
  const { structure } = analysis.smc;
  const parts: string[] = [];

  parts.push(
    `Market structure on the ${analysis.timeframe} is ${structure.trend} with ${structure.clarity.toFixed(0)}% clarity.`,
  );

  if (structure.lastEvent) {
    const event = structure.lastEvent;
    parts.push(
      `The most recent structural event is a ${event.direction} ${event.type} that broke ${event.brokenLevel} and confirmed on a close at ${event.confirmedAt} (significance ${event.significance.toFixed(0)}/100).`,
    );
  } else {
    parts.push('No confirmed break of structure has occurred in the analysed window.');
  }

  if (structure.dealingRange) {
    parts.push(
      `Price sits in the ${structure.premiumDiscount} of the dealing range ${structure.dealingRange.low}–${structure.dealingRange.high} (equilibrium ${structure.dealingRange.equilibrium}).`,
    );
  }

  const unmitigated = analysis.smc.orderBlocks.filter((b) => !b.mitigated).length;
  const openGaps = analysis.smc.fairValueGaps.filter((g) => !g.mitigated).length;
  parts.push(`${unmitigated} unmitigated order block(s) and ${openGaps} unfilled fair value gap(s) remain.`);

  const sweep = analysis.smc.liquiditySweeps.find((s) => s.reversed);
  if (sweep) {
    parts.push(
      `Liquidity at ${sweep.level} was swept and rejected within ${sweep.reversalBars} bars — a ${sweep.direction} reaction.`,
    );
  }

  parts.push(`Institutional footprint score: ${analysis.smc.institutionalFootprint.toFixed(0)}/100.`);

  return parts.join(' ');
}

/** Deterministic setup narrative, replaced by the AI layer when available. */
function describeSetup(
  analysis: TechnicalAnalysis,
  direction: Direction,
  plan: TradePlan,
  ranked: ConfluenceFactor[],
): string {
  const side = direction === 'bullish' ? 'long' : 'short';
  const parts: string[] = [];

  parts.push(
    `${analysis.symbol} presents a ${side} setup on the ${analysis.timeframe} with a net confluence of ${analysis.confluenceScore.toFixed(1)}.`,
  );

  const drivers = ranked.slice(0, 3).map((f) => f.detail);
  if (drivers.length > 0) parts.push(`The decisive factors are: ${drivers.join('; ')}.`);

  parts.push(
    `Entry is the ${plan.entryZone.low}–${plan.entryZone.high} zone with a stop at ${plan.stopLoss} (${plan.stopRationale}), targeting ${plan.takeProfits.map((t) => `${t.price} (${t.rr}R, ${t.rationale})`).join(', ')}.`,
  );

  if (analysis.mtf) {
    parts.push(
      `Multi-timeframe alignment is ${analysis.mtf.alignmentScore.toFixed(0)}/100 ${analysis.mtf.dominantBias}${analysis.mtf.conflicts.length > 0 ? `, with ${analysis.mtf.conflicts.join(' and ')} disagreeing` : ' across all consulted timeframes'}.`,
    );
  }

  parts.push(
    `Volatility is ${analysis.volatility.regime} at the ${analysis.volatility.percentile.toFixed(0)}th percentile (ATR ${analysis.volatility.atrPercent.toFixed(2)}%)${analysis.volatility.squeeze ? ', with bandwidth compressed into a squeeze' : ''}.`,
  );

  return parts.join(' ');
}

/** Assemble the persisted shape. Kept separate so both paths agree on it. */
function assemble(args: {
  analysis: TechnicalAnalysis;
  action: SignalAction;
  bias: Direction;
  trendDirection: TrendDirection;
  confidence: number;
  breakdown: ConfidenceBreakdown;
  probability: number;
  risk: number;
  quality: SignalQuality;
  plan: TradePlan | null;
  factors: ConfluenceFactor[];
  ranked: ConfluenceFactor[];
  reasoning: string;
  structureExplanation: string;
  invalidation: string;
  duration: { label: string; ms: number };
  expectedMovePercent: number;
  generatedBy: string | null;
  now: number;
}): Signal {
  const { analysis, plan, now } = args;

  return {
    id: randomUUID(),
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    action: args.action,

    confidence: args.confidence,
    confidenceBreakdown: args.breakdown,
    probabilityScore: args.probability,
    riskScore: args.risk,
    quality: args.quality,

    // Null on WAIT, enforced by the `signals_levels_consistency` DB constraint.
    entry: plan?.entry ?? null,
    entryZone: plan?.entryZone ?? null,
    stopLoss: plan?.stopLoss ?? null,
    takeProfits: plan?.takeProfits ?? [],
    riskRewardRatio: plan?.riskRewardRatio ?? null,

    trendDirection: args.trendDirection,
    bias: args.bias,
    trendStrength: analysis.trendStrength,

    reasoning: args.reasoning,
    marketStructureExplanation: args.structureExplanation,
    keyFactors: args.ranked.map((f) => f.detail),
    invalidation: args.invalidation,

    expectedDuration: args.duration.label,
    expectedDurationMs: args.duration.ms,
    expectedMovePercent: args.expectedMovePercent,

    confluence: args.factors,
    confluenceScore: analysis.confluenceScore,

    status: 'active',
    priceAtGeneration: analysis.price,
    createdAt: now,
    // Expiry is the expected duration with headroom: an idea that has not
    // resolved in three times its expected window has been overtaken by events.
    expiresAt: now + Math.max(args.duration.ms * 3, TIMEFRAME_MS[analysis.timeframe] * 12),

    aiProvider: 'deterministic',
    aiModel: 'quant-engine',
    deterministicOnly: true,
    synthetic: analysis.synthetic,
  };
}
