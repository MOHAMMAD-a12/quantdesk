/**
 * Runtime platform settings.
 *
 * The signal engine's thresholds and the AI provider selection live in
 * `platform_settings` rather than in the environment, because the spec requires
 * changing them from the admin panel without a redeploy. Environment variables
 * seed the initial values; the database row is authoritative afterwards.
 *
 * Reads are cached in Redis for 60 seconds and written through on update, so a
 * change made in the admin panel takes effect on the next scan rather than in a
 * minute. The cache exists because the scanner reads this config once per symbol
 * per cycle and a settings table is not worth a query each time.
 *
 * **Stored values are validated on read, not trusted.** A row written by an older
 * version of the code, or hand-edited in psql, must not be able to hand the
 * engine a `minConfidence` of 900 or a missing category weight. Anything that
 * fails validation falls back to the defaults with a loud log.
 */

import type { AiSettings, ConfluenceFactor, SignalEngineConfig, Timeframe } from '@quantdesk/shared';
import { z } from 'zod';
import { AI_PROVIDERS, TIMEFRAMES } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { moduleLogger } from '../../core/logger.js';
import { query, queryOne } from '../../db/pool.js';
import { CacheKeys, CacheTtl, cacheDel, cacheWrap } from '../../db/redis.js';

const log = moduleLogger('settings');

export const SETTINGS_KEYS = {
  signalEngine: 'signal_engine',
  aiSettings: 'ai_settings',
} as const;

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const CATEGORIES: ReadonlyArray<ConfluenceFactor['category']> = [
  'trend',
  'momentum',
  'structure',
  'volume',
  'volatility',
  'levels',
  'sentiment',
  'derivatives',
];

/**
 * Category weights must cover every category and be positive.
 *
 * A missing key would make `scoreConfluence` weight that category at `undefined`
 * and silently drop a whole class of evidence; a zero or negative weight would
 * invert or erase it. Neither should be expressible.
 */
const categoryWeightsSchema = z
  .record(z.number().positive().max(10))
  .refine((weights) => CATEGORIES.every((c) => typeof weights[c] === 'number'), {
    message: 'Every confluence category must have a weight',
  })
  .transform((weights) => {
    const out = {} as Record<ConfluenceFactor['category'], number>;
    for (const category of CATEGORIES) out[category] = weights[category] as number;
    return out;
  });

const signalEngineSchema = z.object({
  minConfidence: z.number().min(0).max(100),
  notifyMinConfidence: z.number().min(0).max(100),
  minRiskReward: z.number().min(0.1).max(20),
  minMtfAlignment: z.number().min(0).max(100),
  maxSignalsPerSymbolPerDay: z.number().int().min(1).max(100),
  categoryWeights: categoryWeightsSchema,
  lookbackBars: z.number().int().min(100).max(1500),
  mtfTimeframes: z.array(z.enum(TIMEFRAMES)).min(1).max(8),
  requireSmcConfluence: z.boolean(),
});

const aiSettingsSchema = z.object({
  activeProvider: z.enum(AI_PROVIDERS),
  models: z.record(z.string().max(120)).default({}),
  visionModels: z.record(z.string().max(120)).default({}),
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(256).max(64_000),
  fallbackChain: z.array(z.enum(AI_PROVIDERS)).max(4).default([]),
  dailyQuota: z.record(z.number().int().min(0).max(1_000_000)).default({}),
  aiEnabled: z.boolean(),
  updatedAt: z.number().int().nonnegative(),
  updatedBy: z.string().uuid().nullable(),
});

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Defaults matching `db/seed.ts`.
 *
 * Duplicated deliberately: the seeder establishes the initial row, and this is
 * the in-memory fallback when the row is absent or corrupt. Sharing one constant
 * would couple boot-time provisioning to request-time degradation, and the two
 * want to change for different reasons.
 */
export function defaultSignalEngineConfig(): SignalEngineConfig {
  return {
    minConfidence: config.signals.minConfidence,
    notifyMinConfidence: config.signals.notifyMinConfidence,
    minRiskReward: 1.5,
    minMtfAlignment: 55,
    maxSignalsPerSymbolPerDay: config.signals.maxPerSymbolPerDay,
    categoryWeights: {
      trend: 1.0,
      momentum: 0.8,
      structure: 1.25,
      volume: 0.9,
      volatility: 0.6,
      levels: 1.0,
      sentiment: 0.4,
      derivatives: 0.6,
    },
    lookbackBars: 500,
    mtfTimeframes: ['15m', '1h', '4h', '1d'] as Timeframe[],
    requireSmcConfluence: false,
  };
}

