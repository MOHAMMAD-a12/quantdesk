/**
 * Performance statistics — pure functions over a closed-trade history.
 *
 * No I/O, no clock reads except where injected. Everything here is derived from
 * an array of closed trades sorted oldest-first, which makes each statistic
 * testable against a hand-written sequence — and these are numbers people use to
 * decide whether to keep trading a strategy, so being able to prove them matters
 * more than being able to compute them quickly.
 *
 * Two conventions, applied consistently:
 *
 *   - **Sample size travels with the answer.** A 100% win rate over three trades
 *     and one over three hundred are different claims, and the caller is given
 *     `totalTrades` alongside every ratio so it can say which it is holding.
 *   - **Undefined is zero, not omitted.** Profit factor with no losses is
 *     mathematically infinite; returning `Infinity` breaks JSON, and returning
 *     the gross profit pretends a denominator existed. These cases are pinned to
 *     documented values below, each with its reasoning.
 */

import type { EquityPoint, MonthlyReturn, PerformanceStats, Trade } from '@quantdesk/shared';

/** A trade closer to break-even than this counts as a scratch, not a win. */
const SCRATCH_EPSILON = 1e-9;

/** Trading days per year, for annualising Sharpe and Sortino. */
const TRADING_DAYS = 252;

export function emptyStats(): PerformanceStats {
  return {
    totalTrades: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    winRate: 0,
    profitFactor: 0,
    expectancy: 0,
    avgWin: 0,
    avgLoss: 0,
    avgRiskReward: 0,
    largestWin: 0,
    largestLoss: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    maxDrawdownPercent: 0,
    maxDrawdownAmount: 0,
    currentDrawdownPercent: 0,
    maxWinStreak: 0,
    maxLossStreak: 0,
    avgHoldMs: 0,
  };
}

/**
 * Full statistics over a closed-trade history.
 *
 * @param trades Closed trades, oldest first.
 * @param startingBalance Capital the equity curve starts from. Required for
 *   drawdown to be expressed as a percentage of anything meaningful — a curve
 *   that starts at zero makes the first losing trade a 100% drawdown.
 */
export function performanceStats(trades: Trade[], startingBalance: number): PerformanceStats {
  if (trades.length === 0) return emptyStats();

  const stats = emptyStats();
  stats.totalTrades = trades.length;

  let grossProfit = 0;
  let grossLoss = 0;
  let totalR = 0;
  let rCount = 0;
  let holdTotal = 0;
  let holdCount = 0;

  let winStreak = 0;
  let lossStreak = 0;

  for (const trade of trades) {
    const pnl = trade.pnl ?? 0;

    if (pnl > SCRATCH_EPSILON) {
      stats.wins += 1;
      grossProfit += pnl;
      stats.largestWin = Math.max(stats.largestWin, pnl);
      winStreak += 1;
      lossStreak = 0;
    } else if (pnl < -SCRATCH_EPSILON) {
      stats.losses += 1;
      grossLoss += Math.abs(pnl);
      stats.largestLoss = Math.min(stats.largestLoss, pnl);
      lossStreak += 1;
      winStreak = 0;
    } else {
      stats.breakEven += 1;
      // A scratch breaks both streaks: it is neither a continuation nor a
      // reversal, and counting it as either misrepresents the run.
      winStreak = 0;
      lossStreak = 0;
    }

    stats.maxWinStreak = Math.max(stats.maxWinStreak, winStreak);
    stats.maxLossStreak = Math.max(stats.maxLossStreak, lossStreak);

    if (trade.rMultiple !== null) {
      totalR += trade.rMultiple;
      rCount += 1;
    }

    if (trade.closedAt !== null) {
      holdTotal += Math.max(0, trade.closedAt - trade.openedAt);
      holdCount += 1;
    }
  }

  // Break-evens are counted in the denominator. Excluding them would let a
  // strategy that scratches out of nine trades and wins one report a 100% win
  // rate, which is true of the sample and false of the strategy.
  stats.winRate = round((stats.wins / stats.totalTrades) * 100, 2);

  // No losses at all: reported as gross profit rather than Infinity. It reads as
  // "very good" on a chart without claiming a ratio that has no denominator, and
  // the accompanying `totalTrades` is what tells the reader it is a small sample.
  stats.profitFactor = grossLoss > 0 ? round(grossProfit / grossLoss, 2) : round(grossProfit, 2);

  // Expectancy in R, not currency. R is the only unit in which a 0.5-lot trade
  // and a 5-lot trade are comparable, and comparing them is the entire point.
  stats.expectancy = rCount > 0 ? round(totalR / rCount, 3) : 0;

  stats.avgWin = stats.wins > 0 ? round(grossProfit / stats.wins, 2) : 0;
  stats.avgLoss = stats.losses > 0 ? round(grossLoss / stats.losses, 2) : 0;
  stats.avgRiskReward = stats.avgLoss > 0 ? round(stats.avgWin / stats.avgLoss, 2) : 0;
  stats.largestWin = round(stats.largestWin, 2);
  stats.largestLoss = round(stats.largestLoss, 2);
  stats.avgHoldMs = holdCount > 0 ? Math.round(holdTotal / holdCount) : 0;

  const curve = equityCurveFrom(trades, startingBalance);
  const dd = drawdownOf(curve);
  stats.maxDrawdownPercent = dd.maxPercent;
  stats.maxDrawdownAmount = dd.maxAmount;
  stats.currentDrawdownPercent = dd.currentPercent;

  const daily = dailyReturns(trades, startingBalance);
  stats.sharpeRatio = sharpe(daily);
  stats.sortinoRatio = sortino(daily);

  return stats;
}

