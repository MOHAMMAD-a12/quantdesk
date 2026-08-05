/**
 * Audit trail.
 *
 * Records privileged and security-relevant actions: authentication events, API
 * key lifecycle, admin changes to settings and providers.
 *
 * **Auditing never fails the operation it is auditing.** A write to `audit_log`
 * that errors is logged and swallowed, because refusing a successful password
 * change on the grounds that we could not record it would be a worse outcome
 * than an incomplete log. The trade-off is explicit: the log is best-effort, the
 * action is authoritative.
 */

import type { Request } from 'express';
import { query } from '../db/pool.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('audit');

/** Canonical action names. Strings are free-form, but reusing these keeps the
 *  admin panel's filter list meaningful. */
export const AUDIT_ACTIONS = {
  authRegister: 'auth.register',
  authLogin: 'auth.login',
  authLoginFailed: 'auth.login_failed',
  authLogout: 'auth.logout',
  authLogoutAll: 'auth.logout_all',
  authRefresh: 'auth.refresh',
  authRefreshReuse: 'auth.refresh_reuse_detected',
  authPasswordChanged: 'auth.password_changed',
  authPasswordResetRequested: 'auth.password_reset_requested',
  authPasswordResetCompleted: 'auth.password_reset_completed',
  apiKeyCreated: 'api_key.created',
  apiKeyRevoked: 'api_key.revoked',
  userRoleChanged: 'user.role_changed',
  userDeactivated: 'user.deactivated',
  userActivated: 'user.activated',
  settingsUpdated: 'settings.updated',
  providerCredentialUpdated: 'provider.credential_updated',
} as const;

export interface AuditInput {
  action: string;
  userId?: string | null;
  actorEmail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Extract the client fingerprint from a request.
 *
 * `req.ip` honours the configured trust-proxy depth; taking `X-Forwarded-For`
 * directly would let any caller write an arbitrary address into the audit log,
 * which is worse than having none.
 */
export function requestFingerprint(req: Request): { ipAddress: string | null; userAgent: string | null } {
  return {
    ipAddress: req.ip ?? null,
    // The column is unbounded TEXT but a 4KB user-agent is an abuse vector.
    userAgent: req.get('user-agent')?.slice(0, 512) ?? null,
  };
}

/** Write one audit row. Never throws. */
export async function recordAudit(entry: AuditInput): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log
         (user_id, actor_email, action, resource_type, resource_id, metadata, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        entry.userId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.resourceType ?? null,
        entry.resourceId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ipAddress ?? null,
        entry.userAgent ?? null,
      ],
    );
  } catch (err) {
    log.error({ err, action: entry.action }, 'Failed to write audit entry');
  }
}

/** Convenience wrapper that pulls IP and user-agent off the request. */
export async function auditRequest(
  req: Request,
  entry: Omit<AuditInput, 'ipAddress' | 'userAgent'>,
): Promise<void> {
  await recordAudit({ ...entry, ...requestFingerprint(req) });
}
