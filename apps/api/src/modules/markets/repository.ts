/**
 * The market universe.
 *
 * `market_symbols` is the authoritative list of what the platform trades. It is
 * seeded from `DEFAULT_MARKETS` and editable from the admin panel, and every
 * other module resolves a symbol string through here before touching a provider.
 * That indirection is what keeps a user-supplied ticker from reaching an upstream
 * URL unvalidated.
 *
 * The full list is cached in Redis for five minutes. It changes only when an
 * operator edits it, so a per-request query for a table of a few dozen rows would
 * be pure overhead on the dashboard's hot path.
 */

import type { AssetClass, MarketSymbol } from '@quantdesk/shared';
import { UnsupportedSymbolError } from '../../core/errors.js';
import { query, queryOne } from '../../db/pool.js';
import { CacheKeys, CacheTtl, cacheDel, cacheWrap } from '../../db/redis.js';
import { toNumRequired } from '../../db/rows.js';

interface SymbolRow {
  symbol: string;
  name: string;
  asset_class: AssetClass;
  base: string | null;
  quote: string | null;
  price_precision: number;
  tick_size: string;
  contract_size: string | null;
  tradingview_symbol: string;
  scan_enabled: boolean;
  display_order: number;
  preferred_provider: string | null;
}

const COLUMNS = `
  symbol, name, asset_class, base, quote, price_precision, tick_size,
  contract_size, tradingview_symbol, scan_enabled, display_order, preferred_provider
`;

/**
 * A symbol plus the operator's provider preference.
 *
 * `preferredProvider` is not part of the shared `MarketSymbol` because the web
 * client has no use for it — it is routing metadata, and leaking which upstream
 * serves which instrument tells a caller more about the deployment than it needs
 * to know.
 */
export interface SymbolRecord extends MarketSymbol {
  preferredProvider: string | null;
}

function mapSymbol(row: SymbolRow): SymbolRecord {
  return {
    symbol: row.symbol,
    name: row.name,
    assetClass: row.asset_class,
    // The column is nullable for instruments with no meaningful pair (an index),
    // but the domain type is a string — an empty string is the honest rendering.
    base: row.base ?? '',
    quote: row.quote ?? '',
    pricePrecision: row.price_precision,
    tickSize: toNumRequired(row.tick_size, 0.01),
    contractSize: toNumRequired(row.contract_size, 1),
    tradingViewSymbol: row.tradingview_symbol,
    scanEnabled: row.scan_enabled,
    displayOrder: row.display_order,
    preferredProvider: row.preferred_provider,
  };
}

/** Strip routing metadata for responses. */
export function toPublicSymbol(record: SymbolRecord): MarketSymbol {
  const { preferredProvider: _preferredProvider, ...rest } = record;
  return rest;
}

/** Every symbol, ordered as the dashboard displays them. Cached. */
export async function listSymbols(): Promise<SymbolRecord[]> {
  return cacheWrap(CacheKeys.symbols(), CacheTtl.symbols, async () => {
    const rows = await query<SymbolRow>(
      `SELECT ${COLUMNS} FROM market_symbols ORDER BY display_order ASC, symbol ASC`,
    );
    return rows.map(mapSymbol);
  });
}

export async function listByAssetClass(assetClass: AssetClass): Promise<SymbolRecord[]> {
  const all = await listSymbols();
  return all.filter((s) => s.assetClass === assetClass);
}

/** Symbols the automated scanner should cover. */
export async function listScanEnabled(): Promise<SymbolRecord[]> {
  const all = await listSymbols();
  return all.filter((s) => s.scanEnabled);
}

/** Look up one symbol. Returns null when unknown. */
export async function findSymbol(symbol: string): Promise<SymbolRecord | null> {
  const all = await listSymbols();
  const upper = symbol.toUpperCase();
  return all.find((s) => s.symbol === upper) ?? null;
}

/**
 * Look up one symbol or refuse.
 *
 * The standard entry point for request handlers: an unknown ticker becomes a 400
 * naming the symbol, not a 500 from a provider that was handed a string it could
 * not parse.
 *
 * @throws {UnsupportedSymbolError} when the symbol is not in the universe.
 */
export async function requireSymbol(symbol: string): Promise<SymbolRecord> {
  const found = await findSymbol(symbol);
  if (!found) throw new UnsupportedSymbolError(symbol);
  return found;
}

/** Resolve many symbols, silently dropping unknown ones. For batch quotes. */
export async function resolveSymbols(symbols: string[]): Promise<SymbolRecord[]> {
  const all = await listSymbols();
  const wanted = new Set(symbols.map((s) => s.toUpperCase()));
  return all.filter((s) => wanted.has(s.symbol));
}

/* -------------------------------------------------------------------------- */
/* Admin mutations                                                            */
/* -------------------------------------------------------------------------- */

export interface SymbolUpdate {
  name?: string;
  scanEnabled?: boolean;
  displayOrder?: number;
  preferredProvider?: string | null;
  pricePrecision?: number;
  tickSize?: number;
  tradingViewSymbol?: string;
}

/**
 * Update an existing symbol.
 *
 * `COALESCE($n, column)` applies only the fields supplied, so a partial update
 * cannot blank the rest. The cache is invalidated on write — a five-minute stale
 * window after an operator disables scanning on a symbol would be a surprising
 * amount of time for the scanner to keep hitting it.
 */
export async function updateSymbol(
  symbol: string,
  patch: SymbolUpdate,
): Promise<SymbolRecord | null> {
  const row = await queryOne<SymbolRow>(
    `UPDATE market_symbols SET
       name               = COALESCE($2, name),
       scan_enabled       = COALESCE($3, scan_enabled),
       display_order      = COALESCE($4, display_order),
       preferred_provider = CASE WHEN $5::boolean THEN $6 ELSE preferred_provider END,
       price_precision    = COALESCE($7, price_precision),
       tick_size          = COALESCE($8, tick_size),
       tradingview_symbol = COALESCE($9, tradingview_symbol),
       updated_at         = now()
     WHERE symbol = $1
     RETURNING ${COLUMNS}`,
    [
      symbol.toUpperCase(),
      patch.name ?? null,
      patch.scanEnabled ?? null,
      patch.displayOrder ?? null,
      // Distinguishes "clear the preference" (explicit null) from "leave it
      // alone" (absent), which COALESCE alone cannot express.
      'preferredProvider' in patch,
      patch.preferredProvider ?? null,
      patch.pricePrecision ?? null,
      patch.tickSize ?? null,
      patch.tradingViewSymbol ?? null,
    ],
  );

  await invalidateSymbolCache();
  return row ? mapSymbol(row) : null;
}

export async function invalidateSymbolCache(): Promise<void> {
  await cacheDel(CacheKeys.symbols());
}
