/**
 * Environment configuration.
 *
 * Parsed and validated once at boot. A malformed environment fails fast with a
 * readable report rather than surfacing as a confusing runtime error later.
 *
 * Provider credentials are intentionally optional — the platform registers only
 * what is configured and degrades gracefully (see providers/market/registry.ts).
 */

import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

// Load .env from the repo root so a single file serves both apps in dev.
loadDotenv({ path: resolve(process.cwd(), '../../.env') });
loadDotenv();

/** Coerce common truthy spellings; default when unset/blank. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return def;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

/** Optional string that normalises blank to undefined. */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
  CORS_EXTRA_ORIGINS: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [])),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: boolish(false),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),

  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
  REDIS_KEY_PREFIX: z.string().default('qd:'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be >= 32 chars'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be >= 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(20).default(12),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).default(60_000),
  RATE_LIMIT_MAX_FREE: z.coerce.number().int().min(1).default(60),
  RATE_LIMIT_MAX_PREMIUM: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_MAX_ADMIN: z.coerce.number().int().min(1).default(2000),
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().min(1).default(10),

  MARKET_BINANCE_ENABLED: boolish(true),
  MARKET_BINANCE_BASE_URL: z.string().url().default('https://api.binance.com'),
  MARKET_BINANCE_WS_URL: z.string().default('wss://stream.binance.com:9443/ws'),
  MARKET_BYBIT_ENABLED: boolish(true),
  MARKET_BYBIT_BASE_URL: z.string().url().default('https://api.bybit.com'),
  MARKET_COINBASE_ENABLED: boolish(false),
  MARKET_COINBASE_BASE_URL: z.string().url().default('https://api.exchange.coinbase.com'),
  MARKET_TWELVEDATA_API_KEY: optionalStr,
  MARKET_FINNHUB_API_KEY: optionalStr,
  MARKET_POLYGON_API_KEY: optionalStr,
  MARKET_ALPHAVANTAGE_API_KEY: optionalStr,
  MARKET_ALLOW_SYNTHETIC: boolish(true),

  AI_DEFAULT_PROVIDER: z.enum(['anthropic', 'openai', 'gemini', 'local']).default('anthropic'),
  ANTHROPIC_API_KEY: optionalStr,
  // Model IDs are complete as written — never append a date suffix.
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  // The same model reads charts; there is no separate vision endpoint.
  ANTHROPIC_VISION_MODEL: z.string().default('claude-opus-5'),
  OPENAI_API_KEY: optionalStr,
  OPENAI_MODEL: z.string().default('gpt-4.1'),
  OPENAI_VISION_MODEL: z.string().default('gpt-4.1'),
  GEMINI_API_KEY: optionalStr,
  GEMINI_MODEL: z.string().default('gemini-2.0-flash'),
  GEMINI_VISION_MODEL: z.string().default('gemini-2.0-flash'),
  LOCAL_LLM_BASE_URL: optionalStr,
  LOCAL_LLM_MODEL: z.string().default('llama3.1:8b'),
  LOCAL_LLM_API_KEY: z.string().default('not-needed'),

  NEWS_CRYPTOPANIC_TOKEN: optionalStr,
  NEWS_FINNHUB_ENABLED: boolish(true),
  FEAR_GREED_ENABLED: boolish(true),

  TELEGRAM_BOT_TOKEN: optionalStr,
  DISCORD_WEBHOOK_URL: optionalStr,
  SMTP_HOST: optionalStr,
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_SECURE: boolish(false),
  SMTP_USER: optionalStr,
  SMTP_PASS: optionalStr,
  SMTP_FROM: z.string().default('QuantDesk <no-reply@quantdesk.local>'),
  VAPID_PUBLIC_KEY: optionalStr,
  VAPID_PRIVATE_KEY: optionalStr,
  VAPID_SUBJECT: z.string().default('mailto:admin@quantdesk.local'),

  SIGNAL_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(65),
  SIGNAL_NOTIFY_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(78),
  SIGNAL_SCAN_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  SIGNAL_MAX_PER_SYMBOL_PER_DAY: z.coerce.number().int().min(1).default(6),

  // Background jobs. Off by default in tests, where a scan firing mid-assertion
  // would make failures depend on timing.
  SCHEDULER_ENABLED: boolish(true),
  RETENTION_SIGNAL_DAYS: z.coerce.number().int().min(7).max(3650).default(365),
  RETENTION_IMAGE_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  RETENTION_NOTIFICATION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),

  UPLOAD_DIR: z.string().default('./storage/uploads'),
  UPLOAD_MAX_BYTES: z.coerce.number().int().min(1024).default(10 * 1024 * 1024),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // Deliberately console.error: the logger depends on this module.
  console.error(`\n✖ Invalid environment configuration:\n${issues}\n`);
  console.error('Copy .env.example to .env and fill in the required values.\n');
  process.exit(1);
}

const env = parsed.data;

/**
 * Structured, namespaced view of the environment.
 * Prefer importing this over touching `process.env` anywhere else.
 */