/* -------------------------------------------------------------------------- */
/* Equity curve and drawdown                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build an equity curve from closed trades.
 *
 * Stamped at close time, not open time. A position held for three weeks did not
 * change the account's realised equity until it was exited, and marking it at
 * entry would show a drawdown recovering before the trade that recovered it had
 * actually closed.
 */
export function equityCurveFrom(trades: Trade[], startingBalance: number): EquityPoint[] {
  const points: EquityPoint[] = [];
  let equity = startingBalance;
  let peak = startingBalance;

  // The origin, so a curve with one trade still has a line rather than a dot.
  if (trades.length > 0) {
    const first = trades[0];
    points.push({
      time: first ? first.openedAt : 0,
      equity: round(startingBalance, 2),
      drawdownPercent: 0,
    });
  }

  for (const trade of trades) {
    equity += trade.pnl ?? 0;
    peak = Math.max(peak, equity);

    points.push({
      time: trade.closedAt ?? trade.openedAt,
      equity: round(equity, 2),
      // Negative by convention, so it plots below the axis without the consumer
      // having to know to flip the sign.
      drawdownPercent: peak > 0 ? round(((equity - peak) / peak) * 100, 2) : 0,
    });
  }

  return points;
}

function drawdownOf(curve: EquityPoint[]): {
  maxPercent: number;
  maxAmount: number;
  currentPercent: number;
} {
  let peak = curve[0]?.equity ?? 0;
  let maxPercent = 0;
  let maxAmount = 0;

  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    const amount = peak - point.equity;
    const percent = peak > 0 ? (amount / peak) * 100 : 0;

    maxAmount = Math.max(maxAmount, amount);
    maxPercent = Math.max(maxPercent, percent);
  }

  const last = curve[curve.length - 1];
  const currentPercent = last && peak > 0 ? ((peak - last.equity) / peak) * 100 : 0;

  return {
    maxPercent: round(maxPercent, 2),
    maxAmount: round(maxAmount, 2),
    currentPercent: round(currentPercent, 2),
  };
}

/* -------------------------------------------------------------------------- */
/* Risk-adjusted return                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Daily fractional returns, aggregating trades closed on the same day.
 *
 * Per *day* rather than per trade, because Sharpe is defined over a time series
 * and a per-trade series has no consistent period to annualise from. A trader
 * who takes forty trades one week and none the next would otherwise have their
 * ratio scaled by activity rather than by risk.
 *
 * Days with no closed trades are not inserted as zeros. Doing so would suppress
 * the standard deviation of anyone who trades twice a month and hand them an
 * excellent Sharpe for having been flat most of the time.
 */
function dailyReturns(trades: Trade[], startingBalance: number): number[] {
  if (startingBalance <= 0) return [];

  const byDay = new Map<string, number>();

  for (const trade of trades) {
    const at = trade.closedAt ?? trade.openedAt;
    const day = new Date(at).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + (trade.pnl ?? 0));
  }

  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Compounded against running equity, not against the starting balance: a
  // $500 gain is a different return on a $10k account than on a $50k one, and
  // dividing everything by the opening figure overstates late-history results.
  let equity = startingBalance;
  const returns: number[] = [];

  for (const [, pnl] of days) {
    if (equity <= 0) break; // Account blown; further returns are meaningless.
    returns.push(pnl / equity);
    equity += pnl;
  }

  return returns;
}

