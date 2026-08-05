/**
 * User preference endpoints.
 *
 * Small module, one important property: these settings govern how much of the
 * user's money the platform's own tools will put at risk, and which addresses it
 * may send messages to. Both halves are validated by the shared schema before
 * they reach the repository, and the notification channels are re-narrowed
 * field-by-field on read — see `repository.channelsFrom`.
 *
 * Users edit their own preferences and nobody else's. There is no admin override
 * here by design: an operator who could raise someone's risk limits without a
 * trace is a liability, and an operator who needs to help a user change a setting
 * can walk them through it.
 */

import { Router } from 'express';
import { z } from 'zod';
import { updatePreferencesSchema } from '@quantdesk/shared';
import { ok } from '../../core/http.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, validate } from '../../middleware/validate.js';
import { ValidationError } from '../../core/errors.js';
import { authenticate } from '../auth/middleware.js';
import { findSymbol } from '../markets/index.js';
import * as repo from './repository.js';

export const preferencesRouter = Router();

preferencesRouter.use(authenticate, rateLimit({ bucket: 'preferences' }));

preferencesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    ok(res, await repo.get(req.user!.id));
  }),
);

/**
 * Apply a partial update.
 *
 * An empty body is rejected rather than treated as a no-op: it is far more often
 * a client that failed to serialise its form than a deliberate request to change
 * nothing, and returning 200 for it hides the bug.
 *
 * The cross-field checks below are the ones a per-field schema cannot express.
 * A daily limit above the weekly one is not invalid in isolation — each number
 * is a legal percentage — but together they describe a limit that can never
 * bind, and silently storing it would give the user a risk framework that does
 * nothing while appearing to work.
 */
preferencesRouter.patch(
  '/',
  validate({ body: updatePreferencesSchema }),
  asyncHandler(async (req, res) => {
    const patch = bodyOf(req, updatePreferencesSchema);

    if (Object.keys(patch).length === 0) {
      throw new ValidationError('No fields to update', [
        { path: 'body', message: 'Provide at least one field' },
      ]);
    }

    const current = await repo.get(req.user!.id);

    const perTrade = patch.riskPerTradePercent ?? current.riskPerTradePercent;
    const daily = patch.maxDailyRiskPercent ?? current.maxDailyRiskPercent;
    const weekly = patch.maxWeeklyRiskPercent ?? current.maxWeeklyRiskPercent;

    const problems: Array<{ path: string; message: string }> = [];

    if (perTrade > daily) {
      problems.push({
        path: 'riskPerTradePercent',
        message: 'Per-trade risk cannot exceed the daily limit — the first trade would breach it.',
      });
    }
    if (daily > weekly) {
      problems.push({
        path: 'maxDailyRiskPercent',
        message: 'The daily limit cannot exceed the weekly limit.',
      });
    }

    // A channel enabled without a destination is the failure that produces
    // "why am I not getting alerts" tickets: the setting saves, the toggle looks
    // on, and every send silently drops.
    const channels = patch.channels;
    if (channels?.email?.enabled && !(channels.email.address ?? current.channels.email.address)) {
      problems.push({ path: 'channels.email.address', message: 'Add an address to enable email.' });
    }
    if (channels?.telegram?.enabled && !(channels.telegram.chatId ?? current.channels.telegram.chatId)) {
      problems.push({
        path: 'channels.telegram.chatId',
        message: 'Connect Telegram before enabling it.',
      });
    }
    if (channels?.discord?.enabled && !(channels.discord.webhookUrl ?? current.channels.discord.webhookUrl)) {
      problems.push({
        path: 'channels.discord.webhookUrl',
        message: 'Add a webhook URL to enable Discord.',
      });
    }

    if (problems.length > 0) throw new ValidationError('These settings conflict', problems);

    const updated = await repo.update(req.user!.id, patch);
    ok(res, updated);
  }),
);

/* -------------------------------------------------------------------------- */
/* Watchlist                                                                  */
/* -------------------------------------------------------------------------- */

const symbolParamSchema = z.object({
  symbol: z.string().trim().toUpperCase().min(1).max(32),
});

/**
 * Add one symbol to the watchlist.
 *
 * Separate from the bulk `PATCH /` because the dashboard's star button is a
 * single-symbol action, and making it send the whole array back turns every
 * concurrent tab into a last-write-wins race that silently unstars things.
 *
 * The symbol is checked against the tradable universe first: an unknown entry
 * would sit in the watchlist producing no quotes, no signals and no explanation.
 */
preferencesRouter.put(
  '/watchlist/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);

    const known = await findSymbol(symbol);
    if (!known) {
      throw new ValidationError('That symbol is not tradable on this platform', [
        { path: 'symbol', message: `Unknown symbol: ${symbol}` },
      ]);
    }

    const current = await repo.get(req.user!.id);
    if (current.watchlist.includes(known.symbol)) {
      ok(res, current, { added: false });
      return;
    }

    const updated = await repo.update(req.user!.id, {
      watchlist: [...current.watchlist, known.symbol],
    });

    ok(res, updated, { added: true });
  }),
);

preferencesRouter.delete(
  '/watchlist/:symbol',
  validate({ params: symbolParamSchema }),
  asyncHandler(async (req, res) => {
    const { symbol } = paramsOf(req, symbolParamSchema);

    const current = await repo.get(req.user!.id);
    const next = current.watchlist.filter((s) => s !== symbol);

    if (next.length === current.watchlist.length) {
      ok(res, current, { removed: false });
      return;
    }

    ok(res, await repo.update(req.user!.id, { watchlist: next }), { removed: true });
  }),
);
