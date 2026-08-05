/**
 * Notification history and push subscriptions.
 *
 * **Suppressed notifications are stored, not discarded.** A signal that cleared
 * the engine's threshold but not the user's, or that arrived during quiet hours,
 * still gets a row — with `status = 'suppressed'` and a reason. Two things
 * depend on it: the user can see what was filtered and adjust their thresholds
 * from evidence rather than guesswork, and support can answer "why didn't I get
 * an alert" by reading one row instead of reconstructing a fan-out.
 */

import type {
  NotificationChannel,
  NotificationKind,
  NotificationRecord,
  NotificationStatus,
} from '@quantdesk/shared';
import { buildWhere, query, queryOne } from '../../db/pool.js';
import { toEpoch, toEpochRequired } from '../../db/rows.js';

type NotificationRow = {
  id: string;
  user_id: string;
  channel: NotificationChannel;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  signal_id: string | null;
  status: NotificationStatus;
  suppression_reason: string | null;
  error: string | null;
  read_at: Date | null;
  created_at: Date;
  sent_at: Date | null;
};

const COLUMNS = `
  id, user_id, channel, kind, title, body, link, signal_id,
  status, suppression_reason, error, read_at, created_at, sent_at
`;

function mapNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    userId: row.user_id,
    channel: row.channel,
    kind: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    signalId: row.signal_id,
    status: row.status,
    suppressionReason: row.suppression_reason,
    error: row.error,
    readAt: toEpoch(row.read_at),
    createdAt: toEpochRequired(row.created_at),
    sentAt: toEpoch(row.sent_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface RecordInput {
  userId: string;
  channel: NotificationChannel;
  kind: NotificationKind;
  title: string;
  body: string;
  link: string | null;
  signalId: string | null;
  status: NotificationStatus;
  suppressionReason: string | null;
  error: string | null;
}

/**
 * Write one delivery attempt.
 *
 * `sent_at` is set in the same statement when the status is `sent`, so a
 * delivered notification can never exist without a timestamp — the field the
 * whole "did this actually go out" question rests on.
 */
export async function insert(input: RecordInput): Promise<NotificationRecord> {
  const row = await queryOne<NotificationRow>(
    `INSERT INTO notifications (
       user_id, channel, kind, title, body, link, signal_id,
       status, suppression_reason, error, sent_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       CASE WHEN $8 = 'sent' THEN now() ELSE NULL END
     )
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      input.channel,
      input.kind,
      input.title,
      input.body,
      input.link,
      input.signalId,
      input.status,
      input.suppressionReason,
      input.error,
    ],
  );

  if (!row) throw new Error('Failed to record notification');
  return mapNotification(row);
}

/** Insert many attempts in one round-trip. Used by the fan-out. */
export async function insertMany(inputs: RecordInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  // Built as a single multi-row VALUES rather than a loop: a scan that alerts
  // two hundred watchers across four channels is eight hundred inserts, and
  // eight hundred round-trips is a visible stall on the scheduler.
  const params: unknown[] = [];
  const tuples = inputs.map((input) => {
    const base = params.length;
    params.push(
      input.userId,
      input.channel,
      input.kind,
      input.title,
      input.body,
      input.link,
      input.signalId,
      input.status,
      input.suppressionReason,
      input.error,
    );
    const p = (offset: number): string => `$${base + offset}`;
    return `(${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)},
             CASE WHEN ${p(8)} = 'sent' THEN now() ELSE NULL END)`;
  });

  const rows = await query<{ id: string }>(
    `INSERT INTO notifications (
       user_id, channel, kind, title, body, link, signal_id,
       status, suppression_reason, error, sent_at
     ) VALUES ${tuples.join(', ')}
     RETURNING id`,
    params,
  );

  return rows.length;
}

/** Mark one notification read. Scoped to the owner inside the statement. */
export async function markRead(id: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET read_at = COALESCE(read_at, now())
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

/** Mark everything read. Returns how many rows actually changed. */
export async function markAllRead(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET read_at = now()
     WHERE user_id = $1 AND read_at IS NULL
     RETURNING id`,
    [userId],
  );
  return rows.length;
}

