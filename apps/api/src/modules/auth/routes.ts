/**
 * Authentication routes.
 *
 * Every credential endpoint is behind `authRateLimit`, which is keyed by IP
 * regardless of authentication state — the threat is an unauthenticated attacker
 * grinding passwords or reset tokens, so a per-user key would be useless here.
 *
 * Refresh tokens are returned in the JSON body rather than set as a cookie. The
 * web client stores the access token in memory and the refresh token in a
 * `httpOnly` cookie it sets itself via its own route handler; keeping the API
 * cookie-free means the same endpoints serve the browser, a mobile client and
 * `curl` without a CSRF story that differs per caller. The CSRF middleware still
 * guards any cookie-authenticated surface.
 */

import { Router } from 'express';
import {
  changePasswordSchema,
  createApiKeySchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
} from '@quantdesk/shared';
import { AUDIT_ACTIONS, auditRequest, requestFingerprint } from '../../core/audit.js';
import { config } from '../../core/config.js';
import { generateApiKey } from '../../core/crypto.js';
import { NotFoundError } from '../../core/errors.js';
import { created, noContent, ok } from '../../core/http.js';
import { isMailerConfigured, sendMail } from '../../core/mailer.js';
import { moduleLogger } from '../../core/logger.js';
import { asyncHandler } from '../../middleware/error.js';
import { authRateLimit } from '../../middleware/rateLimit.js';
import { body, validate } from '../../middleware/validate.js';
import { authenticate, requireInteractiveSession } from './middleware.js';
import * as repo from './repository.js';
import * as service from './service.js';

const log = moduleLogger('auth:routes');

export const authRouter = Router();

/* -------------------------------------------------------------------------- */
/* Registration & login                                                       */
/* -------------------------------------------------------------------------- */

authRouter.post(
  '/register',
  authRateLimit,
  validate({ body: registerSchema }),
  asyncHandler(async (req, res) => {
    const input = body(req, registerSchema);
    const session = await service.register(input, requestFingerprint(req));
    created(res, session);
  }),
);

authRouter.post(
  '/login',
  authRateLimit,
  validate({ body: loginSchema }),
  asyncHandler(async (req, res) => {
    const input = body(req, loginSchema);
    const session = await service.login(input, requestFingerprint(req));
    ok(res, session);
  }),
);

/**
 * Rotate a refresh token.
 *
 * Rate limited like a credential endpoint because it is one — a valid refresh
 * token is a credential, and an attacker holding a stolen one should not be able
 * to mint access tokens without limit.
 */
authRouter.post(
  '/refresh',
  authRateLimit,
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const { refreshToken } = body(req, refreshSchema);
    const session = await service.refresh(refreshToken, requestFingerprint(req));
    ok(res, session);
  }),
);

/**
 * Log out one session.
 *
 * Deliberately unauthenticated: the refresh token *is* the authentication, and
 * requiring a live access token would make logout impossible once it expired —
 * exactly when a client most wants to discard its refresh token.
 */
authRouter.post(
  '/logout',
  validate({ body: refreshSchema }),
  asyncHandler(async (req, res) => {
    const { refreshToken } = body(req, refreshSchema);
    await service.logout(refreshToken, requestFingerprint(req));
    noContent(res);
  }),
);

authRouter.post(
  '/logout-all',
  authenticate,
  asyncHandler(async (req, res) => {
    const revoked = await service.logoutAll(req.user!.id, requestFingerprint(req));
    ok(res, { sessionsRevoked: revoked });
  }),
);

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    ok(res, await service.currentUser(req.user!.id));
  }),
);

/* -------------------------------------------------------------------------- */
/* Password management                                                        */
/* -------------------------------------------------------------------------- */

authRouter.post(
  '/change-password',
  authenticate,
  // An API key must not be able to take over the account it was issued from.
  requireInteractiveSession,
  authRateLimit,
  validate({ body: changePasswordSchema }),
  asyncHandler(async (req, res) => {
    const input = body(req, changePasswordSchema);
    const tokens = await service.changePassword(req.user!.id, input, requestFingerprint(req));
    ok(res, tokens);
  }),
);

