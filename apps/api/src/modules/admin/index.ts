/**
 * The admin module — operator controls.
 *
 * The router is the whole public surface. Nothing else in the platform imports
 * from here: admin functionality that another module needed would be a sign the
 * capability belongs in that module with its own authorisation, not that this one
 * should be reached into.
 *
 * The repository is exported for the scheduler, which reports platform statistics
 * in its heartbeat log.
 */

export { adminRouter } from './routes.js';

export {
  activitySeries,
  aiUsage,
  auditActions,
  deleteSymbol,
  listAudit,
  listUsers,
  platformStats,
  updateUser,
  upsertSymbol,
  type AdminUserPatch,
  type AiUsageSummary,
  type AuditFilter,
  type PlatformStats,
  type UpsertSymbolInput,
  type UserFilter,
} from './repository.js';
