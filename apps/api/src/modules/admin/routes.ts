/**
 * Admin endpoints.
 *
 * One router, one guard: `requireAdmin` is applied to the whole tree at the top
 * rather than per route, because the failure mode of per-route guards is a new
 * endpoint added six months from now without one, and nothing about it looks
 * wrong in review.
 *
 * **Every mutation writes an audit row.** Not as a formality — the audit log is
 * what makes operator access defensible. An operator who changes someone's role,
 * disables a market, or lowers the platform's confidence floor leaves a record
 * with their email on it. `recordAudit` never throws, so a logging failure cannot
 * block the operation, but it also means the log is best-effort by construction;
 * that trade-off is documented in `core/audit.ts` and accepted here.
 *
 * What is deliberately absent: no route reads another user's trades, journal,
 * portfolio or notification feed. Running the platform requires knowing that an
 * account exists and what plan it is on, not what it trades.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  adminListUsersSchema,
  adminUpdateUserSchema,
  auditLogQuerySchema,
  updateAiSettingsSchema,
  updateSignalConfigSchema,
  upsertMarketSchema,
} from '@quantdesk/shared';
import { AUDIT_ACTIONS, auditRequest } from '../../core/audit.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { created, ok, okPage } from '../../core/http.js';
import { verifyMailer } from '../../core/mailer.js';
import { pingDatabase } from '../../db/pool.js';
import { pingRedis } from '../../db/redis.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { aiRegistry } from '../../providers/ai/registry.js';
import { marketRegistry } from '../../providers/market/registry.js';
import { runJobNow, schedulerStatus } from '../../scheduler.js';
import { wsStats } from '../../ws/index.js';
import { authenticate, requireAdmin } from '../auth/middleware.js';
import { findUserById } from '../auth/repository.js';
import { transportStatus } from '../notifications/index.js';
import {
  invalidateSymbolCache,
  listSymbols,
  toPublicSymbol,
  updateSymbol,
} from '../markets/index.js';
import {
  getAiSettings,
  getSignalEngineConfig,
  invalidateSettingsCache,
  updateAiSettings,
  updateSignalEngineConfig,
} from '../settings/index.js';
import { accuracy as signalAccuracy, performance as signalPerformance } from '../signals/index.js';
import * as repo from './repository.js';

export const adminRouter = Router();

adminRouter.use(authenticate, requireAdmin, rateLimit({ bucket: 'admin' }));

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    ok(res, await repo.platformStats());
  }),
);

const activityQuerySchema = z.object({
  days: z.coerce.number().int().min(7).max(365).default(30),
});

adminRouter.get(
  '/activity',
  validate({ query: activityQuerySchema }),
  asyncHandler(async (req, res) => {
    const { days } = queryOf(req, activityQuerySchema);
    ok(res, await repo.activitySeries(days));
  }),
);

/**
 * Dependency health.
 *
 * Every check runs even when an earlier one fails, and each reports
 * independently. A health page that short-circuits on the first failure tells the
 * operator that Postgres is down and nothing about whether Redis came back — and
 * during an incident the second question is usually the one being asked.
 *
 * Not the liveness probe. That lives on `/health` in `app.ts`, is unauthenticated
 * and checks nothing external, because an orchestrator must not restart the API
 * because a market data vendor is having a bad afternoon.
 */
adminRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const [database, redis, markets, ai, smtp] = await Promise.all([
      pingDatabase().catch(() => false),
      pingRedis().catch(() => false),
      marketRegistry.healthReport().catch(() => []),
      aiRegistry.statusReport().catch(() => []),
      verifyMailer().catch(() => false),
    ]);

    ok(res, {
      database,
      redis,
      smtp,
      markets,
      ai,
      notifications: transportStatus(),
      websocket: wsStats(),
      scheduler: schedulerStatus(),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Background jobs                                                            */
/* -------------------------------------------------------------------------- */

const jobParamSchema = z.object({
  name: z.string().trim().min(1).max(48),
});

/**
 * Trigger a background job by hand.
 *
 * Returns as soon as the job is *dispatched*, not when it finishes: a universe
 * scan runs for minutes, and holding the HTTP request open for it would time out
 * at every proxy between here and the operator's browser. The result lands in the
 * logs and — for a scan — in the signals feed.
 *
 * The job still takes its distributed lock and still refuses to overlap itself, so
 * an operator hammering this button cannot produce the duplicate work the
 * scheduler exists to prevent. That is why this endpoint calls into the scheduler
 * rather than invoking the underlying service directly.
 */
adminRouter.post(
  '/jobs/:name/run',
  validate({ params: jobParamSchema }),
  asyncHandler(async (req, res) => {
    const { name } = paramsOf(req, jobParamSchema);
    const actor = req.user!;

    const known = schedulerStatus().jobs.some((job) => job.name === name);
    if (!known) throw new NotFoundError('Job');

    void runJobNow(name);

    await auditRequest(req, {
      action: 'job.triggered',
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'job',
      resourceId: name,
    });

    ok(res, { job: name, dispatched: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/users',
  validate({ query: adminListUsersSchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, adminListUsersSchema);

    const { items, total } = await repo.listUsers({
      search: q.search,
      role: q.role,
      isActive: q.isActive,
      page: q.page,
      pageSize: q.pageSize,
    });

    okPage(res, items, total, q.page, q.pageSize);
  }),
);

const userIdParamSchema = z.object({ id: z.string().uuid() });

adminRouter.get(
  '/users/:id',
  validate({ params: userIdParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, userIdParamSchema);
    const user = await findUserById(id);
    if (!user) throw new NotFoundError('User');
    ok(res, user);
  }),
);

/**
 * Change a user's role or status.
 *
 * Two self-protections, both about the same failure: an operator locking
 * themselves — or everyone — out.
 *
 *   1. You cannot demote or deactivate your own account. The mistake is easy to
 *      make on a user list and impossible to undo without database access.
 *   2. You cannot remove the last admin. A platform with no administrator has no
 *      path back to having one short of a manual SQL statement, which during an
 *      incident is exactly when nobody has the credentials to run it.
 */
adminRouter.patch(
  '/users/:id',
  validate({ params: userIdParamSchema, body: adminUpdateUserSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, userIdParamSchema);
    const patch = bodyOf(req, adminUpdateUserSchema);
    const actor = req.user!;

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No fields to update', [
        { path: 'body', message: 'Provide at least one field' },
      ]);
    }

    const target = await findUserById(id);
    if (!target) throw new NotFoundError('User');

    const losingAdmin =
      target.role === 'admin' && (patch.role !== undefined && patch.role !== 'admin');
    const beingDisabled = patch.isActive === false;

    if (id === actor.id && (losingAdmin || beingDisabled)) {
      throw new ConflictError('You cannot remove your own administrator access');
    }

    if (losingAdmin || (beingDisabled && target.role === 'admin')) {
      const { total } = await repo.listUsers({ role: 'admin', isActive: true, page: 1, pageSize: 1 });
      if (total <= 1) {
        throw new ConflictError('This is the last active administrator — promote another first');
      }
    }

    const updated = await repo.updateUser(id, patch);
    if (!updated) throw new NotFoundError('User');

    // Recorded field-by-field so the log answers "what changed", not merely
    // "someone edited this account".
    if (patch.role !== undefined && patch.role !== target.role) {
      await auditRequest(req, {
        action: AUDIT_ACTIONS.userRoleChanged,
        userId: actor.id,
        actorEmail: actor.email,
        resourceType: 'user',
        resourceId: id,
        metadata: { from: target.role, to: patch.role },
      });
    }
    if (patch.isActive !== undefined && patch.isActive !== target.isActive) {
      await auditRequest(req, {
        action: patch.isActive ? AUDIT_ACTIONS.userActivated : AUDIT_ACTIONS.userDeactivated,
        userId: actor.id,
        actorEmail: actor.email,
        resourceType: 'user',
        resourceId: id,
      });
    }

    ok(res, updated);
  }),
);

