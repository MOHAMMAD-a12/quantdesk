/**
 * Multi-timeframe confirmation.
 *
 * A setup that looks clean on the 15m and is fighting a 4h downtrend is not a
 * setup, it is a countertrend scalp being mistaken for one. This module reduces
 * each timeframe to a single verdict, then measures how strongly those verdicts
 * agree.
 *
 * Two properties matter in how the aggregate is computed.
 *
 * **Higher timeframes weigh more.** The daily bias is the context the 15m trades
 * inside, not a peer of it. Weights rise with timeframe duration, so a daily
 * conflict suppresses alignment far more than a 15m one.
 *
 * **Alignment is not a vote count.** Three timeframes agreeing weakly is a worse
 * setup than two agreeing with conviction, so conviction scales each vote. A
 * unanimous set of low-conviction verdicts produces a middling alignment score,
 * which is the honest reading: nothing is confirming anything.
 */

import type {
  Direction,
  MtfConfirmation,
  TechnicalAnalysis,
  Timeframe,
  TimeframeVerdict,
  TrendDirection,
} from '@quantdesk/shared';
import { clamp, round } from './series.js';

/**
 * Relative authority of each timeframe.
 *
 * Roughly logarithmic in bar duration rather than linear: a 1d bar is 96× a 15m
 * bar in time but nothing like 96× as important to a swing decision, and a linear
 * weighting would make every lower timeframe irrelevant.
 */
const TIMEFRAME_WEIGHT: Record<Timeframe, number> = {
  '1m': 0.35,
  '5m': 0.5,
  '15m': 0.7,
  '30m': 0.85,
  '1h': 1.0,
  '4h': 1.4,
  '1d': 1.8,
  '1w': 2.2,
};

function weightOf(timeframe: Timeframe): number {
  return TIMEFRAME_WEIGHT[timeframe] ?? 1;
}

/**
 * Reduce a full analysis to one timeframe's verdict.
 *
 * The bias comes from the confluence score, which already folds in trend,
 * momentum, structure and volume for that timeframe. Conviction combines the
 * magnitude of that score with trend strength — a ±20 confluence in a strongly
 * trending market means something different from ±20 in a chop.
 */
export function verdictFor(analysis: TechnicalAnalysis): TimeframeVerdict {
  const score = Number.isFinite(analysis.confluenceScore) ? analysis.confluenceScore : 0;

  // A ±12 band around zero is treated as no bias. Without a deadband the sign of
  // a near-zero score flips on every poll and the alignment reading with it.
  const bias: Direction = score > 12 ? 'bullish' : score < -12 ? 'bearish' : 'neutral';

  const magnitude = clamp(Math.abs(score), 0, 100);
  const trendComponent = clamp(analysis.trendStrength, 0, 100);

  // Magnitude leads; trend strength corroborates. A neutral bias caps conviction
  // low regardless, because there is nothing to be convicted about.
  const conviction =
    bias === 'neutral'
      ? round(clamp(magnitude * 0.5, 0, 35), 2)
      : round(clamp(magnitude * 0.7 + trendComponent * 0.3, 0, 100), 2);

  return {
    timeframe: analysis.timeframe,
    bias,
    conviction,
    trend: analysis.smc.structure.trend,
    keyNote: buildKeyNote(analysis),
  };
}

/**
 * One-line summary of what defines this timeframe right now.
 *
 * Deliberately terse and deterministic — it goes into the AI prompt as context
 * and into the MTF table in the UI, and both are better served by a consistent
 * shape than by prose.
 */
function buildKeyNote(analysis: TechnicalAnalysis): string {
  const parts: string[] = [];
  const { structure } = analysis.smc;

  const lastEvent = structure.lastEvent;
  if (lastEvent) {
    parts.push(`${lastEvent.type} ${lastEvent.direction} @ ${lastEvent.brokenLevel}`);
  } else {
    parts.push(`${structure.trend} structure`);
  }

  parts.push(`${structure.premiumDiscount}`);

  if (Number.isFinite(analysis.indicators.rsi)) {
    parts.push(`RSI ${Math.round(analysis.indicators.rsi)}`);
  }

  if (analysis.volatility.squeeze) parts.push('volatility squeeze');
  else if (analysis.volatility.regime !== 'normal') parts.push(`${analysis.volatility.regime} volatility`);

  const freshSweep = analysis.smc.liquiditySweeps.find((s) => s.reversed);
  if (freshSweep) parts.push(`${freshSweep.direction} sweep of ${freshSweep.level}`);

  return parts.join(' · ');
}

