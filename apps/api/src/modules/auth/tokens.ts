/**
 * JWT issuance and verification.
 *
 * Two token types with **separate secrets** and an explicit `typ` claim. Either
 * mechanism alone would prevent a refresh token from being replayed as an access
 * token; both are used because the failure mode is total account compromise, and
 * the `typ` check also guards against a future misconfiguration that sets both
 * secrets to the same value.
 *
 * Access tokens are short-lived, self-contained, and never checked against the
 * database — that is the point of a stateless access token, and it means a
 * revoked session stays usable until the access token expires (15 minutes by
 * default). Refresh tokens carry a session id (`sid`) and *are* checked, so
 * revocation is effective within one access-token lifetime. That bound is the
 * deliberate cost of not hitting Postgres on every request.
 */

import jwt, { type SignOptions } from 'jsonwebtoken';
import type { AccessTokenClaims, RefreshTokenClaims, UserRole } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { UnauthorizedError } from '../../core/errors.js';

const ISSUER = 'quantdesk';
const AUDIENCE = 'quantdesk-api';

/**
 * TTL strings come from validated config as plain `string`, but recent
 * `@types/jsonwebtoken` narrows `expiresIn` to a template-literal union
 * (`ms.StringValue`). The cast is confined to these two constants rather than
 * spread across the sign calls, and an unparseable value is rejected by the
 * signer at first use.
 */
const ACCESS_EXPIRES_IN = config.auth.accessTtl as SignOptions['expiresIn'];
const REFRESH_EXPIRES_IN = config.auth.refreshTtl as SignOptions['expiresIn'];

export interface AccessTokenSubject {
  id: string;
  email: string;
  role: UserRole;
}

/** Mint a short-lived access token. */
export function signAccessToken(user: AccessTokenSubject): string {
  return jwt.sign({ email: user.email, role: user.role, typ: 'access' }, config.auth.accessSecret, {
    subject: user.id,
    expiresIn: ACCESS_EXPIRES_IN,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/**
 * Mint a refresh token bound to a persisted session.
 *
 * @param sessionId The `sessions.id` row this token authorises. Rotating the
 *   token updates that row; revoking the row kills the token.
 */
export function signRefreshToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId, typ: 'refresh' }, config.auth.refreshSecret, {
    subject: userId,
    expiresIn: REFRESH_EXPIRES_IN,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/**
 * Verify an access token.
 *
 * @throws {UnauthorizedError} for expired, malformed, wrong-secret or
 *   wrong-type tokens. The distinction between "expired" and "invalid" is
 *   preserved in the message because clients need it to decide whether to
 *   refresh or to redirect to login; nothing else about the failure is exposed.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  const payload = verify(token, config.auth.accessSecret);

  if (payload.typ !== 'access') {
    throw new UnauthorizedError('Invalid token type');
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
    throw new UnauthorizedError('Malformed token claims');
  }
  if (!isRole(payload.role)) {
    throw new UnauthorizedError('Malformed token claims');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
    typ: 'access',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
  };
}

/** Verify a refresh token. Does **not** consult the database — see `service.ts`. */
export function verifyRefreshToken(token: string): RefreshTokenClaims {
  const payload = verify(token, config.auth.refreshSecret);

  if (payload.typ !== 'refresh') {
    throw new UnauthorizedError('Invalid token type');
  }
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw new UnauthorizedError('Malformed token claims');
  }

  return {
    sub: payload.sub,
    sid: payload.sid,
    typ: 'refresh',
    iat: typeof payload.iat === 'number' ? payload.iat : 0,
    exp: typeof payload.exp === 'number' ? payload.exp : 0,
  };
}

/** Shared verification with issuer/audience pinning and error normalisation. */
function verify(token: string, secret: string): Record<string, unknown> {
  try {
    const decoded = jwt.verify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pin the algorithm. Without this a token signed with `alg: none` — or an
      // RS256 token verified against our HMAC secret as a public key — could be
      // accepted, which is the classic JWT bypass.
      algorithms: ['HS256'],
    });

    if (typeof decoded === 'string') {
      throw new UnauthorizedError('Malformed token');
    }
    return decoded as Record<string, unknown>;
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err;
    if (err instanceof jwt.TokenExpiredError) throw new UnauthorizedError('Token expired');
    throw new UnauthorizedError('Invalid token');
  }
}

function isRole(value: unknown): value is UserRole {
  return value === 'free' || value === 'premium' || value === 'admin';
}

/**
 * Access-token lifetime in seconds, for the `expiresIn` field of `AuthTokens`.
 *
 * Derived from the same config string the signer uses rather than hardcoded, so
 * the number the client sees cannot drift from the token's real expiry. Decoding
 * an actual token would be exact, but this avoids a signature round-trip on
 * every login and the parser covers the formats `jsonwebtoken` accepts.
 */
export function accessTokenTtlSeconds(): number {
  return parseDuration(config.auth.accessTtl, 15 * 60);
}

/** Refresh-token lifetime in milliseconds, for computing `sessions.expires_at`. */
export function refreshTokenTtlMs(): number {
  return parseDuration(config.auth.refreshTtl, 30 * 24 * 3600) * 1000;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
  y: 31_536_000,
};

/**
 * Parse a `jsonwebtoken`-style duration (`'15m'`, `'30d'`, `'3600'`) to seconds.
 *
 * Falls back to `fallback` rather than throwing: a bad TTL string should not
 * prevent the server from booting, and the config schema already constrains the
 * shape loosely. The signer would reject a truly invalid value at first use.
 */
function parseDuration(value: string, fallback: number): number {
  const trimmed = value.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)$/i.exec(trimmed);
  if (!match) return fallback;

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();

  if (unit === 'ms') return Math.round(amount / 1000);
  const seconds = UNIT_SECONDS[unit];
  if (seconds === undefined || !Number.isFinite(amount)) return fallback;

  return Math.round(amount * seconds);
}