/* -------------------------------------------------------------------------- */
/* Platform settings                                                          */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/settings/signals',
  asyncHandler(async (_req, res) => {
    ok(res, await getSignalEngineConfig());
  }),
);

adminRouter.patch(
  '/settings/signals',
  validate({ body: updateSignalConfigSchema }),
  asyncHandler(async (req, res) => {
    const patch = bodyOf(req, updateSignalConfigSchema);
    const actor = req.user!;

    const updated = await updateSignalEngineConfig(patch, actor.id);

    await auditRequest(req, {
      action: AUDIT_ACTIONS.settingsUpdated,
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'settings',
      resourceId: 'signal_engine',
      metadata: { patch },
    });

    ok(res, updated);
  }),
);

adminRouter.get(
  '/settings/ai',
  asyncHandler(async (_req, res) => {
    ok(res, await getAiSettings());
  }),
);

/**
 * Switch AI provider or model at runtime.
 *
 * The registry's cached settings are dropped immediately after the write. Without
 * that, an operator switching provider during an outage would watch requests keep
 * going to the dead one for the length of the cache TTL and reasonably conclude
 * the setting does not work.
 *
 * No API keys pass through here. Credentials live in the environment and in
 * `provider_credentials`; a settings endpoint that accepted them would put a
 * secret in an audit row and a request log.
 */
adminRouter.patch(
  '/settings/ai',
  validate({ body: updateAiSettingsSchema }),
  asyncHandler(async (req, res) => {
    const patch = bodyOf(req, updateAiSettingsSchema);
    const actor = req.user!;

    const updated = await updateAiSettings(patch, actor.id);
    aiRegistry.invalidateSettings();

    await auditRequest(req, {
      action: AUDIT_ACTIONS.settingsUpdated,
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'settings',
      resourceId: 'ai_settings',
      metadata: { patch },
    });

    ok(res, updated);
  }),
);

/* -------------------------------------------------------------------------- */
/* AI providers                                                               */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/ai/providers',
  asyncHandler(async (_req, res) => {
    ok(res, await aiRegistry.statusReport());
  }),
);

const usageQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(720).default(24),
});

adminRouter.get(
  '/ai/usage',
  validate({ query: usageQuerySchema }),
  asyncHandler(async (req, res) => {
    const { hours } = queryOf(req, usageQuerySchema);
    ok(res, await repo.aiUsage(hours), { hours });
  }),
);

/* -------------------------------------------------------------------------- */
/* Markets                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The full universe including operator-only fields.
 *
 * Distinct from the public `GET /markets`, which returns only what a chart needs.
 * `scanEnabled` and `preferredProvider` are operational settings, and exposing
 * them publicly would tell anyone which venues the platform depends on.
 */
adminRouter.get(
  '/markets',
  asyncHandler(async (_req, res) => {
    ok(res, await listSymbols());
  }),
);

adminRouter.post(
  '/markets',
  validate({ body: upsertMarketSchema }),
  asyncHandler(async (req, res) => {
    const input = bodyOf(req, upsertMarketSchema);
    const actor = req.user!;

    await repo.upsertSymbol(input);
    await invalidateSymbolCache();

    await auditRequest(req, {
      action: 'market.upserted',
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'market_symbol',
      resourceId: input.symbol,
      metadata: { assetClass: input.assetClass, scanEnabled: input.scanEnabled },
    });

    created(res, input);
  }),
);

const symbolParamSchema = z.object({
  symbol: z.string().trim().toUpperCase().min(1).max(32),
});

