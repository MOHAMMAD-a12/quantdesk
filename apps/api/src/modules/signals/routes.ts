/**
 * Signal endpoints.
 *
 * Reads are available to any authenticated user; generation is not. Generating a
 * signal costs several provider calls plus a model call, so `POST /generate` sits
 * behind its own tight bucket and a premium-or-above role check. Reading the
 * signals the scheduler already produced is free and stays open to everyone.
 *
 * Lifecycle writes (`PATCH /:id/status`) are admin-only. A track record whose
 * outcomes any user could edit would be worthless, and the honesty of the
 * accuracy figures is the whole point of persisting signals in the first place.
 */

import { Router } from 'express';
import { z } from 'zod';
import { generateSignalSchema, signalListQuerySchema } from '@quantdesk/shared';
import { ok, okPage } from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { authenticate, requireAdmin, requireRole } from '../auth/middleware.js';
import * as service from './service.js';

export const signalsRouter = Router();

signalsRouter.use(authenticate, rateLimit({ bucket: 'signals' }));

const idParamSchema = z.object({ id: z.string().uuid('Not a valid signal id') });

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Paged signal history.
 *
 * Ordered newest-first and filterable on every dimension the UI exposes. The
 * total is returned in `X-Total-Count` as well as the body so the table can size
 * its pager without unwrapping the envelope.
 */
signalsRouter.get(
  '/',
  validate({ query: signalListQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, signalListQuerySchema);

    const { items, total } = await service.list({
      symbol: q.symbol,
      action: q.action,
      status: q.status,
      timeframe: q.timeframe,
      minConfidence: q.minConfidence,
      from: q.from,
      to: q.to,
      page: q.page,
      pageSize: q.pageSize,
    });

    okPage(res, items, total, q.page, q.pageSize);
  }),
);

/**
 * Currently-open signals.
 *
 * The dashboard's live panel. Registered before `/:id` so the literal path is
 * not captured by the parameter route.
 */
signalsRouter.get(
  '/active',
  asyncHandler(async (_req, res) => {
    const signals = await service.active();
    ok(res, signals, { count: signals.length });
  }),
);

/**
 * Engine accuracy by confidence band.
 *
 * The calibration view: does an 80-confidence signal actually win 80% of the
 * time? Open to all authenticated users deliberately — a platform that hides its
 * own hit rate from the people acting on it does not deserve their trust.
 */
const accuracyQuerySchema = z.object({
  /** Restrict to signals generated in the last N days. */
  days: z.coerce.number().int().min(1).max(3650).optional(),
});

signalsRouter.get(
  '/accuracy',
  validate({ query: accuracyQuerySchema }),
  asyncHandler(async (req, res) => {
    const { days } = queryOf(req, accuracyQuerySchema);
    const since = days === undefined ? undefined : Date.now() - days * 24 * 60 * 60 * 1000;

    const buckets = await service.accuracy(since);
    const resolved = buckets.reduce((acc, b) => acc + b.wins + b.losses, 0);

    ok(res, buckets, {
      resolved,
      // Stated explicitly because a win rate over nine closed trades looks
      // identical to one over nine hundred in a bar chart, and only one of them
      // means anything.
      sufficientSample: resolved >= 30,
      ...(days !== undefined ? { windowDays: days } : {}),
    });
  }),
);

/** Per-signal outcomes, including excursion, for the analytics table. */
const performanceQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

signalsRouter.get(
  '/performance',
  validate({ query: performanceQuerySchema }),
  asyncHandler(async (req, res) => {
    const { limit } = queryOf(req, performanceQuerySchema);
    const rows = await service.performance(limit);
    ok(res, rows, { count: rows.length });
  }),
);

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generate a signal on demand.
 *
 * Premium and above. Its own bucket, far tighter than the module default: this
 * is the single most expensive operation the API offers, fanning out to one
 * provider call per MTF timeframe plus an LLM call.
 *
 * `meta` reports how the signal was actually produced — whether the narration
 * ran, why it did not, whether the daily cap suppressed persistence, and whether
 * any candle was synthetic. All four are things a user acting on the signal is
 * entitled to know, and none of them are inferable from the signal body alone.
 */
