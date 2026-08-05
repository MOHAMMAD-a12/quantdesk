/**
 * Data access for identity.
 *
 * All SQL for users, sessions, password-reset tokens and API keys lives here, so
 * the service layer reads as policy rather than as queries and there is exactly
 * one place to audit for injection (there is none — every statement is
 * parameterised).
 *
 * The `password_hash` column is never selected into a `User`. It is returned
 * only by {@link findCredentialsByEmail}, whose name makes the exception
 * obvious, so a hash cannot reach a response body by accident.
 */

import type { PoolClient } from 'pg';
import type { Subscription, SubscriptionStatus, User, UserRole, ApiKey } from '@quantdesk/shared';
import { query, queryOne, transaction } from '../../db/pool.js';
import { fromEpoch, toEpoch, toEpochRequired, toStrArray } from '../../db/rows.js';

/* -------------------------------------------------------------------------- */
/* Row shapes                                                                 */
/* -------------------------------------------------------------------------- */

interface UserRow {
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
}

interface SubscriptionRow {
  id: string;
  user_id: string;
  plan: UserRole;
  status: SubscriptionStatus;
  started_at: Date;
  expires_at: Date | null;
  cancelled_at: Date | null;
  external_ref: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  scopes: string[] | null;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

const USER_COLUMNS = `
  id, email, display_name, role, email_verified, is_active,
  avatar_url, timezone, created_at, last_login_at
`;

export function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    emailVerified: row.email_verified,
    isActive: row.is_active,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    createdAt: toEpochRequired(row.created_at),
    lastLoginAt: toEpoch(row.last_login_at),
  };
}

function mapSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.user_id,
    plan: row.plan,
    status: row.status,
    startedAt: toEpochRequired(row.started_at),
    expiresAt: toEpoch(row.expires_at),
    cancelledAt: toEpoch(row.cancelled_at),
    externalRef: row.external_ref,
  };
}

export function mapApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    prefix: row.prefix,
    scopes: toStrArray(row.scopes),
    lastUsedAt: toEpoch(row.last_used_at),
    expiresAt: toEpoch(row.expires_at),
    revokedAt: toEpoch(row.revoked_at),
    createdAt: toEpochRequired(row.created_at),
  };
}

/* -------------------------------------------------------------------------- */
/* Users                                                                      */
/* -------------------------------------------------------------------------- */

export async function findUserById(id: string): Promise<User | null> {
  const row = await queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
  return row ? mapUser(row) : null;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const row = await queryOne<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return row ? mapUser(row) : null;
}

/**
 * Fetch the password hash alongside the identity, for login and for
 * verifying the current password on change.
 *
 * The only query in the codebase that reads `password_hash`.
 */
export async function findCredentialsByEmail(
  email: string,
): Promise<{ user: User; passwordHash: string } | null> {
  const row = await queryOne<UserRow & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  if (!row) return null;
  return { user: mapUser(row), passwordHash: row.password_hash };
}

export async function findPasswordHashById(userId: string): Promise<string | null> {
  const row = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [userId],
  );
  return row?.password_hash ?? null;
}

export async function emailExists(email: string): Promise<boolean> {
  const row = await queryOne<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($1)) AS exists',
    [email],
  );
  return row?.exists === true;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  displayName: string;
  timezone: string;
  role: UserRole;
  defaultMinConfidence: number;
  defaultNotifyConfidence: number;
}

/**
 * Create a user together with its subscription and preference rows.
 *
 * One transaction, because a user without preferences is a half-provisioned
 * account that every downstream reader would have to defend against with a
 * null check. Provisioning it atomically at creation removes that class of bug
 * entirely.
 */
export async function createUser(input: CreateUserInput): Promise<User> {
  return transaction(async (client: PoolClient) => {
    const inserted = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, role, timezone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.passwordHash, input.displayName, input.role, input.timezone],
    );

    const row = inserted.rows[0];
    if (!row) throw new Error('User insert returned no row');

    await client.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, $2, 'active', NULL)`,
      [row.id, input.role],
    );

    await client.query(
      `INSERT INTO user_preferences (user_id, min_signal_confidence, notify_min_confidence)
       VALUES ($1, $2, $3)`,
      [row.id, input.defaultMinConfidence, input.defaultNotifyConfidence],
    );

    return mapUser(row);
  });
}

export async function touchLastLogin(userId: string): Promise<void> {
  await query('UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1', [userId]);
}

export async function updatePasswordHash(userId: string, passwordHash: string): Promise<void> {
  await query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
    userId,
    passwordHash,
  ]);
}

/** The user's current subscription, most recent first. Null when none exists. */
export async function findActiveSubscription(userId: string): Promise<Subscription | null> {
  const row = await queryOne<SubscriptionRow>(
    `SELECT id, user_id, plan, status, started_at, expires_at, cancelled_at, external_ref
       FROM subscriptions
      WHERE user_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId],
  );
  return row ? mapSubscription(row) : null;
}

/** Attach the subscription to a user for the `/me` payload. */
export async function withSubscription(user: User): Promise<User> {
  return { ...user, subscription: await findActiveSubscription(user.id) };
}

/* -------------------------------------------------------------------------- */
/* Sessions                                                                   */
/* -------------------------------------------------------------------------- */

