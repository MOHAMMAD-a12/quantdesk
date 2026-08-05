/**
 * News, sentiment and economic-calendar endpoints.
 *
 * Reads are public. Market news is not privileged information, and gating the
 * headline feed behind a login would only push users to read it elsewhere and
 * lose the sentiment context this platform attaches to it. `optionalAuth` still
 * runs so the rate limiter can key on a user id rather than a shared NAT
 * address.
 *
 * Writes — manual ingest, manual classification — are admin-only, because both
 * spend a metered upstream budget.
 */

import { Router } from 'express';
import { calendarQuerySchema, newsQuerySchema } from '@quantdesk/shared';
import { NotFoundError } from '../../core/errors.js';
import { ok, okPage } from '../../core/http.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { queryOf, validate } from '../../middleware/validate.js';
import { optionalAuth, requireAdmin } from '../auth/middleware.js';
import * as service from './service.js';

export const newsRouter = Router();

newsRouter.use(optionalAuth, rateLimit({ bucket: 'news' }));

/** Default calendar span when the client gives no bounds: yesterday → next week. */
const CALENDAR_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const CALENDAR_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A filtered page of headlines.
 *
 * `meta.sources` travels with every page so the client can distinguish "no news
 * matched your filter" from "no news provider is configured" — two empty lists
 * that mean entirely different things, and only one of which the user can fix.
 */
newsRouter.get(
  '/',
  validate({ query: newsQuerySchema }),
  asyncHandler(async (req, res) => {
    const { symbol, sentiment, impact, hours, page, pageSize } = queryOf(req, newsQuerySchema);

    const { items, total } = await service.list({
      symbol,
      sentiment,
      impact,
      hours,
      page,
      pageSize,
    });

    res.setHeader('X-Total-Count', String(total));
    okPage(res, items, total, page, pageSize);
  }),
);

/** Whether any upstream is configured, for the empty-state banner. */
newsRouter.get(
  '/sources',
  asyncHandler(async (_req, res) => {
    ok(res, service.sourceStatus());
  }),
);

/**
 * Aggregate sentiment.
 *
 * A 204 rather than a zeroed body when nothing in the window is classified.
 * Returning `{ score: 0, sentiment: 'neutral' }` would render as genuine market
 * indecision on the dashboard, when the truth is that there is no reading at
 * all — the same distinction the confluence layer makes internally.
 */
newsRouter.get(
  '/sentiment',
  asyncHandler(async (req, res) => {
    const raw = req.query.symbol;
    const symbol = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toUpperCase() : null;

    const snapshot = await service.sentiment(symbol);
    if (!snapshot) {
      res.status(204).end();
      return;
    }
    ok(res, snapshot);
  }),
);

/**
 * The crypto Fear & Greed index.
 *
 * 204 when disabled or unreachable. Same reasoning as `/sentiment`: a fabricated
 * 50 is indistinguishable from a real neutral reading once it reaches the UI.
 */
newsRouter.get(
  '/fear-greed',
  asyncHandler(async (_req, res) => {
    const index = await service.fearGreed();
    if (!index) {
      res.status(204).end();
      return;
    }
    ok(res, index);
  }),
);

/**
 * The economic calendar.
 *
 * Bounds default to a window around now rather than being required — the common
 * case is "what is coming up", and making the client compute two epoch
 * milliseconds for that is friction with no benefit.
 */
newsRouter.get(
  '/calendar',
  validate({ query: calendarQuerySchema }),
  asyncHandler(async (req, res) => {
    const { from, to, impact, currency } = queryOf(req, calendarQuerySchema);
    const now = Date.now();

    const events = await service.calendar({
      from: from ?? now - CALENDAR_LOOKBACK_MS,
      to: to ?? now + CALENDAR_LOOKAHEAD_MS,
      impact,
      currency,
    });

    ok(res, events, { count: events.length });
  }),
);

/**
 * High-impact releases inside the next 24 hours.
 *
 * Separate from `/calendar` because it answers a different question — the
 * dashboard's "should I be flat right now" banner, not a browsable schedule.
 */
newsRouter.get(
  '/calendar/upcoming',
  asyncHandler(async (_req, res) => {
    const events = await service.upcomingHighImpact(24 * 60 * 60 * 1000);
    ok(res, events, { count: events.length });
  }),
);

/**
 * One article, with its classification.
 *
 * Registered after `/sources`, `/sentiment`, `/fear-greed` and `/calendar` so
 * those literal paths are not swallowed by the `:id` parameter.
 */
newsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'] ?? '';
    const article = await service.findArticle(id);
    if (!article) throw new NotFoundError('Article');
    ok(res, article);
  }),
);

/* -------------------------------------------------------------------------- */
/* Admin                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Force an ingest cycle.
 *
 * Admin-only and rate-limited on its own bucket: the scheduler already does this
 * on a cadence tuned to the upstreams' limits, and a refresh button wired to an
 * unbounded endpoint is how those limits get burned.
 */
newsRouter.post(
  '/ingest',
  requireAdmin,
  rateLimit({ bucket: 'news:ingest', max: 10 }),
  asyncHandler(async (_req, res) => {
    const result = await service.ingestLatest();
    ok(res, result);
  }),
);

/** Classify the backlog now rather than waiting for the scheduler. */
newsRouter.post(
  '/classify',
  requireAdmin,
  rateLimit({ bucket: 'news:classify', max: 5 }),
  asyncHandler(async (_req, res) => {
    const classified = await service.classifyPending();
    ok(res, { classified });
  }),
);
