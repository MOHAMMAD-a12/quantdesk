/**
 * Portfolio service — the account as it stands right now.
 *
 * Two kinds of number live here and they must not be confused:
 *
 *   - **Realised** figures come from the `trades` table exactly as they were
 *     written at close. This module never recomputes them; see the header of
 *     `repository.ts` for why.
 *   - **Unrealised** figures are marked against a live quote and are true only
 *     for as long as the quote is. They are computed here, on read, and never
 *     stored — persisting a mark-to-market would turn a moment's price into a
 *     historical fact.
 *
 * `preferences.accountBalance` is interpreted throughout as **deposited
 * capital**, not live equity. The user types it once; everything after that is
 * derived. Treating it as live equity would mean every closed trade silently
 * double-counted — once in the number they typed, once in the realised PnL added
 * to it.
 */

import type {
  EquityPoint,
  MonthlyReturn,
  OpenPositionView,
  PerformanceStats,
  PortfolioSummary,
  Quote,
  Trade,
} from '@quantdesk/shared';
import { moduleLogger } from '../../core/logger.js';
import { resolveSymbols, toPublicSymbol } from '../markets/index.js';
import { marketRegistry } from '../../providers/market/registry.js';
import * as preferences from '../preferences/repository.js';
import { tradeRisk } from '../risk/calculator.js';
import * as repo from './repository.js';
import { breakdownBy, equityCurveFrom, monthlyReturns, performanceStats, type Breakdown } from './stats.js';

const log = moduleLogger('portfolio');

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

export interface Overview {
  summary: PortfolioSummary;
  positions: OpenPositionView[];
  /**
   * Symbols whose open positions could not be priced and are therefore marked
   * at their own entry. Non-empty means the equity figure is stale, and the
   * client is expected to say so rather than render it as current.
   */
  unpriced: string[];
}

/**
 * Summary and positions in one pass.
 *
 * Preferred over calling {@link summary} and {@link positions} separately: they
 * would each fetch quotes, and two marks taken a few hundred milliseconds apart
 * can disagree, leaving a page whose position rows do not add up to its own
 * equity total.
 */
export async function overview(userId: string): Promise<Overview> {
  const [prefs, open, closed] = await Promise.all([
    preferences.get(userId),
    repo.openPositions(userId),
    repo.closedTrades(userId),
  ]);

  const prices = await priceMap([...new Set(open.map((t) => t.symbol))]);
  const positions = open.map((trade) => mark(trade, prices.get(trade.symbol)?.price ?? null));
  const unpriced = [...new Set(open.map((t) => t.symbol))].filter((s) => !prices.has(s));

  const realisedPnl = closed.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const unrealisedPnl = positions.reduce((sum, p) => sum + p.unrealisedPnl, 0);

  const startingBalance = prefs.accountBalance;
  const balance = startingBalance + realisedPnl;
  const equity = balance + unrealisedPnl;
  const openRisk = open.reduce((sum, t) => sum + tradeRisk(t), 0);

  return {
    summary: {
      userId,
      currency: prefs.accountCurrency,
      startingBalance: round(startingBalance, 2),
      balance: round(balance, 2),
      equity: round(equity, 2),
      realisedPnl: round(realisedPnl, 2),
      unrealisedPnl: round(unrealisedPnl, 2),
      totalPnlPercent:
        startingBalance > 0 ? round(((equity - startingBalance) / startingBalance) * 100, 2) : 0,
      openTrades: open.length,
      closedTrades: closed.length,
      openRisk: round(openRisk, 2),
      // Against live equity, not deposited capital. A 2% risk budget on an
      // account that has halved is a smaller number of dollars, and quoting it
      // against the original deposit would let the user keep sizing off money
      // they no longer have.
      openRiskPercent: equity > 0 ? round((openRisk / equity) * 100, 2) : 0,
    },
    positions,
    unpriced,
  };
}

export async function summary(userId: string): Promise<PortfolioSummary> {
  return (await overview(userId)).summary;
}

