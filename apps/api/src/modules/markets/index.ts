/**
 * The markets module — the tradable universe and provider-backed price data.
 *
 * Anything that needs to turn a symbol string into something a provider can be
 * called with goes through `requireSymbol`.
 */

export { marketsRouter } from './routes.js';
export {
  findSymbol,
  invalidateSymbolCache,
  listByAssetClass,
  listScanEnabled,
  listSymbols,
  requireSymbol,
  resolveSymbols,
  toPublicSymbol,
  updateSymbol,
  type SymbolRecord,
  type SymbolUpdate,
} from './repository.js';
