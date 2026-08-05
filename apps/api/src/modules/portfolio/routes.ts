/**
 * Portfolio and trade journal endpoints.
 *
 * Every route here is scoped to `req.user.id`. No endpoint accepts a user id as a
 * parameter, and no ownership check happens in a handler — the user id is taken
 * from the verified token and passed into repository calls that carry
 * `AND user_id = $n` in their WHERE clauses. That is deliberate: an ownership
 * check written as a separate read leaves a window between the check and the
 * write, and one forgotten check on one route exposes a stranger's track record.
 *
 * Admins are not exempt. `requireAdmin` grants access to platform data, not to
 * other people's trading journals; an operator who needs those goes through the
 * admin module, where the access is audited.
 */

import { Router } from 'express';
import { z } from 'zod';
import { closeTradeSchema, createTradeSchema, paginationSchema, updateTradeSchema } from '@quantdesk/shared';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { created, ok, okPage } from '../../core/http.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { authenticate } from '../auth/middleware.js';
import * as service from './service.js';

export const portfolioRouter = Router();

portfolioRouter.use(authenticate, rateLimit({ bucket: 'portfolio' }));

const idParamSchema = z.object({ id: z.string().uuid('Not a valid trade id') });

/** Epoch-millisecond window, shared by the report endpoints. */
const windowSchema = z.object({
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});

/* -------------------------------------------------------------------------- */
/* Overview                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Balance, equity, and open exposure.
 *
 * `meta.unpriced` lists any symbols the mark could not price. A summary computed
 * during a provider outage is still returned — the realised figures are
 * unaffected — but a non-empty list means the equity number is stale and the
 * client must not present it as current.
 */
portfolioRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const view = await service.overview(req.user!.id);
    ok(res, view.summary, { unpriced: view.unpriced, marked: view.unpriced.length === 0 });
  }),
);

/** Open positions marked to market. */
portfolioRouter.get(
  '/positions',
  asyncHandler(async (req, res) => {
    const view = await service.overview(req.user!.id);
    ok(res, view.positions, {
      count: view.positions.length,
      unpriced: view.unpriced,
      marked: view.unpriced.length === 0,
    });
  }),
);

/**
 * Full performance report over an optional window.
 *
 * Statistics, monthly returns, equity curve and three breakdowns in one
 * response, because the performance page renders them together and four
 * round-trips would let the panels disagree with each other mid-load.
 */
portfolioRouter.get(
  '/performance',
  validate({ query: windowSchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, windowSchema);

    if (q.from !== undefined && q.to !== undefined && q.from > q.to) {
      throw new ValidationError('The window ends before it starts', [
        { path: 'to', message: 'Must be at or after `from`' },
      ]);
    }

    const report = await service.performance(req.user!.id, q.from ?? null, q.to ?? null);

    ok(res, report, {
      // Repeated at the top level because it governs how the whole page should
      // be read: below about thirty closed trades none of these statistics are
      // distinguishable from luck, and the UI dims them accordingly.
      sufficientSample: report.stats.totalTrades >= 30,
    });
  }),
);

/**
 * Daily equity curve from stored snapshots.
 *
 * Distinct from the curve inside `/performance`, which is derived from trades and
 * therefore has no points on flat days. This one is what the dashboard chart
 * uses.
 */
const historyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(365),
});

portfolioRouter.get(
  '/equity',
  validate({ query: historyQuerySchema }),
  asyncHandler(async (req, res) => {
    const { days } = queryOf(req, historyQuerySchema);
    const curve = await service.equityHistory(req.user!.id, days);
    ok(res, curve, { count: curve.length, windowDays: days });
  }),
);

/** Distinct tags the user has applied, for the journal filter chips. */
portfolioRouter.get(
  '/tags',
  asyncHandler(async (req, res) => {
    const tags = await service.tags(req.user!.id);
    ok(res, tags, { count: tags.length });
  }),
);

/**
 * How the user actually did on trades taken from platform signals.
 *
 * The one report the platform cannot flatter itself with: it joins the signals
 * this engine produced against what the user realised from them.
 */
portfolioRouter.get(
  '/attribution',
  asyncHandler(async (req, res) => {
    const rows = await service.attribution(req.user!.id);
    ok(res, rows, { count: rows.length });
  }),
);

/* -------------------------------------------------------------------------- */
/* Trades                                                                     */
/* -------------------------------------------------------------------------- */

const tradeQuerySchema = paginationSchema.extend({
  status: z.enum(['open', 'closed', 'cancelled']).optional(),
  symbol: z.string().trim().toUpperCase().max(32).optional(),
  side: z.enum(['long', 'short']).optional(),
  tag: z.string().trim().max(32).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
});