/**
 * Combine per-timeframe verdicts into an alignment reading.
 *
 * `alignmentScore` is the share of total conviction-weighted authority pointing
 * the dominant way, rescaled so that a perfectly split book reads 0 rather than
 * 50. That rescale matters: the signal engine gates on this number, and a
 * two-against-two standoff must not clear a 50-point threshold.
 *
 * @param verdicts One per consulted timeframe. An empty array yields a neutral,
 *   zero-alignment result rather than throwing — a symbol whose higher
 *   timeframes have no history is unconfirmed, not an error.
 */
export function combineVerdicts(verdicts: TimeframeVerdict[]): MtfConfirmation {
  if (verdicts.length === 0) {
    return { verdicts: [], alignmentScore: 0, dominantBias: 'neutral', conflicts: [] };
  }

  let bullish = 0;
  let bearish = 0;
  let authority = 0;

  for (const verdict of verdicts) {
    const weight = weightOf(verdict.timeframe);
    // Conviction scales the vote so agreement between uncertain timeframes does
    // not read as confirmation.
    const strength = weight * (clamp(verdict.conviction, 0, 100) / 100);

    authority += weight;
    if (verdict.bias === 'bullish') bullish += strength;
    else if (verdict.bias === 'bearish') bearish += strength;
    // Neutral verdicts contribute authority but no directional strength, which
    // correctly dilutes the score rather than being ignored.
  }

  const net = bullish - bearish;
  const dominantBias: Direction = net > 0 ? 'bullish' : net < 0 ? 'bearish' : 'neutral';

  // Net directional strength as a share of total available authority.
  const alignmentScore = authority > 0 ? round(clamp((Math.abs(net) / authority) * 100, 0, 100), 2) : 0;

  const conflicts = verdicts
    .filter((v) => dominantBias !== 'neutral' && v.bias !== 'neutral' && v.bias !== dominantBias)
    .map((v) => v.timeframe);

  return { verdicts, alignmentScore, dominantBias, conflicts };
}

/**
 * Build the confirmation from the per-timeframe analyses.
 *
 * Verdicts are ordered highest timeframe first, matching how a trader reads them
 * — context before entry.
 */
export function computeMtf(analyses: TechnicalAnalysis[]): MtfConfirmation {
  const verdicts = analyses
    .map((analysis) => verdictFor(analysis))
    .sort((a, b) => weightOf(b.timeframe) - weightOf(a.timeframe));

  return combineVerdicts(verdicts);
}

/**
 * Whether the higher timeframes permit a trade in `direction`.
 *
 * Used as a veto rather than a score. The highest-authority timeframe with a
 * non-neutral bias is the arbiter: trading long into a convicted daily downtrend
 * is the mistake this exists to prevent, and no amount of lower-timeframe
 * confluence should override it.
 *
 * A neutral higher-timeframe book permits either direction — an unconfirmed trade
 * is not a prohibited one.
 */
export function higherTimeframePermits(
  mtf: MtfConfirmation,
  direction: Direction,
  minConviction = 55,
): boolean {
  if (direction === 'neutral') return true;

  const authoritative = mtf.verdicts
    .filter((v) => v.bias !== 'neutral' && v.conviction >= minConviction)
    .sort((a, b) => weightOf(b.timeframe) - weightOf(a.timeframe))[0];

  if (!authoritative) return true;
  return authoritative.bias === direction;
}

/** Trend label from the highest-authority timeframe, for headline display. */
export function dominantTrend(mtf: MtfConfirmation): TrendDirection {
  const top = mtf.verdicts[0];
  return top?.trend ?? 'ranging';
}
