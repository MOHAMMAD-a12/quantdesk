/**
 * Admin repository — platform-wide reads that no user-facing module should own.
 *
 * Everything here crosses user boundaries by design: counting registrations,
 * listing accounts, reading the audit log. That is exactly why it lives in one
 * file behind one router with one authorisation check, rather than as admin
 * branches scattered through the feature modules. A privileged query in a file
 * whose other twenty queries are user-scoped is a filter waiting to be dropped.
 *
 * Note what is *not* here: no function reads another user's trades, journal or
 * notification feed. Operating the platform requires knowing that an account
 * exists, what plan it is on and whether it is active — not what it trades.
 */

import type { AuditLogEntry, User, UserRole } from '@quantdesk/shared';
import { buildWhere, query, queryOne } from '../../db/pool.js';
import { toEpochRequired, toJsonObject, toNumRequired } from '../../db/rows.js';
import { mapUser } from '../auth/repository.js';

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  email_verified: boolean;
  is_active: boolean;
  avatar_url: string | null;
  timezone: string;
  created_at: Date;
  last_login_at: Date | null;
};

const USER_COLUMNS = `
  id, email, display_name, role, email_verified, is_active,
  avatar_url, timezone, created_at, last_login_at
`;

export interface UserFilter {
  search?: string | undefined;
  role?: UserRole | undefined;
  isActive?: boolean | undefined;
  page: number;
  pageSize: number;
}

/**
 * Page through accounts.
 *
 * The search matches email or display name case-insensitively. It is a `LIKE`
 * rather than a trigram or full-text index because support searches for a
 * complete address they were given in a ticket; the prefix scan is fast enough
 * at any user count this platform will see, and the alternative is an extension
 * dependency for a screen used a few times a day.
 */
