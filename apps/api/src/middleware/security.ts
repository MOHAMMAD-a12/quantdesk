/**
 * Security middleware: headers, CORS and CSRF.
 *
 * Covers the transport-level protections from the spec. The other half lives
 * elsewhere by design: SQL injection is prevented by parameterised queries in
 * `db/pool.ts`, and output-encoding XSS defence is React's job in the web app.
 * Header policy cannot fix an interpolated query, so this file does not pretend
 * to.
 */

import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../core/config.js';
import { ForbiddenError } from '../core/errors.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('security');

/**
 * Baseline security headers.
 *
 * CSP is deliberately *not* set here: this process serves JSON, and the Next.js
 * app sets its own policy for the documents that actually execute scripts. A CSP
 * on an API response protects nothing and invites a false sense of coverage.
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: false,
  // The API is called cross-origin by the web app; the default `same-origin`
  // policy would break legitimate resource reads.
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // HSTS only matters over TLS and is set by the terminating proxy in dev.
  hsts: config.isProd ? { maxAge: 31_536_000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'no-referrer' },
});

/**
 * CORS against an explicit allowlist.
 *
 * `credentials: true` requires an exact origin echo — the wildcard is rejected
 * by browsers in that mode, so an allowlist is mandatory rather than optional.
 */
const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // No Origin header: same-origin navigation, curl, or a server-to-server
    // call. Nothing to enforce, and blocking it would break health checks.
    if (!origin) {
      callback(null, true);
      return;
    }
    if (config.server.corsOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    log.warn({ origin }, 'Blocked cross-origin request from unlisted origin');
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  maxAge: 86_400,
};

export const corsMiddleware = cors(corsOptions);

/** Methods that cannot change state, so they need no CSRF check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF protection by origin verification.
 *
 * This API is cookie-free by design — `modules/auth/routes.ts` returns the
 * refresh token in the JSON body, and the web app sets its own `httpOnly` cookie
 * from its own route handler on its own origin. So in the current design *every*
 * state-changing request presents either a bearer token or an API key, and both
 * are exempt below: neither is an ambient credential a browser would attach on
 * its own, which is the precondition a CSRF attack needs.
 *
 * The check is therefore defence in depth rather than load-bearing today. It is
 * kept, and applied to the whole API, because the failure mode it guards is
 * silent: the day a session cookie is introduced — for SSE, for a webhook
 * console, for anything — the protection is already in place instead of being
 * remembered. A request with no bearer token and no API key is by definition
 * relying on something ambient, and that is exactly what gets verified.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }

  // Bearer-authenticated calls are not CSRF-able (see above).
  const auth = req.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    next();
    return;
  }

  // API-key clients are server-to-server and send no browser cookies.
  if (req.get('x-api-key')) {
    next();
    return;
  }

  const origin = req.get('origin');
  const referer = req.get('referer');
  const source = origin ?? referer;

  if (!source) {
    // A state-changing request from a browser always carries one of these. Its
    // absence means a non-browser client, which should be presenting a bearer
    // token or an API key — both handled above.
    log.warn(
      { method: req.method, path: req.path, requestId: req.id },
      'Rejected state-changing request with no credential and no Origin or Referer',
    );
    next(new ForbiddenError('Missing Origin header on a state-changing request'));
    return;
  }

  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(source).origin;
  } catch {
    next(new ForbiddenError('Malformed Origin header'));
    return;
  }

  if (!config.server.corsOrigins.includes(sourceOrigin)) {
    log.warn(
      { sourceOrigin, method: req.method, path: req.path, requestId: req.id },
      'Rejected cross-site state-changing request',
    );
    next(new ForbiddenError('Cross-site request rejected'));
    return;
  }

  next();
}
