/**
 * Confluence scoring.
 *
 * Everything upstream of this module *measures*; this module *judges*. Each
 * measurement becomes a {@link ConfluenceFactor} carrying a direction, a signed
 * score and a weight, and the net of those is the number the signal engine acts
 * on.
 *
 * Three rules keep the score honest.
 *
 * **One observation, one factor.** The same underlying fact must not be counted
 * twice under different names. Price above the 200 EMA and a bullish EMA stack
 * are correlated but distinct claims — one is location, one is ordering — so both
 * appear. RSI above 50 and a positive MACD histogram are *also* correlated, which
 * is why momentum carries a lower category weight rather than being enumerated
 * into six near-identical factors.
 *
 * **Absent evidence produces no factor.** A symbol without the history for a 200
 * EMA does not get a neutral placeholder; the factor is simply not emitted and
 * the weighted average adjusts. Emitting neutral factors would drag every score
 * toward zero in proportion to how little data was available, which reads as
 * "conflicted" when the truth is "unknown".
 *
 * **Scores are signed by direction, not by desirability.** A factor's `score` is
 * positive for bullish and negative for bearish, always. The engine decides which
 * of those it wants.
 */

import type {
  CandlestickPattern,
  ConfluenceFactor,
  DerivativesContext,
  Direction,
  FearGreedIndex,
  IndicatorSnapshot,
  PriceLevel,
  SentimentSnapshot,
  SmcAnalysis,
  VolatilityState,
} from '@quantdesk/shared';
import { patternBias } from './patterns.js';
import { clamp, round, scale } from './series.js';

/** Everything the confluence layer can read. Optional inputs degrade silently. */
export interface ConfluenceInput {
  price: number;
  indicators: IndicatorSnapshot;
  smc: SmcAnalysis;
  patterns: CandlestickPattern[];
  supportLevels: PriceLevel[];
  resistanceLevels: PriceLevel[];
  volatility: VolatilityState;
  lastIndex: number;
  /** Present only for crypto, and only when the venue exposes it. */
  derivatives?: DerivativesContext | null;
  sentiment?: SentimentSnapshot | null;
  fearGreed?: FearGreedIndex | null;
}

/** Default category weights, overridden by `SignalEngineConfig.categoryWeights`. */
export const DEFAULT_CATEGORY_WEIGHTS: Record<ConfluenceFactor['category'], number> = {
  trend: 1.0,
  momentum: 0.8,
  structure: 1.25,
  volume: 0.9,
  volatility: 0.6,
  levels: 1.0,
  sentiment: 0.4,
  derivatives: 0.6,
};

/** Build a factor, normalising the score/direction relationship. */
function factor(
  key: string,
  label: string,
  category: ConfluenceFactor['category'],
  score: number,
  weight: number,
  detail: string,
): ConfluenceFactor {
  const bounded = clamp(score, -100, 100);
  return {
    key,
    label,
    category,
    direction: bounded > 0 ? 'bullish' : bounded < 0 ? 'bearish' : 'neutral',
    score: round(bounded, 2),
    weight: round(clamp(weight, 0, 1), 3),
    detail,
  };
}

/* -------------------------------------------------------------------------- */
/* Trend                                                                      */
/* -------------------------------------------------------------------------- */

function trendFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { indicators, price } = input;
  const out: ConfluenceFactor[] = [];

  // EMA stack ordering — the cleanest single read on trend agreement.
  const stack = [9, 21, 50, 200]
    .map((p) => ({ period: p, value: indicators.ema[p] }))
    .filter((e): e is { period: number; value: number } => e.value !== undefined && Number.isFinite(e.value));

  if (stack.length >= 3) {
    let ordered = 0;
    for (let i = 0; i < stack.length - 1; i++) {
      const a = stack[i];
      const b = stack[i + 1];
      if (!a || !b) continue;
      if (a.value > b.value) ordered++;
      else if (a.value < b.value) ordered--;
    }
    const pairs = stack.length - 1;
    const score = (ordered / pairs) * 100;
    const label = ordered > 0 ? 'ascending' : ordered < 0 ? 'descending' : 'interleaved';

    out.push(
      factor(
        'trend.ema_stack',
        'EMA stack alignment',
        'trend',
        score,
        1,
        `${stack.map((e) => e.period).join(' > ')} ${label} (${Math.abs(ordered)}/${pairs} pairs in order)`,
      ),
    );
  }

  // Price relative to the slowest available anchor: the "which side of the market
  // am I on" question, scaled by how far away it is.
  const anchorPeriod = [200, 100, 50].find(
    (p) => indicators.ema[p] !== undefined && Number.isFinite(indicators.ema[p] as number),
  );
  const anchor = anchorPeriod !== undefined ? indicators.ema[anchorPeriod] : undefined;

  if (anchor !== undefined && anchor > 0 && price > 0) {
    const distancePercent = ((price - anchor) / anchor) * 100;
    // Saturates at ±5%: beyond that the trade is extended, not more trending.
    out.push(
      factor(
        'trend.price_vs_anchor',
        `Price vs EMA ${anchorPeriod}`,
        'trend',
        scale(distancePercent, -5, 5, -100, 100),
        0.9,
        `${distancePercent >= 0 ? 'Above' : 'Below'} EMA ${anchorPeriod} by ${Math.abs(distancePercent).toFixed(2)}%`,
      ),
    );
  }

  // ADX supplies conviction, DI supplies direction. Below 20 the pair is noise.
  const { adx, plusDi, minusDi } = indicators.adx;
  if (Number.isFinite(adx) && Number.isFinite(plusDi) && Number.isFinite(minusDi)) {
    const diTotal = plusDi + minusDi;
    const diBias = diTotal > 0 ? (plusDi - minusDi) / diTotal : 0;
    const conviction = clamp(scale(adx, 15, 45, 0, 1), 0, 1);

    if (adx >= 20) {
      out.push(
        factor(
          'trend.adx',
          'ADX directional strength',
          'trend',
          diBias * 100 * conviction,
          1,
          `ADX ${adx.toFixed(1)} with ${plusDi > minusDi ? '+DI' : '-DI'} dominant (${plusDi.toFixed(1)} / ${minusDi.toFixed(1)})`,
        ),
      );
    } else {
      // An explicit low-ADX factor at score 0 is one of the few neutral factors
      // worth emitting: "the market is not trending" is itself information the
      // narrative layer should state rather than infer from an absence.
      out.push(
        factor(
          'trend.adx',
          'ADX directional strength',
          'trend',
          0,
          0.6,
          `ADX ${adx.toFixed(1)} — no directional trend, range conditions`,
        ),
      );
    }
  }

  // Ichimoku cloud position is a self-contained trend read on its own terms.
  const cloud = indicators.ichimoku;
  if (cloud) {
    const positional = cloud.cloudPosition === 'above' ? 60 : cloud.cloudPosition === 'below' ? -60 : 0;
    const directional = cloud.cloudDirection === 'bullish' ? 25 : cloud.cloudDirection === 'bearish' ? -25 : 0;

    out.push(
      factor(
        'trend.ichimoku',
        'Ichimoku cloud',
        'trend',
        positional + directional,
        0.8,
        `Price ${cloud.cloudPosition} the cloud, cloud ${cloud.cloudDirection}`,
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Momentum                                                                   */
/* -------------------------------------------------------------------------- */

function momentumFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { indicators } = input;
  const out: ConfluenceFactor[] = [];

  if (Number.isFinite(indicators.rsi)) {
    const rsi = indicators.rsi;

    // RSI is read as momentum, not as a mean-reversion trigger. Above 70 in a
    // strong trend is strength, and scoring it bearish — the retail reflex —
    // would put the engine on the wrong side of every impulse. Extremes are
    // damped rather than inverted, since they do also raise pullback odds.
    let score = scale(rsi, 30, 70, -80, 80);
    let note = `RSI ${rsi.toFixed(1)}`;

    if (rsi > 78) {
      score *= 0.6;
      note += ' — overbought, entry risk elevated';
    } else if (rsi < 22) {
      score *= 0.6;
      note += ' — oversold, entry risk elevated';
    }

    out.push(factor('momentum.rsi', 'RSI', 'momentum', score, 1, note));
  }

  // Divergence is scored separately and weighted well below trend, because it is
  // an early warning that frequently arrives too early to trade.
  if (indicators.rsiDivergence) {
    out.push(
      factor(
        'momentum.rsi_divergence',
        'RSI divergence',
        'momentum',
        indicators.rsiDivergence === 'bullish' ? 55 : -55,
        0.7,
        `${indicators.rsiDivergence === 'bullish' ? 'Bullish' : 'Bearish'} divergence between price and RSI`,
      ),
    );
  }

  const { macd, signal, histogram } = indicators.macd;
  if (Number.isFinite(histogram) && indicators.atr > 0) {
    // Normalised by ATR so the reading is comparable across instruments.
    const normalised = (histogram / indicators.atr) * 100;
    const crossed = Number.isFinite(macd) && Number.isFinite(signal);

    out.push(
      factor(
        'momentum.macd',
        'MACD histogram',
        'momentum',
        scale(normalised, -60, 60, -100, 100),
        1,
        crossed
          ? `MACD ${macd > signal ? 'above' : 'below'} signal, histogram ${histogram >= 0 ? '+' : ''}${histogram.toFixed(4)}`
          : `Histogram ${histogram.toFixed(4)}`,
      ),
    );
  }

  const { k, d } = indicators.stochastic;
  if (Number.isFinite(k) && Number.isFinite(d)) {
    // The %K/%D relationship carries the timing information; the absolute level
    // is already covered by RSI, so this factor is weighted low to avoid
    // double-counting the same oscillation.
    const cross = k - d;
    out.push(
      factor(
        'momentum.stochastic',
        'Stochastic',
        'momentum',
        scale(cross, -12, 12, -70, 70),
        0.5,
        `%K ${k.toFixed(1)} ${k >= d ? 'above' : 'below'} %D ${d.toFixed(1)}`,
      ),
    );
  }

  const bias = patternBias(input.patterns, input.lastIndex);
  if (bias !== 0) {
    const recent = input.patterns[0];
    out.push(
      factor(
        'momentum.candlestick_patterns',
        'Candlestick patterns',
        'momentum',
        bias * 0.8,
        0.7,
        recent
          ? `Most recent: ${recent.name.replace(/_/g, ' ')} (${recent.reliability.toFixed(0)}% reliability)`
          : 'Recent pattern cluster',
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Structure (SMC / ICT)                                                      */
/* -------------------------------------------------------------------------- */

function structureFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { smc, price } = input;
  const out: ConfluenceFactor[] = [];
  const { structure } = smc;

  // The last BOS/CHoCH is the single most important structural fact.
  if (structure.lastEvent) {
    const event = structure.lastEvent;
    const magnitude = clamp(event.significance, 0, 100);
    // A CHoCH is a regime change and outranks a continuation BOS of equal size.
    const typeMultiplier = event.type === 'CHoCH' ? 1 : 0.85;
    const signed = event.direction === 'bullish' ? magnitude : event.direction === 'bearish' ? -magnitude : 0;

    out.push(
      factor(
        'structure.last_event',
        `Last ${event.type}`,
        'structure',
        signed * typeMultiplier,
        1,
        `${event.type} ${event.direction} — broke ${event.brokenLevel}, confirmed at ${event.confirmedAt}`,
      ),
    );
  }

  // Trend label from swing sequence, gated on how clean that sequence is.
  if (structure.trend !== 'ranging') {
    const clarity = clamp(structure.clarity, 0, 100);
    out.push(
      factor(
        'structure.swing_trend',
        'Swing structure',
        'structure',
        (structure.trend === 'uptrend' ? 1 : -1) * clarity * 0.8,
        0.9,
        `${structure.trend} with ${clarity.toFixed(0)}% structural clarity`,
      ),
    );
  }

  // Premium/discount: buying at a discount is the whole point of the framework.
  if (structure.dealingRange) {
    const positional =
      structure.premiumDiscount === 'discount' ? 45 : structure.premiumDiscount === 'premium' ? -45 : 0;

    out.push(
      factor(
        'structure.premium_discount',
        'Dealing range position',
        'structure',
        positional,
        0.8,
        `Price in ${structure.premiumDiscount} of range ${structure.dealingRange.low}–${structure.dealingRange.high}`,
      ),
    );
  }

  // Unmitigated order blocks price is approaching.
  const nearBlocks = smc.orderBlocks
    .filter((b) => !b.mitigated)
    .map((block) => {
      const mid = (block.top + block.bottom) / 2;
      const distance = price > 0 ? Math.abs(price - mid) / price : Infinity;
      return { block, distance };
    })
    .filter((b) => b.distance < 0.03)
    .sort((a, b) => a.distance - b.distance);

  const nearest = nearBlocks[0];
  if (nearest) {
    // Proximity matters as much as strength: a block 3% away is context, a block
    // 0.2% away is an entry.
    const proximity = clamp(1 - nearest.distance / 0.03, 0, 1);
    const magnitude = clamp(nearest.block.strength, 0, 100) * (0.5 + proximity * 0.5);
    const signed = nearest.block.direction === 'bullish' ? magnitude : -magnitude;

    out.push(
      factor(
        'structure.order_block',
        'Unmitigated order block',
        'structure',
        signed,
        1,
        `${nearest.block.direction} OB ${nearest.block.bottom}–${nearest.block.top}, ${(nearest.distance * 100).toFixed(2)}% away${nearest.block.hasImbalance ? ', with imbalance' : ''}`,
      ),
    );
  }

  // Unfilled FVGs act as magnets; the nearest unmitigated one is the relevant
  // draw on liquidity.
  const openGaps = smc.fairValueGaps
    .filter((g) => !g.mitigated)
    .map((gap) => {
      const mid = (gap.top + gap.bottom) / 2;
      return { gap, distance: price > 0 ? Math.abs(price - mid) / price : Infinity };
    })
    .sort((a, b) => a.distance - b.distance);

  const nearestGap = openGaps[0];
  if (nearestGap && nearestGap.distance < 0.05) {
    const proximity = clamp(1 - nearestGap.distance / 0.05, 0, 1);
    const magnitude = clamp(nearestGap.gap.sizePercent * 40, 10, 70) * (0.4 + proximity * 0.6);
    const signed = nearestGap.gap.direction === 'bullish' ? magnitude : -magnitude;

    out.push(
      factor(
        'structure.fair_value_gap',
        'Unfilled fair value gap',
        'structure',
        signed,
        0.75,
        `${nearestGap.gap.direction} FVG ${nearestGap.gap.bottom}–${nearestGap.gap.top} (${(nearestGap.gap.fillRatio * 100).toFixed(0)}% filled)`,
      ),
    );
  }

  // A reversed sweep is among the highest-quality entries the framework produces:
  // liquidity taken, then rejected.
  const recentSweep = smc.liquiditySweeps[0];
  if (recentSweep) {
    const magnitude = recentSweep.reversed
      ? clamp(50 + recentSweep.penetrationAtr * 30, 40, 90)
      : clamp(recentSweep.penetrationAtr * 20, 0, 35);
    const signed = recentSweep.direction === 'bullish' ? magnitude : -magnitude;

    out.push(
      factor(
        'structure.liquidity_sweep',
        'Liquidity sweep',
        'structure',
        signed,
        recentSweep.reversed ? 1 : 0.5,
        recentSweep.reversed
          ? `Swept ${recentSweep.level} and reversed within ${recentSweep.reversalBars} bars`
          : `Swept ${recentSweep.level}, no reversal confirmed yet`,
      ),
    );
  }

  // Untested supply/demand near price.
  const nearZone = smc.supplyDemandZones
    .filter((z) => !z.tested)
    .map((zone) => {
      const mid = (zone.top + zone.bottom) / 2;
      return { zone, distance: price > 0 ? Math.abs(price - mid) / price : Infinity };
    })
    .filter((z) => z.distance < 0.025)
    .sort((a, b) => a.distance - b.distance)[0];

  if (nearZone) {
    const magnitude = clamp(nearZone.zone.strength, 0, 100) * 0.7;
    const signed = nearZone.zone.kind === 'demand' ? magnitude : -magnitude;

    out.push(
      factor(
        'structure.supply_demand',
        'Fresh supply/demand zone',
        'structure',
        signed,
        0.8,
        `Untested ${nearZone.zone.kind} (${nearZone.zone.pattern}) at ${nearZone.zone.bottom}–${nearZone.zone.top}`,
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Volume                                                                     */
/* -------------------------------------------------------------------------- */

function volumeFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { indicators, smc, price } = input;
  const out: ConfluenceFactor[] = [];

  // Relative volume is direction-agnostic on its own, so it is expressed as a
  // confirmation of the prevailing structural direction rather than a bias.
  const rvol = indicators.relativeVolume;
  if (Number.isFinite(rvol) && rvol > 0) {
    const structuralDirection: Direction =
      smc.structure.trend === 'uptrend' ? 'bullish' : smc.structure.trend === 'downtrend' ? 'bearish' : 'neutral';

    if (structuralDirection !== 'neutral' && rvol > 1.2) {
      const magnitude = clamp(scale(rvol, 1.2, 3, 20, 75), 0, 75);
      out.push(
        factor(
          'volume.participation',
          'Volume participation',
          'volume',
          structuralDirection === 'bullish' ? magnitude : -magnitude,
          0.9,
          `${(rvol * 100).toFixed(0)}% of average volume confirming ${smc.structure.trend}`,
        ),
      );
    } else if (rvol < 0.6) {
      out.push(
        factor(
          'volume.participation',
          'Volume participation',
          'volume',
          0,
          0.7,
          `Only ${(rvol * 100).toFixed(0)}% of average volume — moves lack participation`,
        ),
      );
    }
  }

  // Institutional footprint is an estimate from displacement and volume, not
  // order-flow data, so it corroborates direction rather than setting it.
  const footprint = smc.institutionalFootprint;
  if (Number.isFinite(footprint) && footprint > 45) {
    const direction: Direction =
      smc.structure.lastEvent?.direction ??
      (smc.structure.trend === 'uptrend' ? 'bullish' : smc.structure.trend === 'downtrend' ? 'bearish' : 'neutral');

    if (direction !== 'neutral') {
      const magnitude = clamp(scale(footprint, 45, 95, 15, 70), 0, 70);
      out.push(
        factor(
          'volume.institutional_footprint',
          'Institutional footprint',
          'volume',
          direction === 'bullish' ? magnitude : -magnitude,
          0.85,
          `Footprint score ${footprint.toFixed(0)}/100 — displacement and volume consistent with institutional activity`,
        ),
      );
    }
  }

  // VWAP is the institutional benchmark: which side of it price is on determines
  // whether buyers or sellers are in profit on the session.
  if (Number.isFinite(indicators.vwap) && indicators.vwap > 0 && price > 0) {
    const distancePercent = ((price - indicators.vwap) / indicators.vwap) * 100;
    out.push(
      factor(
        'volume.vwap',
        'VWAP position',
        'volume',
        scale(distancePercent, -2.5, 2.5, -70, 70),
        0.85,
        `${distancePercent >= 0 ? 'Above' : 'Below'} VWAP by ${Math.abs(distancePercent).toFixed(2)}%`,
      ),
    );
  }

  // Value-area position from the volume profile: outside value is an imbalance
  // that tends to resolve back toward the POC.
  const profile = indicators.volumeProfile;
  if (profile.totalVolume > 0 && profile.poc > 0 && price > 0) {
    if (price > profile.vah) {
      out.push(
        factor(
          'volume.value_area',
          'Volume profile position',
          'volume',
          35,
          0.7,
          `Trading above value area high ${profile.vah} — acceptance above value`,
        ),
      );
    } else if (price < profile.val) {
      out.push(
        factor(
          'volume.value_area',
          'Volume profile position',
          'volume',
          -35,
          0.7,
          `Trading below value area low ${profile.val} — acceptance below value`,
        ),
      );
    } else {
      const pocDistance = ((price - profile.poc) / profile.poc) * 100;
      out.push(
        factor(
          'volume.value_area',
          'Volume profile position',
          'volume',
          0,
          0.5,
          `Inside value area, ${Math.abs(pocDistance).toFixed(2)}% from POC ${profile.poc}`,
        ),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Volatility                                                                 */
/* -------------------------------------------------------------------------- */

function volatilityFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { volatility, indicators } = input;
  const out: ConfluenceFactor[] = [];

  // Volatility is not directional. These factors score 0 and exist to inform the
  // risk model and the narrative — a squeeze is a *timing* observation, and
  // scoring it bullish because breakouts are exciting would be wrong.
  if (volatility.squeeze) {
    out.push(
      factor(
        'volatility.squeeze',
        'Volatility squeeze',
        'volatility',
        0,
        0.8,
        `Bollinger bandwidth at a multi-period low (ATR ${volatility.atrPercent.toFixed(2)}%, ${volatility.percentile.toFixed(0)}th percentile) — expansion likely, direction unresolved`,
      ),
    );
  }

  if (volatility.regime === 'extreme') {
    out.push(
      factor(
        'volatility.regime',
        'Volatility regime',
        'volatility',
        0,
        0.9,
        `Extreme volatility (${volatility.percentile.toFixed(0)}th percentile) — widen stops, reduce size`,
      ),
    );
  } else if (volatility.regime === 'compressed') {
    out.push(
      factor(
        'volatility.regime',
        'Volatility regime',
        'volatility',
        0,
        0.6,
        `Compressed volatility (${volatility.percentile.toFixed(0)}th percentile) — tight ranges, breakout risk`,
      ),
    );
  }

  // Bollinger %B *is* directional, as a position-in-range read.
  const percentB = indicators.bollinger.percentB;
  if (Number.isFinite(percentB)) {
    // Beyond the bands is a continuation read in a trend and an exhaustion read
    // in a range, so it is damped rather than extrapolated.
    const raw = scale(percentB, 0, 1, -60, 60);
    const damped = percentB > 1 || percentB < 0 ? raw * 0.5 : raw;

    out.push(
      factor(
        'volatility.bollinger_position',
        'Bollinger band position',
        'volatility',
        damped,
        0.7,
        `%B ${percentB.toFixed(2)} (${percentB > 1 ? 'above upper band' : percentB < 0 ? 'below lower band' : 'inside bands'})`,
      ),
    );
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Levels                                                                     */
/* -------------------------------------------------------------------------- */

function levelFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const { supportLevels, resistanceLevels, price, indicators } = input;
  const out: ConfluenceFactor[] = [];
  if (price <= 0) return out;

  const nearestSupport = supportLevels[0];
  const nearestResistance = resistanceLevels[0];

  // Headroom asymmetry: the trade with 4% to the next resistance and 0.5% to
  // support is structurally different from its mirror image, and this is the
  // factor that says so.
  if (nearestSupport && nearestResistance) {
    const toSupport = (price - nearestSupport.price) / price;
    const toResistance = (nearestResistance.price - price) / price;
    const total = toSupport + toResistance;

    if (total > 0) {
      // Closer to support → bullish (limited downside, more room up).
      const balance = (toResistance - toSupport) / total;
      out.push(
        factor(
          'levels.headroom',
          'Range position',
          'levels',
          -balance * 70,
          0.9,
          `${(toSupport * 100).toFixed(2)}% to support ${nearestSupport.price}, ${(toResistance * 100).toFixed(2)}% to resistance ${nearestResistance.price}`,
        ),
      );
    }
  }

  // Immediate proximity to a strong level, which dominates whatever the trend
  // says in the short run.
  const proximityThreshold = 0.006;

  if (nearestSupport) {
    const distance = (price - nearestSupport.price) / price;
    if (distance >= 0 && distance < proximityThreshold) {
      const magnitude = clamp(nearestSupport.strength, 0, 100) * (1 - distance / proximityThreshold);
      out.push(
        factor(
          'levels.at_support',
          'At support',
          'levels',
          magnitude * 0.8,
          1,
          `${(distance * 100).toFixed(2)}% above support ${nearestSupport.price} (${nearestSupport.touches} touches, strength ${nearestSupport.strength.toFixed(0)})`,
        ),
      );
    }
  }

  if (nearestResistance) {
    const distance = (nearestResistance.price - price) / price;
    if (distance >= 0 && distance < proximityThreshold) {
      const magnitude = clamp(nearestResistance.strength, 0, 100) * (1 - distance / proximityThreshold);
      out.push(
        factor(
          'levels.at_resistance',
          'At resistance',
          'levels',
          -magnitude * 0.8,
          1,
          `${(distance * 100).toFixed(2)}% below resistance ${nearestResistance.price} (${nearestResistance.touches} touches, strength ${nearestResistance.strength.toFixed(0)})`,
        ),
      );
    }
  }

  // Golden pocket: the retracement zone the framework treats as the highest-
  // probability continuation entry.
  const fib = indicators.fibonacci;
  if (fib) {
    const { low, high } = fib.goldenPocket;
    const inPocket = price >= Math.min(low, high) && price <= Math.max(low, high);

    if (inPocket) {
      out.push(
        factor(
          'levels.golden_pocket',
          'Fibonacci golden pocket',
          'levels',
          fib.direction === 'bullish' ? 55 : -55,
          0.85,
          `Price inside the 0.618–0.65 retracement of the ${fib.direction} leg ${fib.swingLow}–${fib.swingHigh}`,
        ),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Sentiment & derivatives                                                    */
/* -------------------------------------------------------------------------- */

function sentimentFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const out: ConfluenceFactor[] = [];

  if (input.sentiment && input.sentiment.articleCount > 0) {
    const snapshot = input.sentiment;
    // Sentiment is a tiebreaker. It is weighted low deliberately: news sentiment
    // is a lagging, noisy read that is frequently already priced in by the time
    // it is measurable.
    out.push(
      factor(
        'sentiment.news',
        'News sentiment',
        'sentiment',
        clamp(snapshot.score, -100, 100) * 0.6,
        0.8,
        `${snapshot.sentiment} across ${snapshot.articleCount} articles in ${snapshot.windowHours}h (${snapshot.bullishCount}↑ / ${snapshot.bearishCount}↓)`,
      ),
    );
  }

  if (input.fearGreed && Number.isFinite(input.fearGreed.value)) {
    const value = input.fearGreed.value;
    // Contrarian by construction: extreme fear is a buy signal in the aggregate,
    // extreme greed a caution. Only the extremes carry information, so the middle
    // of the range is scored near zero.
    const contrarian = value <= 25 ? scale(value, 0, 25, 60, 15) : value >= 75 ? -scale(value, 75, 100, 15, 60) : 0;

    out.push(
      factor(
        'sentiment.fear_greed',
        'Fear & Greed Index',
        'sentiment',
        contrarian,
        0.6,
        `${input.fearGreed.value} — ${input.fearGreed.classification}${contrarian !== 0 ? ' (contrarian read)' : ''}`,
      ),
    );
  }

  return out;
}

function derivativesFactors(input: ConfluenceInput): ConfluenceFactor[] {
  const out: ConfluenceFactor[] = [];
  const derivatives = input.derivatives;
  if (!derivatives) return out;

  // Funding is read contrarian: heavily positive funding means longs are paying
  // to hold, which is crowding, not conviction.
  if (derivatives.fundingRate !== undefined && Number.isFinite(derivatives.fundingRate)) {
    const rate = derivatives.fundingRate;
    const annualised = rate * 3 * 365 * 100;
    // Neutral funding (roughly ±0.01% per 8h) carries no signal.
    const score = Math.abs(rate) < 0.0001 ? 0 : scale(rate, -0.0008, 0.0008, 55, -55);

    out.push(
      factor(
        'derivatives.funding_rate',
        'Funding rate',
        'derivatives',
        score,
        0.8,
        `${(rate * 100).toFixed(4)}% per interval (${annualised.toFixed(1)}% annualised)${score !== 0 ? ` — ${rate > 0 ? 'longs' : 'shorts'} crowded` : ''}`,
      ),
    );
  }

  // Open interest confirms or contradicts price: rising OI into a rising price is
  // new money; rising OI into a falling price is new shorts.
  if (
    derivatives.openInterestChangePercent !== undefined &&
    Number.isFinite(derivatives.openInterestChangePercent)
  ) {
    const change = derivatives.openInterestChangePercent;
    const direction: Direction =
      input.smc.structure.trend === 'uptrend'
        ? 'bullish'
        : input.smc.structure.trend === 'downtrend'
          ? 'bearish'
          : 'neutral';

    if (direction !== 'neutral' && Math.abs(change) > 2) {
      // OI rising with the trend confirms it; OI falling with the trend signals
      // position closure and a weakening move.
      const magnitude = clamp(scale(Math.abs(change), 2, 20, 15, 60), 0, 60);
      const confirming = change > 0;
      const signed = (direction === 'bullish' ? 1 : -1) * magnitude * (confirming ? 1 : -0.6);

      out.push(
        factor(
          'derivatives.open_interest',
          'Open interest',
          'derivatives',
          signed,
          0.75,
          `OI ${change >= 0 ? '+' : ''}${change.toFixed(1)}% over 24h — ${confirming ? 'new positions entering' : 'positions closing'} into ${input.smc.structure.trend}`,
        ),
      );
    }
  }

  if (derivatives.longShortRatio !== undefined && Number.isFinite(derivatives.longShortRatio)) {
    const ratio = derivatives.longShortRatio;
    // Also contrarian, and only at meaningful skew.
    if (ratio > 1.5 || ratio < 0.67) {
      const score = ratio > 1.5 ? -clamp(scale(ratio, 1.5, 3, 15, 50), 0, 50) : clamp(scale(1 / ratio, 1.5, 3, 15, 50), 0, 50);

      out.push(
        factor(
          'derivatives.long_short_ratio',
          'Long/short ratio',
          'derivatives',
          score,
          0.6,
          `${ratio.toFixed(2)} — retail positioning skewed ${ratio > 1 ? 'long' : 'short'}`,
        ),
      );
    }
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* Aggregation                                                                */
/* -------------------------------------------------------------------------- */

/** Every factor the engine can derive, unsorted. */
export function buildConfluence(input: ConfluenceInput): ConfluenceFactor[] {
  return [
    ...trendFactors(input),
    ...momentumFactors(input),
    ...structureFactors(input),
    ...volumeFactors(input),
    ...volatilityFactors(input),
    ...levelFactors(input),
    ...sentimentFactors(input),
    ...derivativesFactors(input),
  ];
}

/**
 * Net confluence score, -100..100.
 *
 * A weighted mean rather than a sum. A sum would let a symbol with many
 * measurable factors reach ±400 while a thinly-covered one caps near ±80, making
 * the two incomparable — and the confidence gate has to compare them.
 *
 * Neutral factors participate in the denominator. A market showing five strong
 * bullish reads and four explicit "no trend here" observations is genuinely less
 * convincing than one showing the five alone, and the divisor is what expresses
 * that.
 */
export function scoreConfluence(
  factors: ConfluenceFactor[],
  categoryWeights: Record<ConfluenceFactor['category'], number> = DEFAULT_CATEGORY_WEIGHTS,
): number {
  if (factors.length === 0) return 0;

  let weighted = 0;
  let totalWeight = 0;

  for (const f of factors) {
    const categoryWeight = categoryWeights[f.category] ?? 1;
    const weight = f.weight * categoryWeight;
    if (weight <= 0) continue;

    weighted += f.score * weight;
    totalWeight += weight;
  }

  return totalWeight === 0 ? 0 : round(clamp(weighted / totalWeight, -100, 100), 2);
}

/**
 * Per-category net scores, for the confidence breakdown and the UI's category
 * bars.
 */
export function scoreByCategory(
  factors: ConfluenceFactor[],
): Record<ConfluenceFactor['category'], number> {
  const totals: Record<string, { weighted: number; weight: number }> = {};

  for (const f of factors) {
    const bucket = totals[f.category] ?? { weighted: 0, weight: 0 };
    bucket.weighted += f.score * f.weight;
    bucket.weight += f.weight;
    totals[f.category] = bucket;
  }

  const out = {} as Record<ConfluenceFactor['category'], number>;
  for (const category of Object.keys(DEFAULT_CATEGORY_WEIGHTS) as Array<ConfluenceFactor['category']>) {
    const bucket = totals[category];
    out[category] = bucket && bucket.weight > 0 ? round(bucket.weighted / bucket.weight, 2) : 0;
  }
  return out;
}

/**
 * The factors that most influenced the outcome, strongest first.
 *
 * Ranked by absolute weighted contribution so the list answers "why this signal"
 * rather than "what was measured".
 */
export function topFactors(
  factors: ConfluenceFactor[],
  limit = 6,
  categoryWeights: Record<ConfluenceFactor['category'], number> = DEFAULT_CATEGORY_WEIGHTS,
): ConfluenceFactor[] {
  return [...factors]
    .filter((f) => f.score !== 0)
    .sort((a, b) => {
      const aWeight = Math.abs(a.score) * a.weight * (categoryWeights[a.category] ?? 1);
      const bWeight = Math.abs(b.score) * b.weight * (categoryWeights[b.category] ?? 1);
      return bWeight - aWeight;
    })
    .slice(0, limit);
}
