/**
 * Technical analysis domain types.
 *
 * Split into three layers:
 *   1. Classic indicators (RSI, MACD, …)      → `IndicatorSnapshot`
 *   2. Smart Money / ICT structures            → `SmcAnalysis`
 *   3. Derived interpretation & confluence     → `TechnicalAnalysis`
 *
 * The AI layer consumes layer 3 as structured context. It never re-derives
 * maths from raw candles — deterministic computation stays deterministic, and
 * the LLM is used only for synthesis and natural-language reasoning.
 */

import type { Timeframe } from './market.js';

// ---------------------------------------------------------------------------
// Directional primitives
// ---------------------------------------------------------------------------

export type Direction = 'bullish' | 'bearish' | 'neutral';
export type TrendDirection = 'uptrend' | 'downtrend' | 'ranging';
export type Bias = 'long' | 'short' | 'flat';

/** Strength buckets used across the engine for consistent UI treatment. */
export type Strength = 'weak' | 'moderate' | 'strong' | 'very_strong';

// ---------------------------------------------------------------------------
// Classic indicators
// ---------------------------------------------------------------------------

export interface MacdValue {
  macd: number;
  signal: number;
  histogram: number;
}

export interface BollingerValue {
  upper: number;
  middle: number;
  lower: number;
  /** (upper - lower) / middle — normalised width for squeeze detection. */
  bandwidth: number;
  /** Where price sits in the band: 0 = lower, 1 = upper. */
  percentB: number;
}

export interface StochasticValue {
  k: number;
  d: number;
}

export interface IchimokuValue {
  tenkan: number;
  kijun: number;
  senkouA: number;
  senkouB: number;
  chikou: number;
  /** Price position relative to the cloud. */
  cloudPosition: 'above' | 'inside' | 'below';
  /** Bullish when Senkou A > Senkou B. */
  cloudDirection: Direction;
}

export interface AdxValue {
  adx: number;
  plusDi: number;
  minusDi: number;
}

/** A single horizontal price level with a quantified importance. */
export interface PriceLevel {
  price: number;
  /** 0–100. Derived from touch count, volume at level, and recency. */
  strength: number;
  /** How many times price reacted at this level in the lookback window. */
  touches: number;
  /** Epoch ms of the most recent touch. */
  lastTouch: number;
  kind: 'support' | 'resistance';
}

/** One row of the volume profile histogram. */
export interface VolumeProfileRow {
  priceLow: number;
  priceHigh: number;
  volume: number;
  /** Portion of total volume in this row, 0–1. */
  share: number;
}

export interface VolumeProfile {
  rows: VolumeProfileRow[];
  /** Point of Control — price of the highest-volume row. */
  poc: number;
  /** Value Area High / Low bounding 70% of traded volume. */
  vah: number;
  val: number;
  totalVolume: number;
}

export interface FibonacciLevels {
  /** Swing used to anchor the retracement. */
  swingHigh: number;
  swingLow: number;
  direction: Direction;
  /** Retracement levels keyed by ratio, e.g. `0.618`. */
  retracements: Record<string, number>;
  /** Extension targets, e.g. `1.272`, `1.618`. */
  extensions: Record<string, number>;
  /** The 0.618–0.65 "golden pocket" zone. */
  goldenPocket: { low: number; high: number };
}

/**
 * Full indicator readout for one symbol at one timeframe.
 * Every field is the value at the most recent *closed* candle.
 */
export interface IndicatorSnapshot {
  rsi: number;
  /** Bullish/bearish RSI divergence against price, when present. */
  rsiDivergence: Direction | null;
  macd: MacdValue;
  ema: Record<number, number>;
  sma: Record<number, number>;
  atr: number;
  /** ATR as a percentage of price — cross-asset comparable volatility. */
  atrPercent: number;
  adx: AdxValue;
  bollinger: BollingerValue;
  stochastic: StochasticValue;
  ichimoku: IchimokuValue | null;
  vwap: number;
  /** Standard-deviation bands around VWAP. */
  vwapBands: { upper1: number; lower1: number; upper2: number; lower2: number };
  volumeProfile: VolumeProfile;
  fibonacci: FibonacciLevels | null;
  obv: number;
  /** Current volume vs. its own moving average, e.g. 1.8 = 180% of normal. */
  relativeVolume: number;
}

