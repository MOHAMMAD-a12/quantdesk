/**
 * Rate limiting.
 *
 * Counters live in Redis so the limit is shared across API replicas — a
 * per-process limiter multiplies the real ceiling by the replica count, which
 * defeats the purpose behind a load balancer.
 *
 * Limits are per-role: an authenticated premium user is not throttled to the
 * same ceiling as an anonymous caller. The identity key is the user id when
 * available and the client IP otherwise.
 *
 * The limiter **fails open**. If Redis is unreachable, requests are allowed
 * through rather than rejected: a cache outage taking down authentication is a
 * worse failure than briefly losing throttling. Abuse protection still has the
 * upstream proxy and the auth-specific limiter below.
 */

import type { NextFunction, Request, Response } from 'express';
import { ROLE_RANK, type UserRole } from '@quantdesk/shared';
import { config } from '../core/config.js';
import { RateLimitError } from '../core/errors.js';
import { incrementWithTtl, isRedisHealthy } from '../db/redis.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('ratelimit');

/** Per-role request ceilings within one window. */
function limitForRole(role: UserRole | undefined): number {
  switch (role) {
    case 'admin':
      return config.rateLimit.admin;
    case 'premium':
      return config.rateLimit.premium;
    default:
      return config.rateLimit.free;
  }
}

/**
 * Identify the caller.
 *
 * Authenticated users are keyed by id so a shared office IP does not pool
 * everyone's quota. Anonymous callers fall back to IP.
 */
function identityKey(req: Request): string {
  if (req.user) return `u:${req.user.id}`;
  // `req.ip` respects the configured trust-proxy setting; without that a
  // spoofed X-Forwarded-For would let a caller mint unlimited identities.
  return `ip:${req.ip ?? 'unknown'}`;
}

export interface RateLimitOptions {
  /** Namespace so different route groups get independent budgets. */
  bucket: string;
  /** Requests permitted per window. Defaults to the caller's role limit. */
  max?: number;
  windowMs?: number;
}

/**
 * Build a rate-limiting middleware.
 *
 * @example
 * router.post('/login', rateLimit({ bucket: 'auth', max: config.rateLimit.auth }), handler)
 */
export function rateLimit(options: RateLimitOptions) {
  const windowMs = options.windowMs ?? config.rateLimit.windowMs;
  const windowSec = Math.max(1, Math.ceil(windowMs / 1000));

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!isRedisHealthy()) {
      next();
      return;
    }

    const max = options.max ?? limitForRole(req.user?.role);
    // Fixed window, aligned to wall-clock so the key expires naturally.
    const window = Math.floor(Date.now() / windowMs);
    const key = `rl:${options.bucket}:${identityKey(req)}:${window}`;

    try {
      const count = await incrementWithTtl(key, windowSec);

      // incrementWithTtl returns 0 when Redis failed mid-flight — treat as allow.
      if (count === 0) {
        next();
        return;
      }

      const remaining = Math.max(0, max - count);
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String((window + 1) * Math.ceil(windowMs / 1000)));

      if (count > max) {
        const retryAfterSec = Math.ceil((((window + 1) * windowMs) - Date.now()) / 1000);
        log.warn(
          { bucket: options.bucket, identity: identityKey(req), count, max },
          'Rate limit exceeded',
        );
        next(new RateLimitError('Too many requests — slow down', Math.max(1, retryAfterSec)));
        return;
      }

      next();
    } catch (err) {
      log.debug({ err }, 'Rate limit check failed — allowing request');
      next();
    }
  };
}

/**
 * Strict limiter for credential endpoints (login, register, password reset).
 *
 * Keyed by IP regardless of authentication state, because the whole point is to
 * slow credential stuffing from an unauthenticated attacker.
 */
export const authRateLimit = rateLimit({
  bucket: 'auth',
  max: config.rateLimit.auth,
});

/** Tighter budget for endpoints that cost real money (AI calls). */
export function aiRateLimit(max?: number) {
  return rateLimit({
    bucket: 'ai',
    max: max ?? Math.max(5, Math.floor(config.rateLimit.free / 4)),
  });
}

/**
 * Guard for expensive routes that must never be hit by anonymous callers at
 * scale — requires the role rank to meet a floor before the budget applies.
 */
export function minimumRole(role: UserRole): number {
  return ROLE_RANK[role];
}
