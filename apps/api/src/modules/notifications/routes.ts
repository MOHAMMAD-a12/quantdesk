/**
 * Notification endpoints.
 *
 * The feed, the read state, and browser push registration. Everything is scoped
 * to `req.user.id`; there is no route that reads another user's notifications,
 * admins included — the feed contains the trades someone is being alerted about,
 * which is as private as the journal itself.
 *
 * `GET /` returns suppressed rows alongside delivered ones. That is deliberate:
 * the answer to "why didn't I get an alert" is a row saying *quiet hours* or
 * *below your threshold*, and hiding those rows would leave the user with nothing
 * to reason about. The unread badge, by contrast, counts only what was actually
 * sent — a badge that lights up for a suppressed notification would defeat the
 * point of having suppressed it.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  notificationChannelSchema,
  paginationSchema,
  pushSubscriptionSchema,
} from '@quantdesk/shared';
import { ok, okPage } from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { asyncHandler } from '../../middleware/error.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { body as bodyOf, paramsOf, queryOf, validate } from '../../middleware/validate.js';
import { config } from '../../core/config.js';
import { authenticate } from '../auth/middleware.js';
import * as repo from './repository.js';
import { dispatch } from './service.js';
import { transportStatus } from './transports.js';
import * as preferences from '../preferences/repository.js';

export const notificationsRouter = Router();

notificationsRouter.use(authenticate, rateLimit({ bucket: 'notifications' }));

/**
 * `z.coerce.boolean()` is not used here on purpose: it is JavaScript truthiness,
 * so the string `"false"` coerces to `true` and `?unreadOnly=false` would filter
 * to unread only — the exact opposite of what it says.
 */
const boolParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const listQuerySchema = paginationSchema.extend({
  kind: z.enum(['signal', 'price_alert', 'news', 'risk_breach', 'drawdown', 'system']).optional(),
  status: z.enum(['queued', 'sent', 'failed', 'suppressed']).optional(),
  channel: notificationChannelSchema.optional(),
  unreadOnly: boolParam.optional(),
});

notificationsRouter.get(
  '/',
  validate({ query: listQuerySchema }),
  asyncHandler(async (req, res) => {
    const q = queryOf(req, listQuerySchema);

    const { items, total } = await repo.list({
      userId: req.user!.id,
      kind: q.kind,
      status: q.status,
      channel: q.channel,
      unreadOnly: q.unreadOnly,
      page: q.page,
      pageSize: q.pageSize,
    });

    okPage(res, items, total, q.page, q.pageSize);
  }),
);

/**
 * The badge count.
 *
 * Its own endpoint rather than a field on the list response, because the header
 * polls it on every page and a full page of rows is a hundred times the payload
 * for one number.
 */
notificationsRouter.get(
  '/unread-count',
  asyncHandler(async (req, res) => {
    ok(res, { count: await repo.unreadCount(req.user!.id) });
  }),
);

const idParamSchema = z.object({ id: z.string().uuid() });

notificationsRouter.patch(
  '/:id/read',
  validate({ params: idParamSchema }),
  asyncHandler(async (req, res) => {
    const { id } = paramsOf(req, idParamSchema);

    // Scoped inside the UPDATE, so a notification belonging to someone else is
    // indistinguishable from one that does not exist — which is the correct
    // amount of information to give.
    const changed = await repo.markRead(id, req.user!.id);
    if (!changed) throw new NotFoundError('Notification');

    ok(res, { id, read: true });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    ok(res, { marked: await repo.markAllRead(req.user!.id) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Web push                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The VAPID public key the browser needs to build a subscription.
 *
 * Public by construction — it is the key the push service uses to verify our
 * signatures, and it is meant to be handed to every client. Returned as null
 * rather than a 404 when push is unconfigured, so the front end can hide the
 * toggle instead of showing an error for a feature the operator never enabled.
 */
notificationsRouter.get(
  '/push/key',
  asyncHandler(async (_req, res) => {
    ok(res, { publicKey: config.notifications.vapid.publicKey || null });
  }),
);

notificationsRouter.post(
  '/push/subscribe',
  validate({ body: pushSubscriptionSchema }),
  asyncHandler(async (req, res) => {
    const subscription = bodyOf(req, pushSubscriptionSchema);

    const saved = await repo.saveSubscription({
      userId: req.user!.id,
      endpoint: subscription.endpoint,
      p256dh: subscription.keys.p256dh,
      auth: subscription.keys.auth,
      userAgent: req.get('user-agent') ?? null,
    });

    // Registering a device is a statement of intent — the user just clicked
    // "allow" — so the channel is switched on with it. Leaving them to find a
    // second toggle afterwards is how push ends up permanently granted and
    // permanently silent.
    const current = await preferences.get(req.user!.id);
    if (!current.channels.webPush.enabled) {
      await preferences.update(req.user!.id, { channels: { webPush: { enabled: true } } });
    }

    ok(res, { id: saved.id, enabled: true });
  }),
);

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1024) });

/**
 * Remove one device.
 *
 * The endpoint identifies the subscription and is unguessable, so it is not
 * additionally scoped to the caller: a browser that has just been told its
 * subscription expired needs to clear the row, and it may no longer be the row's
 * owner if the machine changed hands.
 */
notificationsRouter.delete(
  '/push/subscribe',
  validate({ body: unsubscribeSchema }),
  asyncHandler(async (req, res) => {
    const { endpoint } = bodyOf(req, unsubscribeSchema);
    ok(res, { removed: await repo.deleteSubscription(endpoint) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Send the caller a test notification on every channel they have enabled.
 *
 * The only way to distinguish "configured correctly" from "configured
 * plausibly". It goes through the same `dispatch` as a real alert — a test that
 * used a shortcut would validate the shortcut — with quiet hours ignored,
 * because a test the user asked for at 3am should still arrive at 3am.
 *
 * Rate-limited hard: this is an authenticated endpoint that causes outbound
 * email, and an unthrottled one is a spam relay with extra steps.
 */
notificationsRouter.post(
  '/test',
  rateLimit({ bucket: 'notifications:test', max: 5, windowMs: 60 * 60 * 1000 }),
  asyncHandler(async (req, res) => {
    const prefs = await preferences.get(req.user!.id);

    const result = await dispatch(
      prefs,
      {
        kind: 'system',
        title: 'Test notification',
        body: 'If you are reading this, this channel is configured correctly.',
        path: '/settings/notifications',
        severity: 'info',
        signalId: null,
      },
      { ignoreQuietHours: true },
    );

    // The platform-level transport status travels with the result: a user whose
    // Telegram is "enabled" but whose operator never set a bot token needs to
    // see that the channel cannot work at all, not just that this one send was
    // suppressed.
    ok(res, { ...result, transports: transportStatus() });
  }),
);