export function defaultAiSettings(): AiSettings {
  return {
    activeProvider: config.ai.defaultProvider,
    models: {},
    visionModels: {},
    temperature: 0.2,
    maxTokens: 4096,
    fallbackChain: [],
    dailyQuota: { free: 10, premium: 200, admin: 1000 },
    aiEnabled: true,
    updatedAt: Date.now(),
    updatedBy: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Read / write                                                               */
/* -------------------------------------------------------------------------- */

async function readRaw(key: string): Promise<unknown> {
  const row = await queryOne<{ value: unknown }>(
    'SELECT value FROM platform_settings WHERE key = $1',
    [key],
  );
  return row?.value ?? null;
}

/**
 * The live signal engine configuration.
 *
 * Never throws. A platform that cannot read its thresholds should run on the
 * documented defaults, not stop producing signals.
 */
export async function getSignalEngineConfig(): Promise<SignalEngineConfig> {
  return cacheWrap(CacheKeys.signalConfig(), CacheTtl.settings, async () => {
    const raw = await readRaw(SETTINGS_KEYS.signalEngine);
    if (raw === null) return defaultSignalEngineConfig();

    const parsed = signalEngineSchema.safeParse(raw);
    if (!parsed.success) {
      log.error(
        { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        'Stored signal_engine settings are invalid — using defaults',
      );
      return defaultSignalEngineConfig();
    }
    return parsed.data;
  });
}

export async function getAiSettings(): Promise<AiSettings> {
  return cacheWrap(CacheKeys.aiSettings(), CacheTtl.settings, async () => {
    const raw = await readRaw(SETTINGS_KEYS.aiSettings);
    if (raw === null) return defaultAiSettings();

    const parsed = aiSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      log.error(
        { issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
        'Stored ai_settings are invalid — using defaults',
      );
      return defaultAiSettings();
    }
    return parsed.data as AiSettings;
  });
}

/**
 * Apply a partial update to the signal engine config.
 *
 * Read-merge-validate-write rather than a JSONB path update, so a patch is
 * validated against the *whole* resulting object. Setting `minConfidence` above
 * `notifyMinConfidence` is individually valid and jointly nonsense, and only a
 * whole-object check catches that.
 */
export async function updateSignalEngineConfig(
  patch: Partial<Omit<SignalEngineConfig, 'categoryWeights'>> & {
    categoryWeights?: Partial<Record<ConfluenceFactor['category'], number>>;
  },
  updatedBy: string,
): Promise<SignalEngineConfig> {
  const current = await getSignalEngineConfig();
  const merged = {
    ...current,
    ...patch,
    categoryWeights: { ...current.categoryWeights, ...(patch.categoryWeights ?? {}) },
  };

  const parsed = signalEngineSchema.parse(merged);

  // A notify threshold below the surfacing threshold would notify on signals the
  // UI does not consider actionable. Clamped rather than rejected: the operator's
  // intent is clear and refusing the write would be pedantic.
  if (parsed.notifyMinConfidence < parsed.minConfidence) {
    parsed.notifyMinConfidence = parsed.minConfidence;
  }

  await writeSetting(SETTINGS_KEYS.signalEngine, parsed, updatedBy);
  await cacheDel(CacheKeys.signalConfig());
  return parsed;
}

export async function updateAiSettings(
  patch: Partial<AiSettings>,
  updatedBy: string,
): Promise<AiSettings> {
  const current = await getAiSettings();
  const merged: AiSettings = {
    ...current,
    ...patch,
    models: { ...current.models, ...(patch.models ?? {}) },
    visionModels: { ...current.visionModels, ...(patch.visionModels ?? {}) },
    dailyQuota: { ...current.dailyQuota, ...(patch.dailyQuota ?? {}) },
    updatedAt: Date.now(),
    updatedBy,
  };

  const parsed = aiSettingsSchema.parse(merged) as AiSettings;

  // The active provider must not appear in its own fallback chain — retrying the
  // provider that just failed wastes a request and delays the real fallback.
  parsed.fallbackChain = parsed.fallbackChain.filter((p) => p !== parsed.activeProvider);

  await writeSetting(SETTINGS_KEYS.aiSettings, parsed, updatedBy);
  await cacheDel(CacheKeys.aiSettings());
  return parsed;
}

async function writeSetting(key: string, value: unknown, updatedBy: string): Promise<void> {
  await query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, $3, now())
     ON CONFLICT (key) DO UPDATE SET
       value      = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [key, JSON.stringify(value), updatedBy],
  );
}

/** Drop cached settings — called after a direct database change or a restore. */
export async function invalidateSettingsCache(): Promise<void> {
  await cacheDel(CacheKeys.signalConfig(), CacheKeys.aiSettings());
}