// ---------------------------------------------------------------------------
// Smart Money Concepts / ICT
// ---------------------------------------------------------------------------

/** A confirmed swing pivot. */
export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  kind: 'high' | 'low';
  /** Higher-high, lower-low etc. relative to the previous same-kind pivot. */
  label: 'HH' | 'LH' | 'HL' | 'LL';
}

/** Break of Structure / Change of Character event. */
export interface StructureEvent {
  type: 'BOS' | 'CHoCH';
  direction: Direction;
  time: number;
  /** The swing level that was broken. */
  brokenLevel: number;
  /** Close price that confirmed the break. */
  confirmedAt: number;
  /** 0–100 — scaled by displacement size and volume on the breaking candle. */
  significance: number;
}

/**
 * Institutional order block: the last opposing candle before an impulsive,
 * structure-breaking move.
 */
export interface OrderBlock {
  direction: Direction;
  /** Zone boundaries. */
  top: number;
  bottom: number;
  time: number;
  /** Whether price has since traded back into the zone. */
  mitigated: boolean;
  mitigatedAt?: number;
  /** 0–100 — displacement strength, volume, and whether it broke structure. */
  strength: number;
  /** True when the block also created an unfilled FVG (breaker quality). */
  hasImbalance: boolean;
}

/** Fair Value Gap — a three-candle imbalance. */
export interface FairValueGap {
  direction: Direction;
  top: number;
  bottom: number;
  time: number;
  /** Portion of the gap price has since retraced, 0–1. */
  fillRatio: number;
  mitigated: boolean;
  /** Gap height as a percentage of price. */
  sizePercent: number;
}

/** Liquidity pool — clustered equal highs/lows where stops rest. */
export interface LiquidityPool {
  price: number;
  kind: 'buyside' | 'sellside';
  /** How many pivots cluster at this level. */
  touches: number;
  /** 0–100 — estimated resting liquidity. */
  strength: number;
  /** Set once price wicks through and closes back inside. */
  swept: boolean;
  sweptAt?: number;
}

/** A confirmed stop-hunt: wick through liquidity followed by rejection. */
export interface LiquiditySweep {
  direction: Direction;
  /** The level that was raided. */
  level: number;
  time: number;
  /** How far beyond the level the wick reached, as % of ATR. */
  penetrationAtr: number;
  /** True when price closed back inside within `reversalBars`. */
  reversed: boolean;
  reversalBars: number;
}

/** Supply or demand zone — a base that produced an impulsive departure. */
export interface SupplyDemandZone {
  kind: 'supply' | 'demand';
  top: number;
  bottom: number;
  time: number;
  /** Rally-Base-Rally style classification. */
  pattern: 'RBR' | 'DBR' | 'RBD' | 'DBD';
  /** 0–100 — departure impulse, time at base, freshness. */
  strength: number;
  tested: boolean;
  testCount: number;
}

/** The market's structural state on one timeframe. */
export interface MarketStructure {
  trend: TrendDirection;
  /** 0–100 — how cleanly the structure trends. */
  clarity: number;
  swings: SwingPoint[];
  events: StructureEvent[];
  /** Most recent BOS/CHoCH — the one that defines current bias. */
  lastEvent: StructureEvent | null;
  /** Current premium/discount position relative to the dealing range. */
  premiumDiscount: 'premium' | 'equilibrium' | 'discount';
  dealingRange: { high: number; low: number; equilibrium: number } | null;
}

/** Complete SMC/ICT readout for one timeframe. */
export interface SmcAnalysis {
  structure: MarketStructure;
  orderBlocks: OrderBlock[];
  fairValueGaps: FairValueGap[];
  liquidityPools: LiquidityPool[];
  liquiditySweeps: LiquiditySweep[];
  supplyDemandZones: SupplyDemandZone[];
  /** Institutional-activity score, 0–100 — volume/displacement footprints. */
  institutionalFootprint: number;
}

