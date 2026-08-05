/**
 * Zod contracts for every mutating / parameterised endpoint.
 *
 * The API validates with these in `validate()` middleware; the web app reuses
 * them for form validation. One definition, two enforcement points.
 */

import { z } from 'zod';
import { TIMEFRAMES } from '../types/market.js';
import { USER_ROLES } from '../types/user.js';
import { AI_PROVIDERS, SUPPORTED_IMAGE_MIME, NOTIFICATION_CHANNELS } from '../types/intel.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const timeframeSchema = z.enum(TIMEFRAMES);
export const userRoleSchema = z.enum(USER_ROLES);
export const aiProviderSchema = z.enum(AI_PROVIDERS);

/**
 * Symbols are uppercase alphanumerics with optional `.`/`-`/`_` separators.
 * Deliberately strict: this value reaches provider URLs and cache keys.
 */
export const symbolSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(1)
  .max(24)
  .regex(/^[A-Z0-9][A-Z0-9._-]*$/, 'Invalid symbol format');

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters')
  .max(128)
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[0-9]/, 'Must contain a number');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(64),
  timezone: z.string().max(64).default('UTC'),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(2048),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailSchema });

export const resetPasswordSchema = z.object({
  token: z.string().min(16).max(512),
  newPassword: passwordSchema,
});

// ---------------------------------------------------------------------------
// Market data
// ---------------------------------------------------------------------------

export const candlesQuerySchema = z.object({
  timeframe: timeframeSchema.default('1h'),
  limit: z.coerce.number().int().min(10).max(1500).default(300),
  /** Epoch ms. When set, returns bars strictly before this time. */
  before: z.coerce.number().int().positive().optional(),
});

export const quotesQuerySchema = z.object({
  /** Comma-separated symbol list. */
  symbols: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean))
    .pipe(z.array(symbolSchema).min(1).max(50)),
});

export const symbolParamSchema = z.object({ symbol: symbolSchema });

// ---------------------------------------------------------------------------
// Analysis & signals
// ---------------------------------------------------------------------------

export const analysisQuerySchema = z.object({
  timeframe: timeframeSchema.default('1h'),
  /** Include multi-timeframe confirmation (slower, more provider calls). */
  mtf: z.coerce.boolean().default(true),
  /** Include correlation matrix. */
  correlations: z.coerce.boolean().default(false),
  lookback: z.coerce.number().int().min(100).max(1000).default(400),
});

export const generateSignalSchema = z.object({
  symbol: symbolSchema,
  timeframe: timeframeSchema.default('1h'),
  /** Skip the LLM and return the deterministic engine's verdict only. */
  deterministicOnly: z.boolean().default(false),
  /** Per-request override; still clamped to the global engine minimum. */
  minConfidence: z.number().min(0).max(100).optional(),
});

