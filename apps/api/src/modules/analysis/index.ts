/**
 * The analysis module — turning candles into actionable technical reads.
 *
 * Exposes two surfaces: the full `TechnicalAnalysis` object via `/analysis`, and
 * the AI-narrated `Signal` via `/signals`. Keeping them separate is deliberate:
 * the analysis is deterministic and never calls a model, so it stays fast and
 * never blocks on the LLM. The signal path *uses* that analysis and adds the
 * narrative layer — meaning the platform's numbers exist independently of any
 * AI provider's availability.
 */

export { analysisRouter } from './routes.js';
export {
  analyseBatch,
  analyseSymbol,
  listScannable,
  validateMtfTimeframes,
  InsufficientDataError,
} from './service.js';
export type { AnalyseRequest } from './service.js';