/**
 * Delete notifications older than a cutoff.
 *
 * Housekeeping for the scheduler. The history is a diagnostic aid, not a
 * permanent record, and an unbounded table of every alert the platform ever
 * considered sending is the fastest-growing thing in the database.
 */
export async function pruneOlderThan(cutoff: Date): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM notifications WHERE created_at < $1 RETURNING id`,
    [cutoff],
  );
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface NotificationFilter {
  userId: string;
  kind?: NotificationKind | undefined;
  status?: NotificationStatus | undefined;
  channel?: NotificationChannel | undefined;
  unreadOnly?: boolean | undefined;
  page: number;
  pageSize: number;
}

export async function list(
  filter: NotificationFilter,
): Promise<{ items: NotificationRecord[]; total: number }> {
  const { clause, params, nextIndex } = buildWhere([
    { sql: 'user_id = ??', value: filter.userId },
    filter.kind ? { sql: 'kind = ??', value: filter.kind } : null,
    filter.status ? { sql: 'status = ??', value: filter.status } : null,
    filter.channel ? { sql: 'channel = ??', value: filter.channel } : null,
    // `buildWhere` substitutes exactly one `??` per condition, so the flag is
    // bound and tested in SQL rather than switching the fragment: when it is
    // false the disjunction is trivially true and every row passes.
    { sql: '(NOT ??::boolean OR read_at IS NULL)', value: filter.unreadOnly ?? false },
  ]);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications ${clause}`,
    params,
  );

  const rows = await query<NotificationRow>(
    `SELECT ${COLUMNS} FROM notifications ${clause}
     ORDER BY created_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );

  return { items: rows.map(mapNotification), total: Number(countRow?.count ?? 0) };
}

export async function unreadCount(userId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM notifications
     WHERE user_id = $1 AND read_at IS NULL AND status <> 'suppressed'`,
    [userId],
  );
  return Number(row?.count ?? 0);
}

/**
 * Whether this user has already been told about this signal on this channel.
 *
 * The duplicate guard. The scanner is idempotent by design and may re-evaluate
 * the same signal after a restart; without this check a crash loop turns into a
 * notification storm, which is the one failure mode that makes people uninstall.
 */
export async function alreadyNotified(
  userId: string,
  signalId: string,
  channel: NotificationChannel,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM notifications
     WHERE user_id = $1 AND signal_id = $2 AND channel = $3
     LIMIT 1`,
    [userId, signalId, channel],
  );
  return row !== null;
}

/* -------------------------------------------------------------------------- */
/* Push subscriptions                                                         */
/* -------------------------------------------------------------------------- */

export interface PushSubscription {
  id: string;
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

type PushRow = {
  id: string;
  user_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Register a browser push subscription.
 *
 * Upserted on `endpoint`, which the push service guarantees unique. A user who
 * re-grants permission in the same browser gets the same endpoint back, and
 * inserting it again would give them duplicate notifications for every alert.
 *
 * The conflict target updates `user_id`: an endpoint belongs to a browser
 * profile, and if two people share a machine the subscription must follow
 * whoever most recently signed in, not keep pushing the first user's trades to
 * the second user's screen.
 */
export async function saveSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}): Promise<PushSubscription> {
  const row = await queryOne<PushRow>(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       p256dh  = EXCLUDED.p256dh,
       auth    = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent
     RETURNING id, user_id, endpoint, p256dh, auth`,
    [input.userId, input.endpoint, input.p256dh, input.auth, input.userAgent],
  );

  if (!row) throw new Error('Failed to save push subscription');
  return { id: row.id, userId: row.user_id, endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
}

export async function subscriptionsFor(userId: string): Promise<PushSubscription[]> {
  const rows = await query<PushRow>(
    `SELECT id, user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    p256dh: r.p256dh,
    auth: r.auth,
  }));
}

/**
 * Remove a subscription.
 *
 * Called both when a user unsubscribes and when a push service reports the
 * endpoint as gone. Not scoped to a user id in the second case, because the
 * endpoint is the identity — a 410 means that endpoint is dead for everyone.
 */
export async function deleteSubscription(endpoint: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM push_subscriptions WHERE endpoint = $1 RETURNING id`,
    [endpoint],
  );
  return rows.length > 0;
}