/* -------------------------------------------------------------------------- */
/* Open positions                                                             */
/* -------------------------------------------------------------------------- */

export async function positions(userId: string): Promise<OpenPositionView[]> {
  return (await overview(userId)).positions;
}

/**
 * Mark one open trade against a price.
 *
 * A null price means no live quote was available. The position is still valued —
 * at its own entry, so unrealised PnL reads zero — rather than omitted. Dropping
 * it would make an open trade silently vanish from the user's screen during a
 * provider outage, which is the worst possible moment to hide one from someone.
 */
function mark(trade: Trade, price: number | null): OpenPositionView {
  const currentPrice = price ?? trade.entryPrice;

  // Same expression as the close-out SQL, deliberately: an unrealised PnL that
  // is computed differently from the realised one produces a visible jump at
  // the moment of closing that has nothing to do with the market.
  const gross =
    trade.side === 'long'
      ? (currentPrice - trade.entryPrice) * trade.quantity
      : (trade.entryPrice - currentPrice) * trade.quantity;

  // Fees already paid are subtracted; the exit leg's fees are not, because they
  // are not yet known and guessing them would understate every position by an
  // invented amount.
  const unrealisedPnl = gross - trade.fees;
  const committed = trade.entryPrice * trade.quantity;
  const risk = tradeRisk(trade);

  return {
    ...trade,
    currentPrice,
    unrealisedPnl: round(unrealisedPnl, 2),
    unrealisedPnlPercent: committed > 0 ? round((unrealisedPnl / committed) * 100, 2) : 0,
    // Null rather than zero when there is no stop: the position has no R,
    // because R is defined relative to a risk the trader never set.
    currentR: risk > 0 ? round(unrealisedPnl / risk, 2) : null,
    riskAmount: round(risk, 2),
  };
}

/**
 * Quotes for a set of symbols, keyed by symbol.
 *
 * One batch call for the distinct symbols rather than one per position — a user
 * with eight positions in BTCUSDT would otherwise trigger eight provider calls
 * for the same price. Symbols absent from the returned map had no usable quote.
 */