export const config = {
  env: env.NODE_ENV,
  isProd: env.NODE_ENV === 'production',
  isDev: env.NODE_ENV === 'development',
  isTest: env.NODE_ENV === 'test',

  server: {
    port: env.API_PORT,
    host: env.API_HOST,
    webOrigin: env.WEB_ORIGIN,
    corsOrigins: [env.WEB_ORIGIN, ...env.CORS_EXTRA_ORIGINS],
    trustProxy: env.TRUST_PROXY,
  },

  db: {
    url: env.DATABASE_URL,
    ssl: env.DATABASE_SSL,
    poolMax: env.DATABASE_POOL_MAX,
  },

  redis: {
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
  },

  auth: {
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtl: env.JWT_ACCESS_TTL,
    refreshTtl: env.JWT_REFRESH_TTL,
    encryptionKey: Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    bcryptRounds: env.BCRYPT_ROUNDS,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    free: env.RATE_LIMIT_MAX_FREE,
    premium: env.RATE_LIMIT_MAX_PREMIUM,
    admin: env.RATE_LIMIT_MAX_ADMIN,
    auth: env.RATE_LIMIT_MAX_AUTH,
  },

  market: {
    binance: {
      enabled: env.MARKET_BINANCE_ENABLED,
      baseUrl: env.MARKET_BINANCE_BASE_URL,
      wsUrl: env.MARKET_BINANCE_WS_URL,
    },
    bybit: { enabled: env.MARKET_BYBIT_ENABLED, baseUrl: env.MARKET_BYBIT_BASE_URL },
    coinbase: { enabled: env.MARKET_COINBASE_ENABLED, baseUrl: env.MARKET_COINBASE_BASE_URL },
    twelveData: { apiKey: env.MARKET_TWELVEDATA_API_KEY },
    finnhub: { apiKey: env.MARKET_FINNHUB_API_KEY },
    polygon: { apiKey: env.MARKET_POLYGON_API_KEY },
    alphaVantage: { apiKey: env.MARKET_ALPHAVANTAGE_API_KEY },
    allowSynthetic: env.MARKET_ALLOW_SYNTHETIC,
  },

  ai: {
    defaultProvider: env.AI_DEFAULT_PROVIDER,
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
      model: env.ANTHROPIC_MODEL,
      visionModel: env.ANTHROPIC_VISION_MODEL,
    },
    openai: {
      apiKey: env.OPENAI_API_KEY,
      model: env.OPENAI_MODEL,
      visionModel: env.OPENAI_VISION_MODEL,
    },
    gemini: {
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      visionModel: env.GEMINI_VISION_MODEL,
    },
    local: {
      baseUrl: env.LOCAL_LLM_BASE_URL,
      model: env.LOCAL_LLM_MODEL,
      apiKey: env.LOCAL_LLM_API_KEY,
    },
  },

  news: {
    cryptoPanicToken: env.NEWS_CRYPTOPANIC_TOKEN,
    finnhubEnabled: env.NEWS_FINNHUB_ENABLED,
    fearGreedEnabled: env.FEAR_GREED_ENABLED,
  },

  notifications: {
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    smtp: {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      from: env.SMTP_FROM,
    },
    vapid: {
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY,
      subject: env.VAPID_SUBJECT,
    },
  },

  signals: {
    minConfidence: env.SIGNAL_MIN_CONFIDENCE,
    notifyMinConfidence: env.SIGNAL_NOTIFY_MIN_CONFIDENCE,
    scanIntervalMs: env.SIGNAL_SCAN_INTERVAL_MS,
    maxPerSymbolPerDay: env.SIGNAL_MAX_PER_SYMBOL_PER_DAY,
  },

  scheduler: {
    // A deployment can run API replicas with this off and one worker with it on.
    // The Redis lock in `scheduler.ts` makes that unnecessary for correctness,
    // but an operator who wants the separation should not have to fight for it.
    enabled: env.SCHEDULER_ENABLED && env.NODE_ENV !== 'test',
    retention: {
      signalDays: env.RETENTION_SIGNAL_DAYS,
      imageDays: env.RETENTION_IMAGE_DAYS,
      notificationDays: env.RETENTION_NOTIFICATION_DAYS,
    },
  },

  uploads: {
    dir: resolve(process.cwd(), env.UPLOAD_DIR),
    maxBytes: env.UPLOAD_MAX_BYTES,
  },

  logLevel: env.LOG_LEVEL,
} as const;

export type AppConfig = typeof config;

/**
 * Production safety net: refuse to boot with development placeholder secrets.
 * A leaked default signing key is a full authentication bypass.
 */
if (config.isProd) {
  const weak: string[] = [];
  if (env.JWT_ACCESS_SECRET.includes('change-me')) weak.push('JWT_ACCESS_SECRET');
  if (env.JWT_REFRESH_SECRET.includes('change-me')) weak.push('JWT_REFRESH_SECRET');
  if (/^0+$/.test(env.ENCRYPTION_KEY)) weak.push('ENCRYPTION_KEY');
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    weak.push('JWT_ACCESS_SECRET/JWT_REFRESH_SECRET must differ');
  }
  if (weak.length > 0) {
    console.error(
      `\n✖ Refusing to start in production with placeholder secrets: ${weak.join(', ')}\n` +
        '  Generate real values:  openssl rand -hex 64\n',
    );
    process.exit(1);
  }
}
