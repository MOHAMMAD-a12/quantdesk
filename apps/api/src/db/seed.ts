/**
 * Idempotent seeder.
 *
 * Establishes the bootstrap state the platform needs to be usable: the market
 * universe, the admin-editable settings rows, and a first administrator.
 *
 * Every write is an UPSERT, so running this repeatedly is safe. Crucially it is
 * *non-destructive*: operator edits made through the admin panel are preserved.
 * Market rows only refresh immutable descriptive fields (name, precision,
 * TradingView ticker) and deliberately leave `scan_enabled`,
 * `preferred_provider` and `display_order` alone once a row exists — those are
 * operator decisions, not defaults to be overwritten on every deploy.
 *
 * This seeds *configuration*, never market data. No prices, candles, signals or
 * news are fabricated here; those only ever come from a configured provider.
 */

import { DEFAULT_MARKETS, type SignalEngineConfig, type AiSettings } from '@quantdesk/shared';
import bcrypt from 'bcryptjs';
import { config } from '../core/config.js';
import { moduleLogger } from '../core/logger.js';
import { closeDatabase, query, transaction } from './pool.js';

const log = moduleLogger('db:seed');

/**
 * Default engine configuration, written to `platform_settings` so the admin
 * panel can tune it at runtime without a redeploy. Env values seed the initial
 * thresholds; the DB row is authoritative from then on.
 */
function defaultSignalConfig(): SignalEngineConfig {
  return {
    minConfidence: config.signals.minConfidence,
    notifyMinConfidence: config.signals.notifyMinConfidence,
    minRiskReward: 1.5,
    minMtfAlignment: 55,
    maxSignalsPerSymbolPerDay: config.signals.maxPerSymbolPerDay,
    // Structure and trend dominate: SMC/ICT context is the thesis, oscillators
    // are timing. Sentiment is a tiebreaker, never a driver.
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
    mtfTimeframes: ['15m', '1h', '4h', '1d'],
    requireSmcConfluence: false,
  };
}

function defaultAiSettings(): AiSettings {
  return {
    activeProvider: config.ai.defaultProvider,
    models: {},
    visionModels: {},
    temperature: 0.2,
    maxTokens: 4096,
    // Empty by default: a silent fallback to a provider the operator did not
    // choose is surprising. The admin panel opts in explicitly.
    fallbackChain: [],
    dailyQuota: { free: 10, premium: 200, admin: 1000 },
    aiEnabled: true,
    updatedAt: Date.now(),
    updatedBy: null,
  };
}

/** Insert or refresh the market universe. */
async function seedMarkets(): Promise<{ inserted: number; total: number }> {
  let inserted = 0;

  for (const m of DEFAULT_MARKETS) {
    const rows = await query<{ created: boolean }>(
      `INSERT INTO market_symbols
         (symbol, name, asset_class, base, quote, price_precision, tick_size,
          contract_size, tradingview_symbol, scan_enabled, display_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (symbol) DO UPDATE SET
         name               = EXCLUDED.name,
         asset_class        = EXCLUDED.asset_class,
         base               = EXCLUDED.base,
         quote              = EXCLUDED.quote,
         price_precision    = EXCLUDED.price_precision,
         tick_size          = EXCLUDED.tick_size,
         contract_size      = EXCLUDED.contract_size,
         tradingview_symbol = EXCLUDED.tradingview_symbol
       RETURNING (xmax = 0) AS created`,
      [
        m.symbol,
        m.name,
        m.assetClass,
        m.base ?? null,
        m.quote ?? null,
        m.pricePrecision,
        m.tickSize,
        m.contractSize ?? null,
        m.tradingViewSymbol,
        m.scanEnabled,
        m.displayOrder,
      ],
    );
    if (rows[0]?.created) inserted += 1;
  }

  return { inserted, total: DEFAULT_MARKETS.length };
}

/**
 * Write a settings row only if absent.
 *
 * `DO NOTHING` rather than `DO UPDATE` is the whole point: re-running the seeder
 * after an operator has tuned thresholds in the admin panel must not silently
 * revert their work.
 */
async function seedSetting(key: string, value: unknown): Promise<boolean> {
  const rows = await query<{ key: string }>(
    `INSERT INTO platform_settings (key, value)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, JSON.stringify(value)],
  );
  return rows.length === 1;
}

/**
 * Create the first administrator.
 *
 * The password is read from the environment and never defaulted — a hardcoded
 * admin credential in a seeder is a backdoor that follows the project into
 * production. When unset we skip and tell the operator how to proceed.
 */
async function seedAdmin(): Promise<'created' | 'exists' | 'skipped'> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!email || !password) {
    log.warn(
      'Skipping admin seed: set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD to create one',
    );
    return 'skipped';
  }

  if (password.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters');
  }

  const existing = await query<{ id: string }>(
    'SELECT id FROM users WHERE lower(email) = $1',
    [email],
  );
  if (existing.length > 0) return 'exists';

  const passwordHash = await bcrypt.hash(password, config.auth.bcryptRounds);
  const displayName = process.env.SEED_ADMIN_NAME?.trim() || 'Administrator';

  // One transaction: an admin without preferences or a subscription is a
  // half-provisioned account that later code would have to defend against.
  await transaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, role, email_verified)
       VALUES ($1, $2, $3, 'admin', TRUE)
       RETURNING id`,
      [email, passwordHash, displayName],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error('Failed to create admin user');

    await client.query(
      `INSERT INTO subscriptions (user_id, plan, status, expires_at)
       VALUES ($1, 'admin', 'active', NULL)`,
      [userId],
    );

    await client.query(
      `INSERT INTO user_preferences (user_id, min_signal_confidence, notify_min_confidence)
       VALUES ($1, $2, $3)`,
      [userId, config.signals.minConfidence, config.signals.notifyMinConfidence],
    );

    await client.query(
      `INSERT INTO audit_log (user_id, actor_email, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'admin.seeded', 'user', $1::text, '{"source":"db/seed"}'::jsonb)`,
      [userId, email],
    );
  });

  return 'created';
}

export async function runSeed(): Promise<void> {
  const markets = await seedMarkets();
  log.info(
    { inserted: markets.inserted, total: markets.total },
    'Market universe seeded',
  );

  const wroteSignals = await seedSetting('signal_engine', defaultSignalConfig());
  const wroteAi = await seedSetting('ai_settings', defaultAiSettings());
  log.info(
    { signalEngine: wroteSignals ? 'created' : 'preserved', aiSettings: wroteAi ? 'created' : 'preserved' },
    'Platform settings seeded',
  );

  const admin = await seedAdmin();
  log.info({ admin }, 'Admin seed complete');
}

// Direct invocation: `npm run seed`.
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/db/seed.ts');

if (invokedDirectly) {
  runSeed()
    .then(async () => {
      await closeDatabase();
      process.exit(0);
    })
    .catch(async (err: unknown) => {
      log.error({ err }, 'Seed failed');
      await closeDatabase();
      process.exit(1);
    });
}