async function priceMap(symbols: string[]): Promise<Map<string, Quote>> {
  const map = new Map<string, Quote>();
  if (symbols.length === 0) return map;

  try {
    const records = await resolveSymbols(symbols);
    if (records.length === 0) return map;

    const quotes = await marketRegistry.getQuotes(records.map(toPublicSymbol));
    for (const quote of quotes) {
      // Synthetic quotes are dropped rather than used. A mark-to-market against
      // a made-up price is worse than no mark at all: it looks authoritative and
      // the user has no way to tell it apart from a real one.
      if (quote.synthetic) continue;
      map.set(quote.symbol, quote);
    }
  } catch (err) {
    // Degraded, not failed. The realised half of the portfolio is still correct
    // and worth showing; positions fall back to entry-price marks above.
    log.warn({ err, symbols }, 'Could not price open positions');
  }

  return map;
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                */
/* -------------------------------------------------------------------------- */

export interface PerformanceReport {
  stats: PerformanceStats;
  monthly: MonthlyReturn[];
  equityCurve: EquityPoint[];
  bySymbol: Breakdown[];
  byTag: Breakdown[];
  bySide: Breakdown[];
  /** Bounds of the data the report covers, or null when there are no trades. */
  from: number | null;
  to: number | null;
}

/**
 * Everything the performance page shows, over an optional window.
 *
 * Note the starting balance used for a windowed report: it is the equity as at
 * the *start of the window*, not the account's original deposit. A March report
 * that measured drawdown against a January balance would report percentages that
 * belong to neither month.
 */
export async function performance(
  userId: string,
  from: number | null = null,
  to: number | null = null,
): Promise<PerformanceReport> {
  const [prefs, all] = await Promise.all([
    preferences.get(userId),
    repo.closedTrades(userId),
  ]);

  const windowed = all.filter((t) => {
    const at = t.closedAt ?? t.openedAt;
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
    return true;
  });

  const priorPnl = all
    .filter((t) => from !== null && (t.closedAt ?? t.openedAt) < from)
    .reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  const openingBalance = prefs.accountBalance + priorPnl;

  const first = windowed[0];
  const last = windowed[windowed.length - 1];

  return {
    stats: performanceStats(windowed, openingBalance),
    monthly: monthlyReturns(windowed, openingBalance),
    equityCurve: equityCurveFrom(windowed, openingBalance),
    bySymbol: breakdownBy(windowed, (t) => [t.symbol]),
    // A trade with no tags contributes to no group rather than to an "untagged"
    // bucket — the breakdown answers "how do my tagged setups compare", and a
    // catch-all row large enough to dominate the chart answers nothing.
    byTag: breakdownBy(windowed, (t) => t.tags),
    bySide: breakdownBy(windowed, (t) => [t.side]),
    from: first ? (first.closedAt ?? first.openedAt) : null,
    to: last ? (last.closedAt ?? last.openedAt) : null,
  };
}

/**
 * The equity curve from stored daily snapshots, which include flat days.
 *
 * Preferred over {@link PerformanceReport.equityCurve} for the dashboard chart:
 * a curve derived from trades alone has a point only where a trade closed, so a
 * three-week drawdown renders as a single steep segment and reads as a bad
 * afternoon.
 */
export async function equityHistory(userId: string, days = 365): Promise<EquityPoint[]> {
  const snapshots = await repo.equityCurve(userId, days);

  let peak = snapshots[0]?.equity ?? 0;

  return snapshots.map((s) => {
    peak = Math.max(peak, s.equity);
    return {
      time: s.time,
      equity: s.equity,
      drawdownPercent: peak > 0 ? round(((s.equity - peak) / peak) * 100, 2) : 0,
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Journal                                                                    */
/* -------------------------------------------------------------------------- */

export async function record(input: repo.OpenTradeInput): Promise<Trade> {
  return repo.openTrade(input);
}

export async function close(
  id: string,
  userId: string,
  input: repo.CloseTradeInput,
): Promise<Trade | null> {
  return repo.closeTrade(id, userId, input);
}

export async function amend(
  id: string,
  userId: string,
  patch: repo.UpdateTradeInput,
): Promise<Trade | null> {
  return repo.updateTrade(id, userId, patch);
}

export const cancel = repo.cancelTrade;
export const remove = repo.deleteTrade;
export const list = repo.listTrades;
export const find = repo.findTrade;
export const tags = repo.tagsFor;
export const attribution = repo.signalAttribution;

/* -------------------------------------------------------------------------- */
/* Daily mark                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Write one user's equity snapshot for today.
 *
 * Called by the scheduled mark. Idempotent — running it twice in a day
 * overwrites the row rather than adding a second point, so a retried job cannot
 * bend the curve. Returns the summary it wrote so callers do not have to re-mark
 * the account to display the result.
 */
export async function markToMarket(
  userId: string,
  asOf: Date = new Date(),
): Promise<PortfolioSummary> {
  const s = await summary(userId);
  await repo.snapshotEquity(userId, s.balance, s.equity, s.realisedPnl, asOf);
  return s;
}

/**
 * Mark every account with recent activity.
 *
 * Sequential, not parallel. This runs unattended once a day with no user
 * waiting on it, and a burst of concurrent quote requests across every active
 * account is the fastest way to get the platform's API keys rate-limited at
 * exactly the hour nobody is watching.
 */
export async function markAllToMarket(asOf: Date = new Date()): Promise<{ marked: number; failed: number }> {
  const users = await repo.usersWithActivity();
  let marked = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      await markToMarket(userId, asOf);
      marked += 1;
    } catch (err) {
      // One bad account must not cost every later account its snapshot — a gap
      // in the curve is permanent, because tomorrow's job cannot reconstruct
      // today's open positions.
      failed += 1;
      log.error({ err, userId }, 'Equity snapshot failed');
    }
  }

  log.info({ marked, failed }, 'Daily equity mark complete');
  return { marked, failed };
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