// ---------------------------------------------------------------------------
// Candlestick patterns
// ---------------------------------------------------------------------------

export type CandlestickPatternName =
  | 'hammer'
  | 'inverted_hammer'
  | 'shooting_star'
  | 'hanging_man'
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'bullish_harami'
  | 'bearish_harami'
  | 'morning_star'
  | 'evening_star'
  | 'three_white_soldiers'
  | 'three_black_crows'
  | 'doji'
  | 'dragonfly_doji'
  | 'gravestone_doji'
  | 'piercing_line'
  | 'dark_cloud_cover'
  | 'tweezer_top'
  | 'tweezer_bottom'
  | 'marubozu_bullish'
  | 'marubozu_bearish';

export interface CandlestickPattern {
  name: CandlestickPatternName;
  direction: Direction;
  time: number;
  /** Index in the analysed candle array. */
  index: number;
  /** 0–100 — textbook conformity times contextual relevance. */
  reliability: number;
  /** Number of candles the pattern spans. */
  barCount: number;
}

// ---------------------------------------------------------------------------
// Aggregate analysis
// ---------------------------------------------------------------------------

/** One scored input into the final decision. */
export interface ConfluenceFactor {
  /** Stable machine key, e.g. `smc.order_block_confluence`. */
  key: string;
  /** Human label for the UI. */
  label: string;
  category:
    | 'trend'
    | 'momentum'
    | 'structure'
    | 'volume'
    | 'volatility'
    | 'levels'
    | 'sentiment'
    | 'derivatives';
  direction: Direction;
  /** Raw contribution, -100..100 (sign follows direction). */
  score: number;
  /** Relative importance of this factor, 0–1. */
  weight: number;
  /** Short human explanation shown in the confluence breakdown. */
  detail: string;
}

/** Correlation of this symbol against a reference instrument. */
export interface CorrelationEntry {
  symbol: string;
  /** Pearson coefficient over the lookback, -1..1. */
  coefficient: number;
  lookbackBars: number;
}

/** Volatility regime classification. */
export interface VolatilityState {
  atrPercent: number;
  /** Percentile of current ATR vs. its own history, 0–100. */
  percentile: number;
  regime: 'compressed' | 'normal' | 'elevated' | 'extreme';
  /** True when Bollinger bandwidth is at a multi-period low. */
  squeeze: boolean;
  /** Direction of the volatility trend. */
  expanding: boolean;
}

/** Per-timeframe verdict used by the MTF confirmation engine. */
export interface TimeframeVerdict {
  timeframe: Timeframe;
  bias: Direction;
  /** 0–100 conviction on this timeframe alone. */
  conviction: number;
  trend: TrendDirection;
  keyNote: string;
}

/** Multi-timeframe alignment result. */
export interface MtfConfirmation {
  verdicts: TimeframeVerdict[];
  /** 0–100 — how strongly timeframes agree. */
  alignmentScore: number;
  dominantBias: Direction;
  /** Timeframes that disagree with the dominant bias. */
  conflicts: Timeframe[];
}

/**
 * The complete deterministic analysis for one symbol/timeframe.
 * This object is what gets serialised into the AI prompt.
 */
export interface TechnicalAnalysis {
  symbol: string;
  timeframe: Timeframe;
  /** Close of the most recent candle analysed. */
  price: number;
  /** Open time of the last analysed candle. */
  asOf: number;
  candleCount: number;

  indicators: IndicatorSnapshot;
  smc: SmcAnalysis;
  patterns: CandlestickPattern[];
  supportLevels: PriceLevel[];
  resistanceLevels: PriceLevel[];
  volatility: VolatilityState;

  /** 0–100 trend strength, blending ADX, EMA stack and structure clarity. */
  trendStrength: number;
  /** -100..100 composite momentum. */
  momentum: number;

  confluence: ConfluenceFactor[];
  /** Net weighted score, -100..100. Positive = bullish. */
  confluenceScore: number;

  mtf?: MtfConfirmation;
  correlations?: CorrelationEntry[];
  /** True if any input candle was synthetic. */
  synthetic: boolean;
}