export interface SessionRecord {
  id: string;
  userId: string;
  refreshHash: string;
  expiresAt: number;
  revokedAt: number | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  refresh_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

/**
 * Create a session row.
 *
 * The row is written *before* the refresh token is signed, because the token
 * embeds the row's id. The hash is therefore a placeholder until
 * {@link updateSessionHash} runs — the service does both in sequence and a
 * session whose hash never matches is simply unusable, which is the safe
 * failure direction.
 */
export async function createSession(input: {
  userId: string;
  refreshHash: string;
  expiresAt: number;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO sessions (user_id, refresh_hash, expires_at, user_agent, ip_address)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.userId,
      input.refreshHash,
      fromEpoch(input.expiresAt),
      input.userAgent,
      input.ipAddress,
    ],
  );
  if (!row) throw new Error('Session insert returned no row');
  return row.id;
}

export async function updateSessionHash(sessionId: string, refreshHash: string): Promise<void> {
  await query('UPDATE sessions SET refresh_hash = $2, last_used_at = now() WHERE id = $1', [
    sessionId,
    refreshHash,
  ]);
}

export async function findSession(sessionId: string): Promise<SessionRecord | null> {
  const row = await queryOne<SessionRow>(
    'SELECT id, user_id, refresh_hash, expires_at, revoked_at FROM sessions WHERE id = $1',
    [sessionId],
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    refreshHash: row.refresh_hash,
    expiresAt: toEpochRequired(row.expires_at),
    revokedAt: toEpoch(row.revoked_at),
  };
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
  ]);
}

/** Revoke every live session for a user. Returns the count revoked. */
export async function revokeAllSessions(userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL RETURNING id',
    [userId],
  );
  return rows.length;
}

/**
 * Delete sessions that are revoked or long expired.
 *
 * Expired rows are kept for a grace period rather than deleted immediately:
 * a refresh arriving against a just-expired session should produce "session
 * expired", not "session not found", and the distinction matters when reading
 * the audit log after an incident.
 */
export async function pruneSessions(graceDays = 7): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM sessions
      WHERE expires_at < now() - ($1 || ' days')::interval
         OR (revoked_at IS NOT NULL AND revoked_at < now() - ($1 || ' days')::interval)
      RETURNING id`,
    [String(Math.max(0, Math.floor(graceDays)))],
  );
  return rows.length;
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                             */
/* -------------------------------------------------------------------------- */

export async function createPasswordResetToken(
  userId: string,
  tokenHash: string,
  expiresAt: number,
): Promise<void> {
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, fromEpoch(expiresAt)],
  );
}

export interface ResetTokenRecord {
  id: string;
  userId: string;
  expiresAt: number;
  usedAt: number | null;
}

export async function findPasswordResetToken(tokenHash: string): Promise<ResetTokenRecord | null> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    expires_at: Date;
    used_at: Date | null;
  }>(
    'SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1',
    [tokenHash],
  );
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    expiresAt: toEpochRequired(row.expires_at),
    usedAt: toEpoch(row.used_at),
  };
}

/**
 * Mark a reset token used.
 *
 * `AND used_at IS NULL` makes this a compare-and-swap: two concurrent requests
 * with the same token produce one update and one no-op, and the caller treats a
 * zero row count as "already used". Checking `used_at` in application code and
 * then updating would leave a window where both requests pass the check.
 */
export async function consumePasswordResetToken(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'UPDATE password_reset_tokens SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id',
    [id],
  );
  return rows.length === 1;
}

/** Invalidate every outstanding reset token for a user. */
export async function invalidateResetTokens(userId: string): Promise<void> {
  await query(
    'UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
    [userId],
  );
}

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

const API_KEY_COLUMNS = `
  id, user_id, name, prefix, scopes, last_used_at, expires_at, revoked_at, created_at
`;

export async function insertApiKey(input: {
  userId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  expiresAt: number | null;
}): Promise<ApiKey> {
  const row = await queryOne<ApiKeyRow>(
    `INSERT INTO api_keys (user_id, name, prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${API_KEY_COLUMNS}`,
    [input.userId, input.name, input.prefix, input.keyHash, input.scopes, fromEpoch(input.expiresAt)],
  );
  if (!row) throw new Error('API key insert returned no row');
  return mapApiKey(row);
}

export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  const rows = await query<ApiKeyRow>(
    `SELECT ${API_KEY_COLUMNS} FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
    [userId],
  );
  return rows.map(mapApiKey);
}

export async function revokeApiKey(userId: string, keyId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
      RETURNING id`,
    [keyId, userId],
  );
  return rows.length === 1;
}

export interface ApiKeyPrincipal {
  keyId: string;
  userId: string;
  email: string;
  role: UserRole;
  scopes: string[];
}

/**
 * Resolve a presented API key to its owner.
 *
 * Looked up by the SHA-256 of the key: the plaintext is never stored, so a
 * database dump does not yield usable credentials. Expiry, revocation and the
 * owner's active flag are all filtered in SQL, which keeps the "is this key
 * usable" decision in one place instead of spread across the caller.
 */
export async function findApiKeyPrincipal(keyHash: string): Promise<ApiKeyPrincipal | null> {
  const row = await queryOne<{
    id: string;
    user_id: string;
    scopes: string[] | null;
    email: string;
    role: UserRole;
  }>(
    `SELECT k.id, k.user_id, k.scopes, u.email, u.role
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_hash = $1
        AND k.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > now())
        AND u.is_active = TRUE`,
    [keyHash],
  );
  if (!row) return null;
  return {
    keyId: row.id,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    scopes: toStrArray(row.scopes),
  };
}

/**
 * Record usage of an API key.
 *
 * Deliberately fire-and-forget at the call site: a failed timestamp update must
 * not fail the request it is decorating.
 */
export async function touchApiKey(keyId: string): Promise<void> {
  await query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [keyId]);
}