/** Annualised Sharpe, risk-free rate zero. */
function sharpe(returns: number[]): number {
  // Two samples cannot establish a standard deviation worth reporting.
  if (returns.length < 3) return 0;

  const mean = average(returns);
  const sd = standardDeviation(returns, mean);
  if (sd === 0) return 0;

  return round((mean / sd) * Math.sqrt(TRADING_DAYS), 2);
}

/**
 * Annualised Sortino.
 *
 * Identical to Sharpe except the denominator counts only downside deviation.
 * The distinction matters for trend-following: a strategy whose upside is
 * lumpy is punished by Sharpe for exactly the behaviour a trader wants.
 */
function sortino(returns: number[]): number {
  if (returns.length < 3) return 0;

  const mean = average(returns);
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0;

  // Deviation below zero, not below the mean — the target return is "don't lose
  // money", and measuring against the mean would treat a small gain in a great
  // month as downside.
  const dd = Math.sqrt(downside.reduce((sum, r) => sum + r * r, 0) / returns.length);
  if (dd === 0) return 0;

  return round((mean / dd) * Math.sqrt(TRADING_DAYS), 2);
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function standardDeviation(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  // Sample standard deviation (n − 1): these returns are a sample of the
  // strategy's behaviour, not the entire population of what it can do.
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/* -------------------------------------------------------------------------- */
/* Monthly returns                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Month-by-month results for the returns heatmap.
 *
 * `pnlPercent` compounds against the equity at the start of each month, so the
 * column sums the way a reader expects: twelve months of +5% is not +60%.
 */
export function monthlyReturns(trades: Trade[], startingBalance: number): MonthlyReturn[] {
  const buckets = new Map<string, { pnl: number; trades: number; wins: number }>();

  for (const trade of trades) {
    const at = trade.closedAt ?? trade.openedAt;
    const month = new Date(at).toISOString().slice(0, 7);

    const bucket = buckets.get(month) ?? { pnl: 0, trades: 0, wins: 0 };
    const pnl = trade.pnl ?? 0;

    bucket.pnl += pnl;
    bucket.trades += 1;
    if (pnl > SCRATCH_EPSILON) bucket.wins += 1;

    buckets.set(month, bucket);
  }

  let equity = startingBalance;

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, bucket]) => {
      const opening = equity;
      equity += bucket.pnl;

      return {
        month,
        pnl: round(bucket.pnl, 2),
        pnlPercent: opening > 0 ? round((bucket.pnl / opening) * 100, 2) : 0,
        trades: bucket.trades,
        winRate: bucket.trades > 0 ? round((bucket.wins / bucket.trades) * 100, 2) : 0,
      };
    });
}

/* -------------------------------------------------------------------------- */
/* Breakdowns                                                                 */
/* -------------------------------------------------------------------------- */

export interface Breakdown {
  key: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  expectancy: number;
}

/**
 * Group results by an arbitrary key — symbol, tag, session, side.
 *
 * This is the view that answers "what am I actually good at", and it is usually
 * more useful than the headline numbers: a trader with a mediocre overall
 * expectancy is often an excellent trader of two instruments and a poor trader of
 * six others.
 */
export function breakdownBy(trades: Trade[], keyOf: (t: Trade) => string[]): Breakdown[] {
  const buckets = new Map<string, { trades: number; wins: number; pnl: number; r: number; rCount: number }>();

  for (const trade of trades) {
    const pnl = trade.pnl ?? 0;

    for (const key of keyOf(trade)) {
      const bucket = buckets.get(key) ?? { trades: 0, wins: 0, pnl: 0, r: 0, rCount: 0 };
      bucket.trades += 1;
      bucket.pnl += pnl;
      if (pnl > SCRATCH_EPSILON) bucket.wins += 1;
      if (trade.rMultiple !== null) {
        bucket.r += trade.rMultiple;
        bucket.rCount += 1;
      }
      buckets.set(key, bucket);
    }
  }

  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      trades: b.trades,
      wins: b.wins,
      winRate: round((b.wins / b.trades) * 100, 2),
      pnl: round(b.pnl, 2),
      expectancy: b.rCount > 0 ? round(b.r / b.rCount, 3) : 0,
    }))
    .sort((a, b) => b.pnl - a.pnl);
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
