/**
 * Signal domain types.
 *
 * A signal is the output of: deterministic analysis → confluence scoring →
 * AI synthesis → threshold gate. Signals below the configured confidence
 * threshold are persisted as `WAIT` (or discarded) but never notified.
 */

import type {
  ConfluenceFactor,
  Direction,
  TrendDirection,
  Strength,
} from './analysis.js';
import type { Timeframe } from './market.js';

export type SignalAction = 'BUY' | 'SELL' | 'WAIT';

export type SignalQuality = 'low' | 'fair' | 'good' | 'high' | 'premium';

export type SignalStatus =
  | 'active'
  | 'triggered'
  | 'tp1_hit'
  | 'tp2_hit'
  | 'tp3_hit'
  | 'stopped_out'
  | 'expired'
  | 'invalidated'
  | 'cancelled';

/** A single take-profit target. */
export interface TakeProfitTarget {
  /** 1, 2 or 3. */
  level: 1 | 2 | 3;
  price: number;
  /** Risk-reward multiple at this target. */
  rr: number;
  /** Suggested portion of the position to close here, 0–1. */
  allocation: number;
  /** Structural justification, e.g. "prior swing high / 1.618 extension". */
  rationale: string;
}

/**
 * Confidence is decomposed so the UI can show *why* the meter reads what it
 * does, and so the threshold gate can key on the right component.
 */
export interface ConfidenceBreakdown {
  /** Final 0–100 figure surfaced to the user. */
  overall: number;
  /** Deterministic confluence contribution, 0–100. */
  technical: number;
  /** Multi-timeframe alignment contribution, 0–100. */
  mtfAlignment: number;
  /** SMC/ICT structural contribution, 0–100. */
  structure: number;
  /** Volume & institutional footprint contribution, 0–100. */
  volume: number;
  /** News/sentiment contribution, 0–100 (50 = neutral). */
  sentiment: number;
  /** The AI model's own stated conviction, 0–100. */
  aiConviction: number;
}

export interface Signal {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  action: SignalAction;

  /** 0–100. Gated against the configured minimum before notification. */
  confidence: number;
  confidenceBreakdown: ConfidenceBreakdown;
  /** 0–100 modelled probability the first target is reached before the stop. */
  probabilityScore: number;
  /** 0–100, higher = riskier. Blends volatility, RR and structural clarity. */
  riskScore: number;
  quality: SignalQuality;

  /** Trade levels. Null on WAIT signals. */
  entry: number | null;
  /** Acceptable entry band — SMC entries are zones, not points. */
  entryZone: { low: number; high: number } | null;
  stopLoss: number | null;
  takeProfits: TakeProfitTarget[];
  /** RR to the *first* target. */
  riskRewardRatio: number | null;

  trendDirection: TrendDirection;
  bias: Direction;
  /** 0–100. */
  trendStrength: number;

  /** Primary AI-authored narrative. */
  reasoning: string;
  /** Dedicated explanation of the SMC/ICT structural read. */
  marketStructureExplanation: string;
  /** Bullet list of the decisive factors, ordered by contribution. */
  keyFactors: string[];
  /** What would invalidate this idea. */
  invalidation: string;

  /** Human-readable expected holding period, e.g. "4–12 hours". */
  expectedDuration: string;
  /** Estimated ms until the idea resolves — used for auto-expiry. */
  expectedDurationMs: number;
  /** Expected favourable move to TP1 as a percentage of entry. */
  expectedMovePercent: number;

  confluence: ConfluenceFactor[];
  confluenceScore: number;

  status: SignalStatus;
  /** Price at the moment of generation. */
  priceAtGeneration: number;
  createdAt: number;
  expiresAt: number;
  /** Set when status moves to a terminal state. */
  closedAt?: number;
  /** Realised R multiple once resolved. */
  realisedR?: number;

  /** Provenance. */
  aiProvider: string;
  aiModel: string;
  /** True when produced by the deterministic engine with no LLM available. */
  deterministicOnly: boolean;
  synthetic: boolean;
}

/** Thresholds and weights that govern signal generation. Admin-editable. */
export interface SignalEngineConfig {
  /** Signals below this confidence are not surfaced as actionable. */
  minConfidence: number;
  /** Signals below this are never notified, regardless of channel settings. */
  notifyMinConfidence: number;
  /** Minimum acceptable RR to TP1 — below this the engine returns WAIT. */
  minRiskReward: number;
  /** Minimum MTF alignment score required for a non-WAIT signal. */
  minMtfAlignment: number;
  /** Cap to prevent signal spam. */
  maxSignalsPerSymbolPerDay: number;
  /** Weights applied to each confluence category. Must be > 0. */
  categoryWeights: Record<ConfluenceFactor['category'], number>;
  /** How many candles of history to analyse per timeframe. */
  lookbackBars: number;
  /** Timeframes consulted for multi-timeframe confirmation. */
  mtfTimeframes: Timeframe[];
  /** Require an untested order block or FVG near entry. */
  requireSmcConfluence: boolean;
}

/** Signal + evaluated performance, for the analytics views. */
export interface SignalPerformance {
  signalId: string;
  symbol: string;
  action: SignalAction;
  status: SignalStatus;
  confidence: number;
  realisedR: number | null;
  /** Peak favourable excursion in R. */
  maxFavourableR: number | null;
  /** Peak adverse excursion in R. */
  maxAdverseR: number | null;
  durationMs: number | null;
  createdAt: number;
}

/** Aggregate engine accuracy, sliced by confidence band. */
export interface SignalAccuracyBucket {
  /** e.g. "70-79". */
  band: string;
  total: number;
  wins: number;
  losses: number;
  open: number;
  winRate: number;
  avgR: number;
  expectancy: number;
}

export const STRENGTH_LABELS: Record<Strength, string> = {
  weak: 'Weak',
  moderate: 'Moderate',
  strong: 'Strong',
  very_strong: 'Very Strong',
};
