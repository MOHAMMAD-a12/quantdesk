/**
 * Authentication policy.
 *
 * The rules encoded here, and why:
 *
 * **Login failures are indistinguishable.** Unknown email, wrong password and
 * deactivated account all produce the same 401 with the same message and both
 * paths run a bcrypt comparison. Returning "no such user" would turn the login
 * endpoint into an account-enumeration oracle, and skipping the hash on the
 * unknown-email path would turn response *timing* into the same oracle.
 *
 * **Refresh tokens rotate on every use.** A refresh consumes its token and
 * issues a new one. Presenting an already-rotated token is treated as theft —
 * either the attacker is replaying a stolen token or the legitimate client is
 * replaying one that leaked — and the entire session family is revoked. That
 * costs the user a re-login in the rare benign case (a client that retried after
 * a dropped response) and contains the damage in the malicious one.
 *
 * **Password changes revoke every other session.** If a password is being
 * changed because it was compromised, leaving the attacker's sessions live
 * defeats the change.
 *
 * **Password reset never reveals whether an account exists.** The endpoint
 * responds identically for a registered and an unregistered address.
 */

import bcrypt from 'bcryptjs';
import type { AuthSession, AuthTokens, User, UserRole } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { sha256, randomToken } from '../../core/crypto.js';
import { ConflictError, UnauthorizedError, ValidationError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import { AUDIT_ACTIONS, recordAudit } from '../../core/audit.js';
import * as repo from './repository.js';
import {
  accessTokenTtlSeconds,
  refreshTokenTtlMs,
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from './tokens.js';

const log = moduleLogger('auth');

/** How long a password-reset link stays valid. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * A bcrypt hash of a value no user can produce, compared against on the
 * unknown-email path so that path costs the same as a real verification.
 * Computed once at module load.
 */
const DUMMY_HASH = bcrypt.hashSync('unknown-account-placeholder', config.auth.bcryptRounds);

export interface RequestContext {
  ipAddress: string | null;
  userAgent: string | null;
}

/* -------------------------------------------------------------------------- */
/* Registration                                                              */
/* -------------------------------------------------------------------------- */

export interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
  timezone: string;
}

/**
 * Create an account and log it straight in.
 *
 * New accounts are always `free`. Role is never taken from the request body —
 * that would be a privilege-escalation endpoint. Promotion happens only through
 * the admin module.
 */
export async function register(input: RegisterInput, ctx: RequestContext): Promise<AuthSession> {
  if (await repo.emailExists(input.email)) {
    // Registration is the one place enumeration cannot be avoided: the user has
    // to be told the address is taken. The auth rate limiter is what makes this
    // impractical to abuse as a bulk oracle.
    throw new ConflictError('An account with that email already exists');
  }

  const passwordHash = await bcrypt.hash(input.password, config.auth.bcryptRounds);

  const user = await repo.createUser({
    email: input.email,
    passwordHash,
    displayName: input.displayName,
    timezone: input.timezone,
    role: 'free',
    defaultMinConfidence: config.signals.minConfidence,
    defaultNotifyConfidence: config.signals.notifyMinConfidence,
  });

  await recordAudit({
    action: AUDIT_ACTIONS.authRegister,
    userId: user.id,
    actorEmail: user.email,
    resourceType: 'user',
    resourceId: user.id,
    ...ctx,
  });

  const tokens = await issueTokens(user, ctx);
  return { user: await repo.withSubscription(user), tokens };
}

/* -------------------------------------------------------------------------- */
/* Login                                                                     */
/* -------------------------------------------------------------------------- */

export async function login(
  input: { email: string; password: string },
  ctx: RequestContext,
): Promise<AuthSession> {
  const found = await repo.findCredentialsByEmail(input.email);

  // Always run a comparison, even with no account, so the response time does not
  // separate "no such user" from "wrong password".
  const hash = found?.passwordHash ?? DUMMY_HASH;
  const passwordMatches = await bcrypt.compare(input.password, hash);

  if (!found || !passwordMatches || !found.user.isActive) {
    await recordAudit({
      action: AUDIT_ACTIONS.authLoginFailed,
      userId: found?.user.id ?? null,
      actorEmail: input.email,
      metadata: {
        reason: !found ? 'unknown_email' : !passwordMatches ? 'bad_password' : 'inactive',
      },
      ...ctx,
    });
    throw new UnauthorizedError('Invalid email or password');
  }

  await repo.touchLastLogin(found.user.id);

  await recordAudit({
    action: AUDIT_ACTIONS.authLogin,
    userId: found.user.id,
    actorEmail: found.user.email,
    ...ctx,
  });

  const tokens = await issueTokens(found.user, ctx);
  return { user: await repo.withSubscription(found.user), tokens };
}

/* -------------------------------------------------------------------------- */
/* Refresh                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Exchange a refresh token for a new pair.
 *
 * The presented token must both verify cryptographically *and* hash to the value
 * stored on its session row. The signature alone would let a token that has
 * already been rotated keep working until its own expiry, which is precisely the
 * replay window rotation exists to close.
 */
export async function refresh(refreshToken: string, ctx: RequestContext): Promise<AuthSession> {
  const claims = verifyRefreshToken(refreshToken);
  const session = await repo.findSession(claims.sid);

  if (!session || session.userId !== claims.sub) {
    throw new UnauthorizedError('Session not found');
  }

  if (session.revokedAt !== null) {
    // A revoked session being presented means the token outlived its revocation.
    // Nothing more to revoke, but it is worth recording.
    await recordAudit({
      action: AUDIT_ACTIONS.authRefreshReuse,
      userId: session.userId,
      resourceType: 'session',
      resourceId: session.id,
      metadata: { reason: 'revoked_session' },
      ...ctx,
    });
    throw new UnauthorizedError('Session has been revoked');
  }

  if (session.expiresAt <= Date.now()) {
    throw new UnauthorizedError('Session expired');
  }

  // Rotation check: the stored hash is the *current* token. Anything else is a
  // replay of a superseded one.
  if (session.refreshHash !== sha256(refreshToken)) {
    const revoked = await repo.revokeAllSessions(session.userId);
    log.warn(
      { userId: session.userId, sessionId: session.id, revoked },
      'Refresh token reuse detected — all sessions revoked',
    );
    await recordAudit({
      action: AUDIT_ACTIONS.authRefreshReuse,
      userId: session.userId,
      resourceType: 'session',
      resourceId: session.id,
      metadata: { reason: 'stale_token', sessionsRevoked: revoked },
      ...ctx,
    });
    throw new UnauthorizedError('Session is no longer valid — please sign in again');
  }

  const user = await repo.findUserById(session.userId);
  if (!user || !user.isActive) {
    await repo.revokeSession(session.id);
    throw new UnauthorizedError('Account is not active');
  }

  // Reuse the same session row so the family stays traceable and revoking it
  // still kills every descendant token.
  const nextRefresh = signRefreshToken(user.id, session.id);
  await repo.updateSessionHash(session.id, sha256(nextRefresh));

  const tokens: AuthTokens = {
    accessToken: signAccessToken(user),
    refreshToken: nextRefresh,
    expiresIn: accessTokenTtlSeconds(),
    tokenType: 'Bearer',
  };

  return { user: await repo.withSubscription(user), tokens };
}

/* -------------------------------------------------------------------------- */
/* Logout                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Revoke the session behind a refresh token.
 *
 * Invalid or already-revoked tokens resolve successfully. Logout is idempotent
 * by design: a client that cannot log out because its token was already
 * unusable is stuck holding credentials it wanted to discard.
 */
export async function logout(refreshToken: string, ctx: RequestContext): Promise<void> {
  let sessionId: string | null = null;
  let userId: string | null = null;

  try {
    const claims = verifyRefreshToken(refreshToken);
    sessionId = claims.sid;
    userId = claims.sub;
  } catch {
    return;
  }

  await repo.revokeSession(sessionId);
  await recordAudit({
    action: AUDIT_ACTIONS.authLogout,
    userId,
    resourceType: 'session',
    resourceId: sessionId,
    ...ctx,
  });
}

/** Revoke every session for a user — "sign out everywhere". */
export async function logoutAll(userId: string, ctx: RequestContext): Promise<number> {
  const revoked = await repo.revokeAllSessions(userId);
  await recordAudit({
    action: AUDIT_ACTIONS.authLogoutAll,
    userId,
    metadata: { sessionsRevoked: revoked },
    ...ctx,
  });
  return revoked;
}

/* -------------------------------------------------------------------------- */
/* Password management                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Change a password for an authenticated user.
 *
 * Every other session is revoked and a fresh pair is issued for the caller, so
 * the user stays signed in on the device they made the change from and is signed
 * out everywhere else.
 */
export async function changePassword(
  userId: string,
  input: { currentPassword: string; newPassword: string },
  ctx: RequestContext,
): Promise<AuthTokens> {
  const currentHash = await repo.findPasswordHashById(userId);
  if (!currentHash) throw new UnauthorizedError('Account not found');

  if (!(await bcrypt.compare(input.currentPassword, currentHash))) {
    await recordAudit({
      action: AUDIT_ACTIONS.authLoginFailed,
      userId,
      metadata: { reason: 'change_password_bad_current' },
      ...ctx,
    });
    throw new UnauthorizedError('Current password is incorrect');
  }

  if (await bcrypt.compare(input.newPassword, currentHash)) {
    throw new ValidationError('New password must differ from the current one', [
      { path: 'body.newPassword', message: 'Must differ from the current password' },
    ]);
  }

  const user = await repo.findUserById(userId);
  if (!user) throw new UnauthorizedError('Account not found');

  await repo.updatePasswordHash(userId, await bcrypt.hash(input.newPassword, config.auth.bcryptRounds));
  // Outstanding reset links are stale the moment the password changes.
  await repo.invalidateResetTokens(userId);
  await repo.revokeAllSessions(userId);

  await recordAudit({
    action: AUDIT_ACTIONS.authPasswordChanged,
    userId,
    actorEmail: user.email,
    ...ctx,
  });

  return issueTokens(user, ctx);
}

export interface PasswordResetRequest {
  /**
   * The reset token, present only when an account matched.
   *
   * Returned to the caller so the notification layer can deliver it. It is
   * deliberately *not* part of the HTTP response — the route ignores this field
   * and always answers with the same generic acknowledgement.
   */
  token: string | null;
  user: User | null;
}

/**
 * Begin a password reset.
 *
 * Only the SHA-256 of the token is stored. A database leak therefore does not
 * hand over working reset links, and the token is high-entropy so a hash is
 * sufficient — bcrypt's work factor buys nothing against a 256-bit random value.
 */
export async function requestPasswordReset(
  email: string,
  ctx: RequestContext,
): Promise<PasswordResetRequest> {
  const user = await repo.findUserByEmail(email);

  if (!user || !user.isActive) {
    log.info({ email }, 'Password reset requested for unknown or inactive account');
    return { token: null, user: null };
  }

  // Supersede any outstanding links so only the newest one works.
  await repo.invalidateResetTokens(user.id);

  const token = randomToken(32);
  await repo.createPasswordResetToken(user.id, sha256(token), Date.now() + RESET_TOKEN_TTL_MS);

  await recordAudit({
    action: AUDIT_ACTIONS.authPasswordResetRequested,
    userId: user.id,
    actorEmail: user.email,
    ...ctx,
  });

  return { token, user };
}

/**
 * Complete a password reset.
 *
 * Consuming the token is a conditional update, so two requests racing with the
 * same token cannot both succeed. All sessions are revoked: a reset is the
 * strongest signal available that the previous credential is untrusted.
 */
export async function resetPassword(
  input: { token: string; newPassword: string },
  ctx: RequestContext,
): Promise<void> {
  const record = await repo.findPasswordResetToken(sha256(input.token));

  // One message for missing, used and expired tokens — the distinction is not
  // useful to a legitimate user and is useful to an attacker probing tokens.
  if (!record || record.usedAt !== null || record.expiresAt <= Date.now()) {
    throw new UnauthorizedError('Reset link is invalid or has expired');
  }

  if (!(await repo.consumePasswordResetToken(record.id))) {
    throw new UnauthorizedError('Reset link is invalid or has expired');
  }

  const user = await repo.findUserById(record.userId);
  if (!user || !user.isActive) throw new UnauthorizedError('Account is not active');

  await repo.updatePasswordHash(
    user.id,
    await bcrypt.hash(input.newPassword, config.auth.bcryptRounds),
  );
  await repo.revokeAllSessions(user.id);

  await recordAudit({
    action: AUDIT_ACTIONS.authPasswordResetCompleted,
    userId: user.id,
    actorEmail: user.email,
    ...ctx,
  });
}

/* -------------------------------------------------------------------------- */
/* Session issuance                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create a session row and mint a token pair against it.
 *
 * The row is inserted first with a placeholder hash because the refresh token
 * embeds the row id, then updated with the real hash. A crash between the two
 * leaves an unusable session, not a usable one — the safe direction.
 */
async function issueTokens(
  user: { id: string; email: string; role: UserRole },
  ctx: RequestContext,
): Promise<AuthTokens> {
  const sessionId = await repo.createSession({
    userId: user.id,
    refreshHash: 'pending',
    expiresAt: Date.now() + refreshTokenTtlMs(),
    userAgent: ctx.userAgent,
    ipAddress: ctx.ipAddress,
  });

  const refreshToken = signRefreshToken(user.id, sessionId);
  await repo.updateSessionHash(sessionId, sha256(refreshToken));

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: accessTokenTtlSeconds(),
    tokenType: 'Bearer',
  };
}

/** Load the full `/me` payload for an authenticated principal. */
export async function currentUser(userId: string): Promise<User> {
  const user = await repo.findUserById(userId);
  if (!user) throw new UnauthorizedError('Account not found');
  if (!user.isActive) throw new UnauthorizedError('Account is not active');
  return repo.withSubscription(user);
}