portfolioRouter.get(
  '/trades',
  validate({ query: tradeQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, tradeQuerySchema);

    const { items, total } = await service.list({
      userId: req.user!.id,
      status: q.status,
      symbol: q.symbol,
      side: q.side,
      tag: q.tag,
      from: q.from,
      to: q.to,
      page: q.page,
      pageSize: q.pageSize,
    });

    okPage(res, items, total, q.page, q.pageSize);
  }),
);

/**
 * Record an opened position.
 *
 * The schema already rejects a stop on the winning side of entry, which is the
 * mistake that silently inverts every R multiple derived from the trade.
 *
 * Note what this endpoint does *not* do: it does not check the user's risk
 * limits. Journalling is a record of what happened, and a journal that refuses
 * to record an over-sized trade produces a track record that is missing exactly
 * the trades the user most needs to see. The pre-trade check lives on the risk
 * module, where it runs before the position exists.
 */
portfolioRouter.post(
  '/trades',
  validate({ body: createTradeSchema }),
  asyncHandler(async (req, res) => {
    const b = bodyOf(req, createTradeSchema);

    const trade = await service.record({
      userId: req.user!.id,
      symbol: b.symbol,
      side: b.side,
      entryPrice: b.entryPrice,
      quantity: b.quantity,
      stopLoss: b.stopLoss ?? null,
      takeProfit: b.takeProfit ?? null,
      openedAt: b.openedAt ?? null,
      signalId: b.signalId ?? null,
      notes: b.notes ?? null,
      tags: b.tags,
    });

    created(res, trade);
  }),
);

portfolioRouter.get(
  '/trades/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const trade = await service.find(id);

    // 404 rather than 403 when the trade belongs to someone else. Confirming
    // that an id exists but is not theirs tells a caller more than they need.
    if (!trade || trade.userId !== req.user!.id) throw new NotFoundError('Trade');

    ok(res, trade);
  }),
);

/**
 * Close a position and score it.
 *
 * A null return from the service means one of three things — no such trade, not
 * this user's, or already closed — and all three are reported as 404. The
 * already-closed case matters most: the repository's `WHERE status = 'open'`
 * makes a double-submit a no-op rather than letting a second exit price
 * overwrite a recorded result.
 */
portfolioRouter.patch(
  '/trades/:id/close',
  validate({ params: idParamSchema, body: closeTradeSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const b = bodyOf(req, closeTradeSchema);

    const trade = await service.close(id, req.user!.id, {
      exitPrice: b.exitPrice,
      closedAt: b.closedAt ?? null,
      fees: b.fees,
      notes: b.notes ?? null,
      executionRating: b.executionRating ?? null,
    });

    if (!trade) throw new NotFoundError('Open trade');
    ok(res, trade);
  }),
);

/**
 * Amend management levels and journal fields.
 *
 * Entry price, quantity, side and the risk captured at entry are not amendable —
 * see `repository.updateTrade`. An empty body is rejected rather than treated as
 * a no-op, because it is far more often a client that failed to serialise its
 * form than a deliberate request to change nothing.
 */
portfolioRouter.patch(
  '/trades/:id',
  validate({ params: idParamSchema, body: updateTradeSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const b = bodyOf(req, updateTradeSchema);

    if (Object.keys(b).length === 0) {
      throw new ValidationError('No fields to update', [
        { path: 'body', message: 'Provide at least one field' },
      ]);
    }

    const trade = await service.amend(id, req.user!.id, b);
    if (!trade) throw new NotFoundError('Trade');
    ok(res, trade);
  }),
);

/** Cancel an unfilled position. Legal only while open, and never scored. */
portfolioRouter.patch(
  '/trades/:id/cancel',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const trade = await service.cancel(id, req.user!.id);
    if (!trade) throw new NotFoundError('Open trade');
    ok(res, trade);
  }),
);

/**
 * Delete a journal entry outright.
 *
 * Kept available because a mistyped trade is a real thing that happens and a
 * journal nobody can correct stops being used. It is a hard delete: a
 * soft-deleted trade would have to be excluded from every statistic in
 * `stats.ts`, and one forgotten filter would put a phantom loss in the user's
 * expectancy forever.
 */
portfolioRouter.delete(
  '/trades/:id',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);
    const removed = await service.remove(id, req.user!.id);
    if (!removed) throw new NotFoundError('Trade');
    ok(res, { id, deleted: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Force today's equity snapshot for the calling user.
 *
 * The scheduled mark owns this normally. Exposed so a user who has just entered
 * their opening balance sees a curve immediately rather than tomorrow, and so
 * support can repair a gap after downtime. Idempotent per day.
 */
portfolioRouter.post(
  '/snapshot',
  rateLimit({ bucket: 'portfolio:snapshot', max: 10 }),
  asyncHandler(async (req, res) => {
    const summary = await service.markToMarket(req.user!.id);
    ok(res, summary);
  }),
);