/**
 * Request a password-reset link.
 *
 * Always answers 200 with the same body whether or not the address is
 * registered. Anything else — a different status, a different message, a
 * measurably different response time — turns this into an account-enumeration
 * endpoint.
 */
authRouter.post(
  '/forgot-password',
  authRateLimit,
  validate({ body: forgotPasswordSchema }),
  asyncHandler(async (req, res) => {
    const { email } = body(req, forgotPasswordSchema);
    const result = await service.requestPasswordReset(email, requestFingerprint(req));

    if (result.token && result.user) {
      const link = `${config.server.webOrigin}/reset-password?token=${encodeURIComponent(result.token)}`;

      const delivered = await sendMail({
        to: result.user.email,
        subject: 'Reset your QuantDesk password',
        text:
          `Hello ${result.user.displayName},\n\n` +
          `Use the link below to choose a new password. It expires in one hour and can be used once.\n\n` +
          `${link}\n\n` +
          `If you did not request this, no action is needed — your password has not changed.\n`,
      });

      if (!delivered) {
        // Without SMTP the link cannot reach the user. Log it in development so
        // the flow remains testable; in production this is a real misconfiguration
        // and is reported as such rather than silently swallowed.
        if (config.isProd || isMailerConfigured()) {
          log.error({ userId: result.user.id }, 'Password reset email could not be delivered');
        } else {
          log.warn({ resetLink: link }, 'SMTP not configured — reset link logged for development');
        }
      }
    }

    ok(res, {
      message: 'If an account exists for that address, a reset link has been sent.',
    });
  }),
);

authRouter.post(
  '/reset-password',
  authRateLimit,
  validate({ body: resetPasswordSchema }),
  asyncHandler(async (req, res) => {
    const input = body(req, resetPasswordSchema);
    await service.resetPassword(input, requestFingerprint(req));
    ok(res, { message: 'Password updated. Please sign in with your new password.' });
  }),
);

/* -------------------------------------------------------------------------- */
/* API keys                                                                   */
/* -------------------------------------------------------------------------- */

authRouter.get(
  '/api-keys',
  authenticate,
  asyncHandler(async (req, res) => {
    ok(res, await repo.listApiKeys(req.user!.id));
  }),
);

/**
 * Mint an API key.
 *
 * The plaintext key is in the response and nowhere else — only its SHA-256 and a
 * 12-character display prefix are stored. A user who loses it must issue a new
 * one, which is the correct trade for a credential that would otherwise sit
 * recoverable in the database.
 */
authRouter.post(
  '/api-keys',
  authenticate,
  requireInteractiveSession,
  validate({ body: createApiKeySchema }),
  asyncHandler(async (req, res) => {
    const input = body(req, createApiKeySchema);
    const { key, prefix, hash } = generateApiKey();

    const record = await repo.insertApiKey({
      userId: req.user!.id,
      name: input.name,
      prefix,
      keyHash: hash,
      scopes: input.scopes,
      expiresAt:
        input.expiresInDays === null
          ? null
          : Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
    });

    await auditRequest(req, {
      action: AUDIT_ACTIONS.apiKeyCreated,
      userId: req.user!.id,
      actorEmail: req.user!.email,
      resourceType: 'api_key',
      resourceId: record.id,
      metadata: { name: record.name, scopes: record.scopes },
    });

    created(res, { ...record, key });
  }),
);

authRouter.delete(
  '/api-keys/:id',
  authenticate,
  requireInteractiveSession,
  asyncHandler(async (req, res) => {
    const keyId = req.params.id;
    // Scoped to the caller's own keys in SQL, so a guessed id cannot revoke
    // someone else's credential.
    const revoked = keyId ? await repo.revokeApiKey(req.user!.id, keyId) : false;
    if (!revoked) throw new NotFoundError('API key');

    await auditRequest(req, {
      action: AUDIT_ACTIONS.apiKeyRevoked,
      userId: req.user!.id,
      actorEmail: req.user!.email,
      resourceType: 'api_key',
      resourceId: keyId ?? null,
    });

    noContent(res);
  }),
);