export async function listUsers(
  filter: UserFilter,
): Promise<{ items: User[]; total: number }> {
  const search = filter.search ? `%${filter.search.toLowerCase()}%` : null;

  const { clause, params, nextIndex } = buildWhere([
    // One `??` per condition — `buildWhere` substitutes only the first token, so
    // the two columns are concatenated and matched once rather than OR-ed with a
    // second placeholder that would never be bound.
    search ? { sql: "(lower(email) || ' ' || lower(display_name)) LIKE ??", value: search } : null,
    filter.role ? { sql: 'role = ??', value: filter.role } : null,
    filter.isActive === undefined ? null : { sql: 'is_active = ??', value: filter.isActive },
  ]);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users ${clause}`,
    params,
  );

  const rows = await query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users ${clause}
     ORDER BY created_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );

  return { items: rows.map(mapUser), total: Number(countRow?.count ?? 0) };
}

export interface AdminUserPatch {
  role?: UserRole | undefined;
  isActive?: boolean | undefined;
  displayName?: string | undefined;
  emailVerified?: boolean | undefined;
}

/**
 * Change an account's administrative fields.
 *
 * Email and password are absent on purpose. Both are credentials: an operator
 * who can change an email address can redirect a password reset, and an operator
 * who can set a password can enter any account. Those flows exist — the user
 * initiates them — and moving them behind an admin button would make every
 * operator account a master key.
 */
export async function updateUser(id: string, patch: AdminUserPatch): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `UPDATE users SET
       role           = COALESCE($2, role),
       is_active      = COALESCE($3, is_active),
       display_name   = COALESCE($4, display_name),
       email_verified = COALESCE($5, email_verified)
     WHERE id = $1
     RETURNING ${USER_COLUMNS}`,
    [
      id,
      patch.role ?? null,
      patch.isActive ?? null,
      patch.displayName ?? null,
      patch.emailVerified ?? null,
    ],
  );

  return row ? mapUser(row) : null;
}

/* -------------------------------------------------------------------------- */
/* Audit log                                                                  */
/* -------------------------------------------------------------------------- */

type AuditRow = {
  id: string;
  user_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  metadata: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: Date;
};

export interface AuditFilter {
  action?: string | undefined;
  userId?: string | undefined;
  from?: number | undefined;
  to?: number | undefined;
  page: number;
  pageSize: number;
}

export async function listAudit(
  filter: AuditFilter,
): Promise<{ items: AuditLogEntry[]; total: number }> {
  const { clause, params, nextIndex } = buildWhere([
    filter.action ? { sql: 'action = ??', value: filter.action } : null,
    filter.userId ? { sql: 'user_id = ??', value: filter.userId } : null,
    filter.from ? { sql: 'created_at >= ??', value: new Date(filter.from) } : null,
    filter.to ? { sql: 'created_at <= ??', value: new Date(filter.to) } : null,
  ]);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM audit_log ${clause}`,
    params,
  );

  const rows = await query<AuditRow>(
    `SELECT id::text AS id, user_id, actor_email, action, resource_type, resource_id,
            metadata, host(ip_address) AS ip_address, user_agent, created_at
     FROM audit_log ${clause}
     ORDER BY created_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );

  const items = rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    actorEmail: row.actor_email,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: toJsonObject(row.metadata),
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: toEpochRequired(row.created_at),
  }));

  return { items, total: Number(countRow?.count ?? 0) };
}

/** The distinct actions present in the log, for the filter dropdown. */
export async function auditActions(): Promise<string[]> {
  const rows = await query<{ action: string }>(
    `SELECT DISTINCT action FROM audit_log ORDER BY action`,
  );
  return rows.map((r) => r.action);
}

/* -------------------------------------------------------------------------- */
/* Platform statistics                                                        */
/* -------------------------------------------------------------------------- */

export interface PlatformStats {
  users: { total: number; active: number; premium: number; admin: number; newLast7Days: number };
  signals: { total: number; last24h: number; active: number };
  trades: { open: number; closedLast30Days: number };
  images: { last24h: number };
  ai: { callsLast24h: number; failuresLast24h: number; tokensLast24h: number };
  notifications: { sentLast24h: number; failedLast24h: number; suppressedLast24h: number };
}

/**
 * The dashboard numbers, in one round-trip.
 *
 * A single statement of scalar sub-selects rather than eight queries: the admin
 * dashboard polls this, and eight round-trips per poll is eight times the
 * connection pressure for numbers that are only ever read together. Every count
 * is over an indexed predicate — see the `created_at DESC` indexes in the schema.
 */
export async function platformStats(): Promise<PlatformStats> {
  type StatsRow = {
    users_total: string;
    users_active: string;
    users_premium: string;
    users_admin: string;
    users_new_7d: string;
    signals_total: string;
    signals_24h: string;
    signals_active: string;
    trades_open: string;
    trades_closed_30d: string;
    images_24h: string;
    ai_calls_24h: string;
    ai_failures_24h: string;
    ai_tokens_24h: string;
    notif_sent_24h: string;
    notif_failed_24h: string;
    notif_suppressed_24h: string;
  };

  const row = await queryOne<StatsRow>(`
    SELECT
      (SELECT COUNT(*) FROM users)::text                                        AS users_total,
      (SELECT COUNT(*) FROM users WHERE is_active)::text                        AS users_active,
      (SELECT COUNT(*) FROM users WHERE role = 'premium')::text                 AS users_premium,
      (SELECT COUNT(*) FROM users WHERE role = 'admin')::text                   AS users_admin,
      (SELECT COUNT(*) FROM users
         WHERE created_at > now() - interval '7 days')::text                    AS users_new_7d,

      (SELECT COUNT(*) FROM signals)::text                                      AS signals_total,
      (SELECT COUNT(*) FROM signals
         WHERE created_at > now() - interval '24 hours')::text                  AS signals_24h,
      (SELECT COUNT(*) FROM signals WHERE status = 'active')::text              AS signals_active,

      (SELECT COUNT(*) FROM trades WHERE status = 'open')::text                 AS trades_open,
      (SELECT COUNT(*) FROM trades
         WHERE status = 'closed' AND closed_at > now() - interval '30 days')::text AS trades_closed_30d,

      (SELECT COUNT(*) FROM image_analyses
         WHERE created_at > now() - interval '24 hours')::text                  AS images_24h,

      (SELECT COUNT(*) FROM ai_usage
         WHERE created_at > now() - interval '24 hours')::text                  AS ai_calls_24h,
      (SELECT COUNT(*) FROM ai_usage
         WHERE NOT success AND created_at > now() - interval '24 hours')::text  AS ai_failures_24h,
      (SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) FROM ai_usage
         WHERE created_at > now() - interval '24 hours')::text                  AS ai_tokens_24h,

      (SELECT COUNT(*) FROM notifications
         WHERE status = 'sent' AND created_at > now() - interval '24 hours')::text       AS notif_sent_24h,
      (SELECT COUNT(*) FROM notifications
         WHERE status = 'failed' AND created_at > now() - interval '24 hours')::text     AS notif_failed_24h,
      (SELECT COUNT(*) FROM notifications
         WHERE status = 'suppressed' AND created_at > now() - interval '24 hours')::text AS notif_suppressed_24h
  `);

  const n = (value: string | undefined): number => toNumRequired(value ?? '0', 0);

  return {
    users: {
      total: n(row?.users_total),
      active: n(row?.users_active),
      premium: n(row?.users_premium),
      admin: n(row?.users_admin),
      newLast7Days: n(row?.users_new_7d),
    },
    signals: {
      total: n(row?.signals_total),
      last24h: n(row?.signals_24h),
      active: n(row?.signals_active),
    },
    trades: { open: n(row?.trades_open), closedLast30Days: n(row?.trades_closed_30d) },
    images: { last24h: n(row?.images_24h) },
    ai: {
      callsLast24h: n(row?.ai_calls_24h),
      failuresLast24h: n(row?.ai_failures_24h),
      tokensLast24h: n(row?.ai_tokens_24h),
    },
    notifications: {
      sentLast24h: n(row?.notif_sent_24h),
      failedLast24h: n(row?.notif_failed_24h),
      suppressedLast24h: n(row?.notif_suppressed_24h),
    },
  };
}

/** Daily registration and signal counts, for the dashboard's sparklines. */
export async function activitySeries(days = 30): Promise<
  Array<{ date: string; users: number; signals: number; trades: number }>
> {
  type SeriesRow = { day: string; users: string; signals: string; trades: string };

  // `generate_series` supplies the zero rows. Without it a day with no activity
  // is missing rather than zero, and a chart that skips days compresses a quiet
  // week into a line that looks busy.
  const rows = await query<SeriesRow>(
    `WITH days AS (
       SELECT generate_series(
         (now() - ($1::int - 1) * interval '1 day')::date,
         now()::date,
         interval '1 day'
       )::date AS day
     )
     SELECT
       to_char(days.day, 'YYYY-MM-DD') AS day,
       (SELECT COUNT(*) FROM users   u WHERE u.created_at::date = days.day)::text AS users,
       (SELECT COUNT(*) FROM signals s WHERE s.created_at::date = days.day)::text AS signals,
       (SELECT COUNT(*) FROM trades  t WHERE t.opened_at::date  = days.day)::text AS trades
     FROM days
     ORDER BY days.day`,
    [days],
  );

  return rows.map((r) => ({
    date: r.day,
    users: toNumRequired(r.users, 0),
    signals: toNumRequired(r.signals, 0),
    trades: toNumRequired(r.trades, 0),
  }));
}

/* -------------------------------------------------------------------------- */
/* AI usage                                                                   */
/* -------------------------------------------------------------------------- */

export interface AiUsageSummary {
  provider: string;
  model: string;
  operation: string;
  calls: number;
  failures: number;
  promptTokens: number;
  completionTokens: number;
  avgLatencyMs: number;
}

/**
 * AI spend and reliability, grouped.
 *
 * Grouped by provider *and* model *and* operation because those are the three
 * axes an operator acts on: switch provider, downgrade a model, or find the one
 * feature burning the quota.
 */
export async function aiUsage(hours = 24): Promise<AiUsageSummary[]> {
  type UsageRow = {
    provider: string;
    model: string;
    operation: string;
    calls: string;
    failures: string;
    prompt_tokens: string;
    completion_tokens: string;
    avg_latency: string | null;
  };

  const rows = await query<UsageRow>(
    `SELECT provider, model, operation,
            COUNT(*)::text                                   AS calls,
            COUNT(*) FILTER (WHERE NOT success)::text        AS failures,
            COALESCE(SUM(prompt_tokens), 0)::text            AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0)::text        AS completion_tokens,
            AVG(latency_ms)::text                            AS avg_latency
     FROM ai_usage
     WHERE created_at > now() - ($1::int * interval '1 hour')
     GROUP BY provider, model, operation
     ORDER BY COUNT(*) DESC`,
    [hours],
  );

  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    operation: r.operation,
    calls: toNumRequired(r.calls, 0),
    failures: toNumRequired(r.failures, 0),
    promptTokens: toNumRequired(r.prompt_tokens, 0),
    completionTokens: toNumRequired(r.completion_tokens, 0),
    avgLatencyMs: Math.round(toNumRequired(r.avg_latency, 0)),
  }));
}

/* -------------------------------------------------------------------------- */
/* Market symbols                                                             */
/* -------------------------------------------------------------------------- */

export interface UpsertSymbolInput {
  symbol: string;
  name: string;
  assetClass: string;
  base: string;
  quote: string;
  pricePrecision: number;
  tickSize: number;
  contractSize: number;
  tradingViewSymbol: string;
  scanEnabled: boolean;
  displayOrder: number;
}

/**
 * Add or replace a tradable instrument.
 *
 * An upsert rather than separate create/update endpoints: the admin form is the
 * same form either way, and a create that 409s because someone else added the
 * symbol first is a worse experience than an idempotent write.
 */
export async function upsertSymbol(input: UpsertSymbolInput): Promise<void> {
  await query(
    `INSERT INTO market_symbols (
       symbol, name, asset_class, base, quote, price_precision, tick_size,
       contract_size, tradingview_symbol, scan_enabled, display_order
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (symbol) DO UPDATE SET
       name               = EXCLUDED.name,
       asset_class        = EXCLUDED.asset_class,
       base               = EXCLUDED.base,
       quote              = EXCLUDED.quote,
       price_precision    = EXCLUDED.price_precision,
       tick_size          = EXCLUDED.tick_size,
       contract_size      = EXCLUDED.contract_size,
       tradingview_symbol = EXCLUDED.tradingview_symbol,
       scan_enabled       = EXCLUDED.scan_enabled,
       display_order      = EXCLUDED.display_order`,
    [
      input.symbol,
      input.name,
      input.assetClass,
      input.base,
      input.quote,
      input.pricePrecision,
      input.tickSize,
      input.contractSize,
      input.tradingViewSymbol,
      input.scanEnabled,
      input.displayOrder,
    ],
  );
}

/**
 * Remove an instrument.
 *
 * The FK from `signals` is `ON DELETE CASCADE`, so this destroys that symbol's
 * signal history along with it. Callers must confirm — the router does — because
 * deleting a symbol to stop scanning it also erases the record of every call the
 * platform ever made on it. Disabling `scan_enabled` is almost always what the
 * operator actually wants.
 */
export async function deleteSymbol(symbol: string): Promise<boolean> {
  const rows = await query<{ symbol: string }>(
    `DELETE FROM market_symbols WHERE symbol = $1 RETURNING symbol`,
    [symbol],
  );
  return rows.length > 0;
}