signalsRouter.post(
  '/generate',
  requireRole('premium'),
  rateLimit({ bucket: 'signals:generate', max: 30 }),
  validate({ body: generateSignalSchema }),
  asyncHandler(async (req, res) => {
    const body = bodyOf(req, generateSignalSchema);

    const result = await service.generate({
      symbol: body.symbol,
      timeframe: body.timeframe,
      deterministicOnly: body.deterministicOnly,
      ...(body.minConfidence !== undefined ? { minConfidence: body.minConfidence } : {}),
      userId: req.user?.id ?? null,
      persist: true,
    });

    ok(res, result.signal, {
      narrated: result.narrated,
      narrationError: result.narrationError,
      capped: result.capped,
      waitReason: result.waitReason,
      synthetic: result.signal.synthetic,
    });
  }),
);

/**
 * Run the engine across the whole scannable universe.
 *
 * Admin-only and severely rate limited. This is the scheduler's job exposed as an
 * endpoint so an operator can trigger a cycle by hand; it is not something a
 * client should ever call in a loop.
 */
const scanBodySchema = signalListQuerySchema.pick({ timeframe: true });

signalsRouter.post(
  '/scan',
  requireAdmin,
  rateLimit({ bucket: 'signals:scan', max: 4 }),
  validate({ body: scanBodySchema }),
  asyncHandler(async (req, res) => {
    const { timeframe } = bodyOf(req, scanBodySchema);

    const result = await service.scan({
      ...(timeframe !== undefined ? { timeframe } : {}),
      userId: req.user?.id ?? null,
    });

    ok(res, result.signals, {
      scanned: result.scanned,
      generated: result.generated,
      waited: result.waited,
      failed: result.failed,
      capped: result.capped,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Record an outcome.
 *
 * Admin-only. `realisedR` is what feeds the accuracy figures, so this is the one
 * write on the whole module that can change what the platform claims about
 * itself.
 */
const resolveSchema = z.object({
  status: z.enum([
    'active',
    'triggered',
    'tp1_hit',
    'tp2_hit',
    'tp3_hit',
    'stopped_out',
    'expired',
    'invalidated',
    'cancelled',
  ]),
  realisedR: z.number().min(-100).max(100).nullable().optional(),
  price: z.number().positive().nullable().optional(),
  note: z.string().max(1000).nullable().optional(),
});

signalsRouter.patch(
  '/:id/status',
  requireAdmin,
  validate({ params: idParamSchema, body: resolveSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const body = bodyOf(req, resolveSchema);

    const existing = await service.find(id);
    if (!existing) throw new NotFoundError('Signal');

    const updated = await service.resolve(id, body.status, {
      realisedR: body.realisedR ?? null,
      price: body.price ?? null,
      note: body.note ?? null,
    });

    ok(res, updated);
  }),
);

/**
 * Expire everything past its horizon.
 *
 * Exposed for the same reason as `/scan`: the scheduler owns this, but an
 * operator needs to be able to run it after a period of downtime without waiting
 * for the next tick.
 */
signalsRouter.post(
  '/expire',
  requireAdmin,
  rateLimit({ bucket: 'signals:expire', max: 10 }),
  asyncHandler(async (_req, res) => {
    const ids = await service.expire();
    ok(res, ids, { expired: ids.length });
  }),
);

/**
 * One signal by id.
 *
 * Registered last so the literal paths above are not swallowed by `:id`.
 */
signalsRouter.get(
  '/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const signal = await service.find(id);
    if (!signal) throw new NotFoundError('Signal');
    ok(res, signal, { synthetic: signal.synthetic });
  }),
);
