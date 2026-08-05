/**
 * The risk module — position sizing, exposure limits and the drawdown monitor.
 *
 * `calculator.ts` is exported directly because it is pure: the signal engine and
 * any future backtester can size a position without touching the database.
 */

export { riskRouter } from './routes.js';
export {
  current,
  drawdownState,
  openRisk,
  periodBounds,
  preTrade,
  size,
  type PreTradeRequest,
  type SizeRequest,
} from './service.js';
export {
  checkPreTrade,
  drawdown,
  exposure,
  positionSize,
  tradeRisk,
  type DrawdownInput,
  type ExposureInput,
  type PreTradeCheck,
} from './calculator.js';