const patchMarketSchema = z.object({
  name: z.string().trim().min(1).max(96).optional(),
  scanEnabled: z.boolean().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  preferredProvider: z.string().trim().max(32).nullable().optional(),
  pricePrecision: z.number().int().min(0).max(12).optional(),
  tickSize: z.number().positive().optional(),
  tradingViewSymbol: z.string().trim().min(1).max(64).optional(),
});

adminRouter.patch(
  '/markets/:symbol',
  validate({ params: symbolParamSchema, body: patchMarketSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const patch = bodyOf(req, patchMarketSchema);
    const actor = req.user!;

    const updated = await updateSymbol(symbol, patch);
    if (!updated) throw new NotFoundError('Symbol');

    await auditRequest(req, {
      action: 'market.updated',
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'market_symbol',
      resourceId: symbol,
      metadata: { patch },
    });

    ok(res, toPublicSymbol(updated));
  }),
);

/**
 * Delete an instrument.
 *
 * Requires `?confirm=true`. The FK from `signals` cascades, so this also erases
 * every call the platform ever made on that symbol — the track record an operator
 * would need if the decision is ever questioned. Turning off `scanEnabled` stops
 * the scanning without destroying the history, and is what the operator almost
 * always means; the confirmation exists to make them say otherwise out loud.
 */
const confirmQuerySchema = z.object({
  confirm: z.enum(['true', 'false']).default('false'),
});

adminRouter.delete(
  '/markets/:symbol',
  validate({ params: symbolParamSchema, query: confirmQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);
    const { confirm } = queryOf(req, confirmQuerySchema);
    const actor = req.user!;

    if (confirm !== 'true') {
      throw new ValidationError('Deleting a symbol also deletes its signal history', [
        {
          path: 'confirm',
          message: 'Pass ?confirm=true to proceed, or disable scanning instead.',
        },
      ]);
    }

    const deleted = await repo.deleteSymbol(symbol);
    if (!deleted) throw new NotFoundError('Symbol');

    await invalidateSymbolCache();

    await auditRequest(req, {
      action: 'market.deleted',
      userId: actor.id,
      actorEmail: actor.email,
      resourceType: 'market_symbol',
      resourceId: symbol,
    });

    ok(res, { symbol, deleted: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Signal quality                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How the engine has actually performed.
 *
 * The accuracy-by-confidence-band view is the one that matters: an engine whose
 * 90%-confidence calls resolve at 55% is not merely inaccurate, it is
 * *miscalibrated*, and the fix is the confidence formula rather than the
 * threshold. Publishing it to operators unprompted is the point — a platform that
 * only showed its wins would be marketing.
 */
adminRouter.get(
  '/signals/performance',
  asyncHandler(async (_req, res) => {
    const [recent, accuracy] = await Promise.all([
      signalPerformance(200),
      signalAccuracy(),
    ]);
    ok(res, { recent, accuracy });
  }),
);

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

adminRouter.get(
  '/audit',
  validate({ query: auditLogQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, auditLogQuerySchema);

    const { items, total } = await repo.listAudit({
      action: q.action,
      userId: q.userId,
      from: q.from,
      to: q.to,
      page: q.page,
      pageSize: q.pageSize,
    });

    okPage(res, items, total, q.page, q.pageSize);
  }),
);

adminRouter.get(
  '/audit/actions',
  asyncHandler(async (_req, res) => {
    ok(res, await repo.auditActions());
  }),
);

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Drop the settings and symbol caches.
 *
 * The escape hatch for a database restore or a manual `UPDATE` — changes made
 * outside the application do not invalidate anything, and without this the only
 * remedy is a restart.
 */
adminRouter.post(
  '/cache/invalidate',
  asyncHandler(async (req, res) => {
    await Promise.all([invalidateSettingsCache(), invalidateSymbolCache()]);
    aiRegistry.invalidateSettings();

    await auditRequest(req, {
      action: 'cache.invalidated',
      userId: req.user!.id,
      actorEmail: req.user!.email,
    });

    ok(res, { invalidated: ['settings', 'symbols', 'ai'] });
  }),
);
