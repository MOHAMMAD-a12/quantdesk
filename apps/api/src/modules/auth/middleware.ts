/**
 * Authentication and authorisation middleware.
 *
 * Two credential types are accepted and they are not equivalent:
 *
 * **Bearer JWT** — interactive users. Verified statelessly, so a revoked session
 * remains usable for up to one access-token lifetime. That bound is documented in
 * `tokens.ts` and is the deliberate price of not querying Postgres per request.
 *
 * **`X-API-Key`** — programmatic callers. Checked against the database on every
 * request, so revocation is immediate. API keys are also scoped, and a scope
 * check is available for routes that need one.
 *
 * `req.user` is populated identically either way, with `apiKeyId` set only in the
 * key case, so downstream handlers do not branch on credential type. Routes that
 * genuinely must not be reachable by a key can check that field.
 */

import type { NextFunction, Request, Response } from 'express';
import { ROLE_RANK, type UserRole } from '@quantdesk/shared';
import { sha256 } from '../../core/crypto.js';
import { ForbiddenError, UnauthorizedError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import * as repo from './repository.js';
import { verifyAccessToken } from './tokens.js';

const log = moduleLogger('auth:middleware');

/**
 * Extract a bearer token.
 *
 * Only the `Authorization` header is read. Accepting a token from a query string
 * would write credentials into access logs, proxy logs and browser history.
 */
function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function apiKeyHeader(req: Request): string | null {
  const value = req.get('x-api-key');
  return value?.trim() || null;
}

/**
 * Resolve an API key to a principal and attach it.
 *
 * The `last_used_at` update is intentionally not awaited: it is telemetry, and
 * blocking every API-key request on a write to make a timestamp exact is the
 * wrong trade. Failures are logged, not propagated.
 */
async function authenticateApiKey(req: Request, key: string): Promise<void> {
  const principal = await repo.findApiKeyPrincipal(sha256(key));
  if (!principal) throw new UnauthorizedError('Invalid or expired API key');

  req.user = {
    id: principal.userId,
    email: principal.email,
    role: principal.role,
    apiKeyId: principal.keyId,
  };

  void repo.touchApiKey(principal.keyId).catch((err: unknown) => {
    log.debug({ err, keyId: principal.keyId }, 'Failed to update API key last_used_at');
  });
}

/** Verify a JWT and attach the principal. */
function authenticateJwt(req: Request, token: string): void {
  const claims = verifyAccessToken(token);
  req.user = { id: claims.sub, email: claims.email, role: claims.role };
}

/**
 * Require a valid credential.
 *
 * A request presenting both a JWT and an API key uses the JWT, so an expired key
 * in a client's default headers cannot shadow a valid interactive session.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearerToken(req);
    if (token) {
      authenticateJwt(req, token);
      next();
      return;
    }

    const key = apiKeyHeader(req);
    if (key) {
      await authenticateApiKey(req, key);
      next();
      return;
    }

    next(new UnauthorizedError('Authentication required'));
  } catch (err) {
    next(err);
  }
}

/**
 * Attach a principal when one is presented, but never reject.
 *
 * For endpoints whose *content* varies with authentication — public market data
 * that shows more history to a premium user, for instance. An invalid credential
 * is treated as absent rather than as an error: the route works unauthenticated,
 * so failing it on a stale token would be a worse experience than silently
 * serving the public view.
 */
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearerToken(req);
    if (token) {
      authenticateJwt(req, token);
      next();
      return;
    }

    const key = apiKeyHeader(req);
    if (key) {
      await authenticateApiKey(req, key);
    }
  } catch (err) {
    log.debug({ err }, 'Optional auth credential rejected — continuing anonymously');
    delete req.user;
  }
  next();
}

/**
 * Require a role rank at or above `minimum`.
 *
 * Rank-based rather than equality-based: `requireRole('premium')` admits admins
 * too. An admin being locked out of a premium feature would be an absurd result,
 * and enumerating allowed roles at every call site invites the omission.
 *
 * Must be registered after {@link authenticate}; a missing principal is a 401,
 * not a 403, because the client's correct next action is to authenticate.
 */
export function requireRole(minimum: UserRole) {
  const required = ROLE_RANK[minimum];

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (ROLE_RANK[req.user.role] < required) {
      next(new ForbiddenError(`This feature requires a ${minimum} plan`));
      return;
    }

    next();
  };
}

/** Shorthand for the admin panel. */
export const requireAdmin = requireRole('admin');

/**
 * Reject API-key credentials on a route.
 *
 * Used for account-security operations — changing a password, minting a new key
 * — where a leaked key must not be able to escalate into full account control.
 */
export function requireInteractiveSession(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    next(new UnauthorizedError('Authentication required'));
    return;
  }
  if (req.user.apiKeyId) {
    next(new ForbiddenError('This operation requires an interactive session, not an API key'));
    return;
  }
  next();
}

/**
 * Require a scope on the presenting API key.
 *
 * JWT sessions pass unconditionally: scopes exist to *narrow* a programmatic
 * credential below the user's own authority, and an interactive session already
 * carries that full authority. A `*` scope on a key means unrestricted.
 */
export function requireScope(scope: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const user = req.user;
    if (!user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }
    if (!user.apiKeyId) {
      next();
      return;
    }

    try {
      const key = apiKeyHeader(req);
      const principal = key ? await repo.findApiKeyPrincipal(sha256(key)) : null;

      if (!principal) {
        next(new UnauthorizedError('Invalid or expired API key'));
        return;
      }
      if (!principal.scopes.includes(scope) && !principal.scopes.includes('*')) {
        next(new ForbiddenError(`API key is missing the "${scope}" scope`));
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Assert the principal owns the resource, or is an admin.
 *
 * Centralised because "read the id from the URL and trust it" is the most common
 * way an otherwise-authenticated API leaks another user's data.
 */
export function assertOwnership(req: Request, ownerId: string): void {
  if (!req.user) throw new UnauthorizedError('Authentication required');
  if (req.user.id === ownerId) return;
  if (req.user.role === 'admin') return;
  throw new ForbiddenError('You do not have access to this resource');
}