export const signalListQuerySchema = paginationSchema.extend({
  symbol: symbolSchema.optional(),
  action: z.enum(['BUY', 'SELL', 'WAIT']).optional(),
  status: z
    .enum([
      'active',
      'triggered',
      'tp1_hit',
      'tp2_hit',
      'tp3_hit',
      'stopped_out',
      'expired',
      'invalidated',
      'cancelled',
    ])
    .optional(),
  timeframe: timeframeSchema.optional(),
  minConfidence: z.coerce.number().min(0).max(100).optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Image analysis
// ---------------------------------------------------------------------------

export const imageAnalysisSchema = z.object({
  userNote: z.string().trim().max(1000).optional(),
  /** Optional hints that measurably improve vision accuracy. */
  symbolHint: symbolSchema.optional(),
  timeframeHint: timeframeSchema.optional(),
});

export const imageMimeSchema = z.enum(SUPPORTED_IMAGE_MIME);

// ---------------------------------------------------------------------------
// Risk & portfolio
// ---------------------------------------------------------------------------

export const positionSizeSchema = z
  .object({
    accountBalance: z.number().positive().max(1e12),
    riskPercent: z.number().positive().max(100),
    entryPrice: z.number().positive(),
    stopLoss: z.number().positive(),
    symbol: symbolSchema,
  })
  .refine((v) => v.entryPrice !== v.stopLoss, {
    message: 'Stop loss must differ from entry price',
    path: ['stopLoss'],
  });

export const createTradeSchema = z
  .object({
    symbol: symbolSchema,
    side: z.enum(['long', 'short']),
    entryPrice: z.number().positive(),
    quantity: z.number().positive(),
    stopLoss: z.number().positive().nullable().optional(),
    takeProfit: z.number().positive().nullable().optional(),
    openedAt: z.number().int().positive().optional(),
    signalId: z.string().uuid().nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  })
  .refine(
    (v) =>
      v.stopLoss == null ||
      (v.side === 'long' ? v.stopLoss < v.entryPrice : v.stopLoss > v.entryPrice),
    { message: 'Stop loss must be on the losing side of entry', path: ['stopLoss'] },
  );

export const closeTradeSchema = z.object({
  exitPrice: z.number().positive(),
  closedAt: z.number().int().positive().optional(),
  fees: z.number().min(0).default(0),
  notes: z.string().max(5000).nullable().optional(),
  executionRating: z.number().int().min(1).max(5).nullable().optional(),
});

export const updateTradeSchema = z.object({
  stopLoss: z.number().positive().nullable().optional(),
  takeProfit: z.number().positive().nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  executionRating: z.number().int().min(1).max(5).nullable().optional(),
});

// ---------------------------------------------------------------------------
// Preferences & notifications
// ---------------------------------------------------------------------------

export const notificationChannelSchema = z.enum(NOTIFICATION_CHANNELS);

export const updatePreferencesSchema = z.object({
  minSignalConfidence: z.number().min(0).max(100).optional(),
  notifyMinConfidence: z.number().min(0).max(100).optional(),
  watchlist: z.array(symbolSchema).max(100).optional(),
  defaultTimeframe: timeframeSchema.optional(),
  riskPerTradePercent: z.number().positive().max(100).optional(),
  maxDailyRiskPercent: z.number().positive().max(100).optional(),
  maxWeeklyRiskPercent: z.number().positive().max(100).optional(),
  maxConcurrentTrades: z.number().int().min(1).max(100).optional(),
  accountBalance: z.number().min(0).max(1e12).optional(),
  accountCurrency: z.string().length(3).toUpperCase().optional(),
  channels: z
    .object({
      email: z.object({ enabled: z.boolean(), address: emailSchema.nullable() }).optional(),
      telegram: z
        .object({ enabled: z.boolean(), chatId: z.string().max(64).nullable() })
        .optional(),
      discord: z
        .object({ enabled: z.boolean(), webhookUrl: z.string().url().max(512).nullable() })
        .optional(),
      webPush: z.object({ enabled: z.boolean() }).optional(),
      quietHours: z
        .object({
          start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        })
        .nullable()
        .optional(),
    })
    .optional(),
});

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().url().max(1024),
  keys: z.object({
    p256dh: z.string().min(1).max(256),
    auth: z.string().min(1).max(256),
  }),
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export const updateAiSettingsSchema = z.object({
  activeProvider: aiProviderSchema.optional(),
  models: z.record(aiProviderSchema, z.string().max(128)).optional(),
  visionModels: z.record(aiProviderSchema, z.string().max(128)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(256).max(32000).optional(),
  fallbackChain: z.array(aiProviderSchema).max(4).optional(),
  dailyQuota: z.record(z.string(), z.number().int().min(0)).optional(),
  aiEnabled: z.boolean().optional(),
});

export const updateSignalConfigSchema = z.object({
  minConfidence: z.number().min(0).max(100).optional(),
  notifyMinConfidence: z.number().min(0).max(100).optional(),
  minRiskReward: z.number().min(0).max(20).optional(),
  minMtfAlignment: z.number().min(0).max(100).optional(),
  maxSignalsPerSymbolPerDay: z.number().int().min(1).max(100).optional(),
  lookbackBars: z.number().int().min(100).max(1000).optional(),
  mtfTimeframes: z.array(timeframeSchema).min(1).max(5).optional(),
  requireSmcConfluence: z.boolean().optional(),
  categoryWeights: z
    .record(
      z.enum([
        'trend',
        'momentum',
        'structure',
        'volume',
        'volatility',
        'levels',
        'sentiment',
        'derivatives',
      ]),
      z.number().min(0).max(5),
    )
    .optional(),
});

export const adminUpdateUserSchema = z.object({
  role: userRoleSchema.optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().trim().min(2).max(64).optional(),
  emailVerified: z.boolean().optional(),
});

export const adminListUsersSchema = paginationSchema.extend({
  search: z.string().trim().max(128).optional(),
  role: userRoleSchema.optional(),
  isActive: z.coerce.boolean().optional(),
});

export const upsertMarketSchema = z.object({
  symbol: symbolSchema,
  name: z.string().trim().min(1).max(96),
  assetClass: z.enum(['crypto', 'forex', 'stock', 'index', 'commodity']),
  base: z.string().trim().toUpperCase().min(1).max(12),
  quote: z.string().trim().toUpperCase().min(1).max(12),
  pricePrecision: z.number().int().min(0).max(12),
  tickSize: z.number().positive(),
  contractSize: z.number().positive(),
  tradingViewSymbol: z.string().trim().min(1).max(64),
  scanEnabled: z.boolean().default(true),
  displayOrder: z.number().int().min(0).max(9999).default(100),
});

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(64),
  scopes: z.array(z.string().max(64)).max(20).default(['read']),
  expiresInDays: z.number().int().min(1).max(3650).nullable().default(null),
});

export const auditLogQuerySchema = paginationSchema.extend({
  action: z.string().max(64).optional(),
  userId: z.string().uuid().optional(),
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export const newsQuerySchema = paginationSchema.extend({
  symbol: symbolSchema.optional(),
  sentiment: z.enum(['bullish', 'bearish', 'neutral']).optional(),
  impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  hours: z.coerce.number().int().min(1).max(720).default(48),
});

export const calendarQuerySchema = z.object({
  from: z.coerce.number().int().positive().optional(),
  to: z.coerce.number().int().positive().optional(),
  impact: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
});

// ---------------------------------------------------------------------------
// Inferred input types
// ---------------------------------------------------------------------------

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CandlesQuery = z.infer<typeof candlesQuerySchema>;
export type AnalysisQuery = z.infer<typeof analysisQuerySchema>;
export type GenerateSignalInput = z.infer<typeof generateSignalSchema>;
export type SignalListQuery = z.infer<typeof signalListQuerySchema>;
export type PositionSizeInput = z.infer<typeof positionSizeSchema>;
export type CreateTradeInput = z.infer<typeof createTradeSchema>;
export type CloseTradeInput = z.infer<typeof closeTradeSchema>;
export type UpdateTradeInput = z.infer<typeof updateTradeSchema>;
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;
export type UpdateSignalConfigInput = z.infer<typeof updateSignalConfigSchema>;
export type UpsertMarketInput = z.infer<typeof upsertMarketSchema>;
export type NewsQuery = z.infer<typeof newsQuerySchema>;
export type ImageAnalysisInput = z.infer<typeof imageAnalysisSchema>;
