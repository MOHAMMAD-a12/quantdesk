/**
 * Technical analysis endpoints.
 *
 * Authenticated, unlike `/markets` — an analysis is the platform's actual
 * product, and it costs provider calls and CPU per request in a way a cached
 * quote does not.
 *
 * Every response here is the deterministic engine's output. No LLM is involved
 * on this path at all: the narrative layer lives on `/signals`, where it
 * annotates numbers this endpoint already produced. That separation is what
 * lets the analysis endpoint keep working, unchanged, with no AI provider
 * configured.
 */

import { Router } from 'express';
import { z } from 'zod';
import { analysisQuerySchema, symbolParamSchema } from '@quantdesk/shared';
import { ok } from '../../core/http.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { authenticate } from '../auth/middleware.js';
import * as service from './service.js';

export const analysisRouter = Router();

/**
 * Its own bucket, tighter than `/markets`.
 *
 * An MTF analysis fans out to one provider call per timeframe, so a client
 * looping over the universe here is materially more expensive than the same
 * loop against the quote endpoint.
 */
analysisRouter.use(authenticate, rateLimit({ bucket: 'analysis' }));

/**
 * Full analysis for one symbol.
 *
 * `mtf` defaults to true because the multi-timeframe read is what distinguishes
 * this from a chart with indicators drawn on it — a 15m bullish structure inside
 * a 4h downtrend is a different proposition from the same 15m read in an
 * aligned market, and the client should not have to opt into knowing that.
 */
analysisRouter.get(
  '/:symbol',
  validate({ params: symbolParamSchema, query: analysisQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const { timeframe, mtf, correlations, lookback } = queryOf(req, analysisQuerySchema);

    const analysis = await service.analyseSymbol({
      symbol,
      timeframe,
      mtf,
      correlations,
      lookback,
    });

    ok(res, analysis, {
      // Surfaced in the response rather than left to the client to infer from
      // the payload: a UI badge reading "synthetic data" must not depend on
      // whoever wrote the frontend remembering to check a nested flag.
      synthetic: analysis.synthetic,
      deterministic: true,
    });
  }),
);

/**
 * Analysis for many symbols at once.
 *
 * The market-overview grid: one request, one timeframe, the whole watchlist.
 * MTF and correlations are off on this path — running them for twenty symbols
 * would be eighty provider calls for a screen the user glances at.
 *
 * Symbols that fail are omitted rather than nulled, and `meta` reports the
 * difference so the client can show "3 of 20 unavailable" instead of silently
 * rendering a shorter list.
 *
 * `symbols` is added to the schema rather than read off the raw query, because
 * `validate()` replaces `req.query` with the parsed object — anything the schema
 * does not declare is stripped before the handler runs.
 */
const batchQuerySchema = analysisQuerySchema.extend({
  symbols: z
    .string()
    .min(1, 'At least one symbol is required')
    .transform((raw) =>
      raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s !== ''),
    )
    // Capped rather than paginated: this endpoint is a dashboard fan-out, and a
    // caller wanting the hundredth symbol wants a second request, not a slower
    // first one.
    .pipe(z.array(z.string()).min(1, 'At least one symbol is required').max(25)),
});

analysisRouter.get(
  '/',
  validate({ query: batchQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbols, timeframe } = queryOf(req, batchQuerySchema);

    const analyses = await service.analyseBatch(symbols, timeframe);

    ok(res, analyses, {
      requested: symbols.length,
      returned: analyses.length,
      timeframe,
      synthetic: analyses.some((a) => a.synthetic),
    });
  }),
);
