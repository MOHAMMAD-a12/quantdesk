/**
 * Portfolio, trade journal and risk management types.
 */

export type TradeSide = 'long' | 'short';
export type TradeStatus = 'open' | 'closed' | 'cancelled';

export interface Trade {
  id: string;
  userId: string;
  symbol: string;
  side: TradeSide;
  status: TradeStatus;

  entryPrice: number;
  /** Position size in base units / lots. */
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;

  exitPrice: number | null;
  /** Realised profit in account currency. Null while open. */
  pnl: number | null;
  pnlPercent: number | null;
  /** Realised R multiple — pnl / initial risk. */
  rMultiple: number | null;
  fees: number;

  openedAt: number;
  closedAt: number | null;

  /** Link back to the signal that produced this trade, if any. */
  signalId: string | null;
  /** Free-form journal entry. */
  notes: string | null;
  /** User-defined tags, e.g. ["breakout", "london-session"]. */
  tags: string[];
  /** Post-trade self-assessment, 1–5. */
  executionRating: number | null;
  /** Screenshot attached to the journal entry. */
  screenshotUrl: string | null;
}

/** Live valuation of an open position. */
export interface OpenPositionView extends Trade {
  currentPrice: number;
  unrealisedPnl: number;
  unrealisedPnlPercent: number;
  /** Current R multiple if closed now. */
  currentR: number | null;
  /** Account-currency risk still on the table. */
  riskAmount: number;
}

export interface PortfolioSummary {
  userId: string;
  currency: string;
  /** Starting/deposited capital. */
  startingBalance: number;
  /** Realised balance — starting + closed PnL. */
  balance: number;
  /** Balance + unrealised PnL of open positions. */
  equity: number;
  realisedPnl: number;
  unrealisedPnl: number;
  totalPnlPercent: number;
  openTrades: number;
  closedTrades: number;
  /** Sum of risk currently at stake, in account currency. */
  openRisk: number;
  openRiskPercent: number;
}

/** Full performance statistics over a period. */
export interface PerformanceStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakEven: number;
  winRate: number;
  /** Gross profit / gross loss. */
  profitFactor: number;
  /** Average R per trade. */
  expectancy: number;
  avgWin: number;
  avgLoss: number;
  avgRiskReward: number;
  largestWin: number;
  largestLoss: number;
  /** Annualised Sharpe using daily returns, rf = 0. */
  sharpeRatio: number;
  /** Sharpe variant penalising only downside deviation. */
  sortinoRatio: number;
  /** Peak-to-trough decline as a percentage. */
  maxDrawdownPercent: number;
  maxDrawdownAmount: number;
  currentDrawdownPercent: number;
  /** Longest run of consecutive wins / losses. */
  maxWinStreak: number;
  maxLossStreak: number;
  /** Average holding time in ms. */
  avgHoldMs: number;
}

/** One month of the returns heatmap. */
export interface MonthlyReturn {
  /** e.g. "2026-03". */
  month: string;
  pnl: number;
  pnlPercent: number;
  trades: number;
  winRate: number;
}

/** Equity curve sample. */
export interface EquityPoint {
  time: number;
  equity: number;
  /** Drawdown from the running peak, as a negative percentage. */
  drawdownPercent: number;
}

// ---------------------------------------------------------------------------
// Risk management
// ---------------------------------------------------------------------------

export interface PositionSizeRequest {
  accountBalance: number;
  riskPercent: number;
  entryPrice: number;
  stopLoss: number;
  symbol: string;
  /** Optional override; otherwise derived from the symbol metadata. */
  contractSize?: number;
  tickSize?: number;
}

export interface PositionSizeResult {
  /** Account currency at risk. */
  riskAmount: number;
  /** Distance to stop in price terms. */
  stopDistance: number;
  /** Stop distance in pips (FX) or ticks. */
  stopDistanceTicks: number;
  /** Size in base units (crypto/equities). */
  quantity: number;
  /** Size in standard lots (FX). */
  lots: number;
  /** Notional exposure. */
  notional: number;
  /** Notional / balance. */
  leverage: number;
  warnings: string[];
}

/** Rolling risk exposure check. */
export interface RiskExposure {
  userId: string;
  accountBalance: number;
  openRiskPercent: number;
  dailyRiskUsedPercent: number;
  weeklyRiskUsedPercent: number;
  dailyLimitPercent: number;
  weeklyLimitPercent: number;
  openPositions: number;
  maxConcurrentTrades: number;
  /** True when any limit is breached — the UI blocks new-trade actions. */
  breached: boolean;
  breaches: string[];
}

/** Drawdown monitor state. */
export interface DrawdownState {
  peakEquity: number;
  currentEquity: number;
  drawdownPercent: number;
  drawdownAmount: number;
  /** ms since the equity peak. */
  durationMs: number;
  /** Configured alert level. */
  alertThresholdPercent: number;
  alerting: boolean;
}
