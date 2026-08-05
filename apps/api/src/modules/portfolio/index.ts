/**
 * The portfolio module — trade journal, valuation and performance statistics.
 *
 * `stats.ts` is exported alongside the service because it is pure: anything that
 * already holds a list of closed trades (a backtest, an admin report, a test)
 * can compute the same figures without going through the database.
 */

export { portfolioRouter } from './routes.js';
export {
  amend,
  attribution,
  cancel,
  close,
  equityHistory,
  find,
  list,
  markAllToMarket,
  markToMarket,
  overview,
  performance,
  positions,
  record,
  remove,
  summary,
  tags,
  type Overview,
  type PerformanceReport,
} from './service.js';
export {
  breakdownBy,
  emptyStats,
  equityCurveFrom,
  monthlyReturns,
  performanceStats,
  type Breakdown,
} from './stats.js';
export {
  closedTrades,
  openPositions,
  usersWithActivity,
  type CloseTradeInput,
  type OpenTradeInput,
  type TradeFilter,
  type UpdateTradeInput,
} from './repository.js';
