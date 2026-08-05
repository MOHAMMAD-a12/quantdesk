/**
 * User, authentication and authorisation types.
 */

/** Roles are hierarchical: admin ⊃ premium ⊃ free. */
export const USER_ROLES = ['free', 'premium', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Numeric rank enables `rank(user) >= rank(required)` checks. */
export const ROLE_RANK: Record<UserRole, number> = {
  free: 0,
  premium: 1,
  admin: 2,
};

export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';

export interface Subscription {
  id: string;
  userId: string;
  plan: UserRole;
  status: SubscriptionStatus;
  startedAt: number;
  /** Null for lifetime/free plans. */
  expiresAt: number | null;
  cancelledAt: number | null;
  /** External billing reference, e.g. Stripe subscription id. */
  externalRef: string | null;
}

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  emailVerified: boolean;
  isActive: boolean;
  avatarUrl: string | null;
  timezone: string;
  createdAt: number;
  lastLoginAt: number | null;
  subscription?: Subscription | null;
}

/** Per-user tunables. */
export interface UserPreferences {
  userId: string;
  /** Overrides the global engine threshold, clamped to >= global minimum. */
  minSignalConfidence: number;
  notifyMinConfidence: number;
  /** Symbols the user wants scanned & notified on. */
  watchlist: string[];
  defaultTimeframe: string;
  /** Account risk per trade, as a percentage, e.g. 1.0. */
  riskPerTradePercent: number;
  maxDailyRiskPercent: number;
  maxWeeklyRiskPercent: number;
  maxConcurrentTrades: number;
  accountBalance: number;
  accountCurrency: string;
  channels: NotificationChannelSettings;
}

export interface NotificationChannelSettings {
  email: { enabled: boolean; address: string | null };
  telegram: { enabled: boolean; chatId: string | null };
  discord: { enabled: boolean; webhookUrl: string | null };
  webPush: { enabled: boolean };
  /** Quiet hours in the user's timezone, 24h clock. Null disables. */
  quietHours: { start: string; end: string } | null;
}

/** JWT access-token payload. */
export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: UserRole;
  /** Token type discriminator — refresh tokens must never pass as access. */
  typ: 'access';
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  sub: string;
  /** Opaque id of the persisted session row, so it can be revoked. */
  sid: string;
  typ: 'refresh';
  iat: number;
  exp: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: 'Bearer';
}

export interface AuthSession {
  user: User;
  tokens: AuthTokens;
}

/** Audit log entry — every privileged action is recorded. */
export interface AuditLogEntry {
  id: string;
  userId: string | null;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: number;
}

/** Programmatic API key issued to a user. */
export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  /** First 8 chars, for display. The full key is never stored or returned. */
  prefix: string;
  scopes: string[];
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
}
