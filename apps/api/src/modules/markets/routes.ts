/**
 * Market data endpoints.
 *
 * Read-only and public by design — a price is not privileged information, and
 * requiring a login to see BTC quote the dashboard already shows would be
 * theatre. `optionalAuth` runs anyway so the rate limiter can key on the user id
 * rather than a shared NAT address, and so premium callers get their own budget.
 *
 * Every response here is provider data or a documented refusal. When no provider
 * can serve a symbol the client gets `UNSUPPORTED_SYMBOL`, never a fabricated
 * price — the single rule this platform's credibility rests on.
 */

import { Router } from 'express';
import {
  candlesQuerySchema,
  quotesQuerySchema,
  symbolParamSchema,
  type AssetClass,
} from '@quantdesk/shared';
import { ok } from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { optionalAuth } from '../auth/middleware.js';
import { marketRegistry } from '../../providers/market/registry.js';
import * as repo from './repository.js';

export const marketsRouter = Router();

/** Shared budget for market reads: cheap, cached, but provider-bounded. */
const marketLimit = rateLimit({ bucket: 'markets' });

marketsRouter.use(optionalAuth, marketLimit);

const ASSET_CLASSES: readonly AssetClass[] = ['crypto', 'forex', 'stock', 'index', 'commodity'];

function isAssetClass(value: unknown): value is AssetClass {
  return typeof value === 'string' && (ASSET_CLASSES as readonly string[]).includes(value);
}

/**
 * The tradable universe.
 *
 * Also reports which providers are live, so the UI can show an honest banner when
 * the platform is running without market data configured instead of rendering
 * empty charts with no explanation.
 */
marketsRouter.get(
  '/symbols',
  asyncHandler(async (req, res) => {
    const assetClass = req.query.assetClass;
    const records = isAssetClass(assetClass)
      ? await repo.listByAssetClass(assetClass)
      : await repo.listSymbols();

    ok(res, records.map(repo.toPublicSymbol), {
      providers: marketRegistry.listProviders(),
      liveData: marketRegistry.hasLiveProvider(),
    });
  }),
);

marketsRouter.get(
  '/symbols/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const record = await repo.findSymbol(symbol);
    if (!record) throw new NotFoundError(`Symbol ${symbol}`);
    ok(res, repo.toPublicSymbol(record));
  }),
);

/**
 * Batch quotes.
 *
 * The registry groups symbols by serving provider so a 17-symbol dashboard makes
 * one upstream call per provider rather than 17. Symbols no provider can serve are
 * omitted from the array; the `requested` vs returned count lets the client tell
 * the difference between "no data" and "not asked for".
 */
marketsRouter.get(
  '/quotes',
  validate({ query: quotesQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbols } = queryOf(req, quotesQuerySchema);
    const records = await repo.resolveSymbols(symbols);
    const quotes = await marketRegistry.getQuotes(records);

    ok(res, quotes, { requested: symbols.length, resolved: records.length });
  }),
);

marketsRouter.get(
  '/quote/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const record = await repo.requireSymbol(symbol);
    const quote = await marketRegistry.getQuote(record, record.preferredProvider);
    ok(res, quote);
  }),
);

/**
 * OHLCV candles.
 *
 * The forming candle is *not* dropped here — this endpoint feeds the chart, and a
 * chart that omits the live bar looks frozen. The analysis engine drops it on its
 * own path, so the number a signal is derived from and the number a user sees
 * plotted stay consistent with their different purposes.
 */
marketsRouter.get(
  '/candles/:symbol',
  validate({ params: symbolParamSchema, query: candlesQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const { timeframe, limit, before } = queryOf(req, candlesQuerySchema);

    const record = await repo.requireSymbol(symbol);
    const candles = await marketRegistry.getCandles(
      record,
      timeframe,
      limit,
      record.preferredProvider,
    );

    // Historical paging is applied after the fetch rather than pushed into the
    // adapters: not every provider supports an end-time parameter, and slicing a
    // cached window keeps the behaviour identical across all of them.
    const filtered = before ? candles.filter((c) => c.time < before) : candles;

    ok(res, filtered.slice(-limit), {
      symbol: record.symbol,
      timeframe,
      pricePrecision: record.pricePrecision,
      synthetic: filtered.some((c) => c.synthetic === true),
    });
  }),
);

/**
 * Funding rate, open interest and long/short ratio.
 *
 * 404 rather than an empty object for instruments that have no derivatives
 * context: an equity does not have a funding rate, and returning zeros would
 * feed the confluence layer a reading that looks measured but is fictional.
 */
marketsRouter.get(
  '/derivatives/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const record = await repo.requireSymbol(symbol);
    const derivatives = await marketRegistry.getDerivatives(record);
    if (!derivatives) throw new NotFoundError(`Derivatives data for ${symbol}`);
    ok(res, derivatives);
  }),
);

marketsRouter.get(
  '/orderbook/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const record = await repo.requireSymbol(symbol);
    const depth = Math.min(100, Math.max(5, Number(req.query.depth) || 50));
    const book = await marketRegistry.getOrderBook(record, depth);
    if (!book) throw new NotFoundError(`Order book for ${symbol}`);
    ok(res, book);
  }),
);
