/**
 * The auth module.
 *
 *   tokens      JWT signing/verification — no I/O
 *   repository  all SQL for users, sessions, reset tokens and API keys
 *   service     policy: what login, refresh, rotation and reset mean
 *   middleware  request-time credential resolution and role gates
 *   routes      HTTP surface
 *
 * Other modules should import the middleware and, where they need to read an
 * identity, `findUserById`. They should not reach into `service` — the policy
 * here assumes it is called from the auth routes with a request fingerprint.
 */

export { authRouter } from './routes.js';
export {
  assertOwnership,
  authenticate,
  optionalAuth,
  requireAdmin,
  requireInteractiveSession,
  requireRole,
  requireScope,
} from './middleware.js';
export {
  findApiKeyPrincipal,
  findUserByEmail,
  findUserById,
  mapUser,
  pruneSessions,
  revokeAllSessions,
  withSubscription,
} from './repository.js';
export { accessTokenTtlSeconds, verifyAccessToken } from './tokens.js';
export { currentUser } from './service.js';
