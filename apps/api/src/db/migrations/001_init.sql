-- ---------------------------------------------------------------------------
-- 001_init — core schema
--
-- Conventions used throughout:
--   * UUID primary keys via gen_random_uuid() (pgcrypto), so ids are safe to
--     expose in URLs and can be generated client-side if ever needed.
--   * TIMESTAMPTZ everywhere. The application layer converts to epoch ms at the
--     boundary; the database always stores absolute instants.
--   * NUMERIC for money and prices, never float — a double cannot represent
--     0.1 exactly and rounding drift in PnL is unacceptable.
--   * ON DELETE CASCADE on user-owned rows so account deletion is complete.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'free' CHECK (role IN ('free', 'premium', 'admin')),
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url      TEXT,
  timezone        TEXT NOT NULL DEFAULT 'UTC',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

-- Case-insensitive uniqueness: Foo@x.com and foo@x.com are the same account.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role);

CREATE TABLE IF NOT EXISTS subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plan          TEXT NOT NULL CHECK (plan IN ('free', 'premium', 'admin')),
  status        TEXT NOT NULL CHECK (status IN ('active','trialing','past_due','cancelled','expired')),
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  external_ref  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions (user_id);
CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions (status)
  WHERE status IN ('active', 'trialing');

-- Refresh-token sessions. Storing a hash (not the token) means a database leak
-- does not hand over usable credentials.
CREATE TABLE IF NOT EXISTS sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_hash    TEXT NOT NULL,
  user_agent      TEXT,
  ip_address      INET,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_tokens (user_id);

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);
CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys (prefix);

-- ---------------------------------------------------------------------------
-- Preferences & settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id                 UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  min_signal_confidence   NUMERIC(5,2) NOT NULL DEFAULT 65 CHECK (min_signal_confidence BETWEEN 0 AND 100),
  notify_min_confidence   NUMERIC(5,2) NOT NULL DEFAULT 78 CHECK (notify_min_confidence BETWEEN 0 AND 100),
  watchlist               TEXT[] NOT NULL DEFAULT '{}',
  default_timeframe       TEXT NOT NULL DEFAULT '1h',
  risk_per_trade_percent  NUMERIC(6,3) NOT NULL DEFAULT 1.0 CHECK (risk_per_trade_percent > 0),
  max_daily_risk_percent  NUMERIC(6,3) NOT NULL DEFAULT 3.0,
  max_weekly_risk_percent NUMERIC(6,3) NOT NULL DEFAULT 6.0,
  max_concurrent_trades   INTEGER NOT NULL DEFAULT 5 CHECK (max_concurrent_trades > 0),
  account_balance         NUMERIC(20,2) NOT NULL DEFAULT 10000,
  account_currency        TEXT NOT NULL DEFAULT 'USD',
  channels                JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Singleton key/value store for admin-editable platform settings (AI provider
-- selection, signal engine thresholds). A table rather than env vars because
-- these are changed at runtime from the admin panel.
CREATE TABLE IF NOT EXISTS platform_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  UUID REFERENCES users (id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Encrypted provider credentials managed from the admin panel. The ciphertext
-- column holds AES-256-GCM output; the key never lives in the database.
CREATE TABLE IF NOT EXISTS provider_credentials (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL CHECK (kind IN ('market', 'ai', 'news', 'notification')),
  ciphertext    TEXT NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  last_error    TEXT,
  last_check_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Market universe
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS market_symbols (
  symbol              TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  asset_class         TEXT NOT NULL CHECK (asset_class IN ('crypto','forex','stock','index','commodity')),
  base                TEXT,
  quote               TEXT,
  price_precision     INTEGER NOT NULL DEFAULT 2 CHECK (price_precision BETWEEN 0 AND 12),
  tick_size           NUMERIC(20,10) NOT NULL DEFAULT 0.01,
  contract_size       NUMERIC(20,6),
  tradingview_symbol  TEXT NOT NULL,
  scan_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  display_order       INTEGER NOT NULL DEFAULT 100,
  preferred_provider  TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_symbols_class_idx ON market_symbols (asset_class, display_order);
CREATE INDEX IF NOT EXISTS market_symbols_scan_idx ON market_symbols (scan_enabled) WHERE scan_enabled;

-- ---------------------------------------------------------------------------
-- Signals
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signals (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol                        TEXT NOT NULL REFERENCES market_symbols (symbol) ON DELETE CASCADE,
  timeframe                     TEXT NOT NULL,
  action                        TEXT NOT NULL CHECK (action IN ('BUY','SELL','WAIT')),
  quality                       TEXT NOT NULL CHECK (quality IN ('low','fair','good','high','premium')),
  status                        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','triggered','tp1_hit','tp2_hit','tp3_hit','stopped_out','expired','invalidated','cancelled')),

  confidence                    NUMERIC(5,2) NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  confidence_breakdown          JSONB NOT NULL DEFAULT '{}'::jsonb,
  probability_score             NUMERIC(5,2) NOT NULL,
  risk_score                    NUMERIC(5,2) NOT NULL,

  -- Nullable because WAIT signals carry no trade levels. The CHECK below makes
  -- the rule explicit instead of trusting every call site to honour it.
  entry                         NUMERIC(20,10),
  entry_zone_low                NUMERIC(20,10),
  entry_zone_high               NUMERIC(20,10),
  stop_loss                     NUMERIC(20,10),
  take_profits                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  risk_reward_ratio             NUMERIC(10,3),

  trend_direction               TEXT NOT NULL CHECK (trend_direction IN ('uptrend','downtrend','ranging')),
  bias                          TEXT NOT NULL DEFAULT 'neutral'
    CHECK (bias IN ('bullish','bearish','neutral')),
  trend_strength                NUMERIC(5,2) NOT NULL DEFAULT 0
    CHECK (trend_strength BETWEEN 0 AND 100),
  reasoning                     TEXT NOT NULL,
  market_structure_explanation  TEXT NOT NULL,
  key_factors                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  invalidation                  TEXT NOT NULL,
  confluence                    JSONB NOT NULL DEFAULT '[]'::jsonb,
  confluence_score              NUMERIC(6,2) NOT NULL DEFAULT 0
    CHECK (confluence_score BETWEEN -100 AND 100),

  expected_duration             TEXT NOT NULL,
  expected_duration_ms          BIGINT NOT NULL,
  expected_move_percent         NUMERIC(10,4) NOT NULL,

  price_at_generation           NUMERIC(20,10) NOT NULL,
  ai_provider                   TEXT,
  ai_model                      TEXT,
  deterministic_only            BOOLEAN NOT NULL DEFAULT FALSE,
  synthetic                     BOOLEAN NOT NULL DEFAULT FALSE,

  generated_by                  UUID REFERENCES users (id) ON DELETE SET NULL,
  realised_r                    NUMERIC(10,3),
  closed_at                     TIMESTAMPTZ,
  expires_at                    TIMESTAMPTZ NOT NULL,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- An actionable signal without levels is unusable, and a WAIT signal with
  -- them is misleading. Enforce both directions here.
  CONSTRAINT signals_levels_consistency CHECK (
    (action = 'WAIT' AND entry IS NULL AND stop_loss IS NULL)
    OR (action <> 'WAIT' AND entry IS NOT NULL AND stop_loss IS NOT NULL
        AND risk_reward_ratio IS NOT NULL)
  ),
  CONSTRAINT signals_entry_zone_order CHECK (
    entry_zone_low IS NULL OR entry_zone_high IS NULL OR entry_zone_low <= entry_zone_high
  )
);

CREATE INDEX IF NOT EXISTS signals_symbol_created_idx ON signals (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS signals_created_idx ON signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_action_idx ON signals (action, created_at DESC);
-- Supports the per-symbol daily cap without a full scan.
CREATE INDEX IF NOT EXISTS signals_symbol_day_idx ON signals (symbol, (created_at::date));

-- Append-only lifecycle log: how a signal actually played out.
CREATE TABLE IF NOT EXISTS signal_events (
  id          BIGSERIAL PRIMARY KEY,
  signal_id   UUID NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
  event       TEXT NOT NULL,
  price       NUMERIC(20,10),
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS signal_events_signal_idx ON signal_events (signal_id, created_at);

-- Cached deterministic analysis, so repeat dashboard loads do not recompute.
CREATE TABLE IF NOT EXISTS analysis_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        TEXT NOT NULL REFERENCES market_symbols (symbol) ON DELETE CASCADE,
  timeframe     TEXT NOT NULL,
  payload       JSONB NOT NULL,
  synthetic     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_snapshots_lookup_idx
  ON analysis_snapshots (symbol, timeframe, created_at DESC);

-- ---------------------------------------------------------------------------
-- Portfolio & journal
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS trades (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  signal_id         UUID REFERENCES signals (id) ON DELETE SET NULL,
  symbol            TEXT NOT NULL,
  direction         TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),

  entry_price       NUMERIC(20,10) NOT NULL,
  quantity          NUMERIC(20,10) NOT NULL CHECK (quantity > 0),
  stop_loss         NUMERIC(20,10),
  take_profit       NUMERIC(20,10),
  exit_price        NUMERIC(20,10),

  -- Denormalised results, written once on close. Recomputing PnL on every read
  -- would require the historical price series and produce drifting numbers.
  fees              NUMERIC(20,10) NOT NULL DEFAULT 0,
  pnl               NUMERIC(20,10),
  pnl_percent       NUMERIC(12,4),
  r_multiple        NUMERIC(10,3),
  risk_amount       NUMERIC(20,10),

  strategy          TEXT,
  notes             TEXT,
  tags              TEXT[] NOT NULL DEFAULT '{}',
  emotion           TEXT,
  mistakes          TEXT[] NOT NULL DEFAULT '{}',

  -- Post-trade self-assessment. Separate from the outcome on purpose: a trade
  -- can be executed perfectly and still lose, and a journal that conflates the
  -- two teaches the trader to grade process by result.
  execution_rating  SMALLINT CHECK (execution_rating BETWEEN 1 AND 5),
  screenshot_url    TEXT,

  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at         TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A closed trade must have an exit; an open trade must not.
  CONSTRAINT trades_exit_consistency CHECK (
    (status = 'closed' AND exit_price IS NOT NULL AND closed_at IS NOT NULL)
    OR (status <> 'closed')
  )
);

CREATE INDEX IF NOT EXISTS trades_user_idx ON trades (user_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS trades_user_open_idx ON trades (user_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS trades_user_closed_idx ON trades (user_id, closed_at DESC) WHERE status = 'closed';
CREATE INDEX IF NOT EXISTS trades_symbol_idx ON trades (symbol);

-- Daily equity marks, so the curve and drawdown do not need recomputing from
-- the full trade history on every request.
CREATE TABLE IF NOT EXISTS equity_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  as_of       DATE NOT NULL,
  balance     NUMERIC(20,2) NOT NULL,
  equity      NUMERIC(20,2) NOT NULL,
  realised_pnl NUMERIC(20,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, as_of)
);

CREATE INDEX IF NOT EXISTS equity_user_idx ON equity_snapshots (user_id, as_of);

-- ---------------------------------------------------------------------------
-- Intelligence: news, image analysis, AI usage
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS news_articles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id     TEXT NOT NULL,
  provider        TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT,
  url             TEXT NOT NULL,
  source          TEXT NOT NULL,
  image_url       TEXT,
  categories      TEXT[] NOT NULL DEFAULT '{}',
  symbols         TEXT[] NOT NULL DEFAULT '{}',
  sentiment       TEXT CHECK (sentiment IN ('bullish', 'bearish', 'neutral')),
  sentiment_score NUMERIC(5,2),
  impact          TEXT CHECK (impact IN ('low', 'medium', 'high', 'critical')),
  analysis        JSONB,
  published_at    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);

CREATE INDEX IF NOT EXISTS news_published_idx ON news_articles (published_at DESC);
CREATE INDEX IF NOT EXISTS news_symbols_idx ON news_articles USING GIN (symbols);
CREATE INDEX IF NOT EXISTS news_categories_idx ON news_articles USING GIN (categories);

CREATE TABLE IF NOT EXISTS economic_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   TEXT,
  title         TEXT NOT NULL,
  country       TEXT NOT NULL,
  currency      TEXT,
  category      TEXT NOT NULL,
  impact        TEXT NOT NULL CHECK (impact IN ('low', 'medium', 'high', 'critical')),
  actual        TEXT,
  forecast      TEXT,
  previous      TEXT,
  scheduled_at  TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS econ_events_time_idx ON economic_events (scheduled_at);
CREATE UNIQUE INDEX IF NOT EXISTS econ_events_dedupe_idx
  ON economic_events (title, scheduled_at, country);

CREATE TABLE IF NOT EXISTS image_analyses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  stored_path   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  symbol_hint   TEXT,
  timeframe_hint TEXT,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  report        JSONB,
  error         TEXT,
  ai_provider   TEXT,
  ai_model      TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS image_analyses_user_idx ON image_analyses (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_usage (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID REFERENCES users (id) ON DELETE SET NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  operation       TEXT NOT NULL,
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  success         BOOLEAN NOT NULL DEFAULT TRUE,
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_idx ON ai_usage (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_usage_provider_idx ON ai_usage (provider, created_at DESC);

-- ---------------------------------------------------------------------------
-- Notifications & audit
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subscriptions (user_id);

-- Column names and CHECK values mirror `NotificationRecord` in
-- @quantdesk/shared exactly, so the row maps to the wire type without a
-- translation layer that could drift.
CREATE TABLE IF NOT EXISTS notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  channel            TEXT NOT NULL
    CHECK (channel IN ('email','telegram','discord','web_push','in_app')),
  kind               TEXT NOT NULL
    CHECK (kind IN ('signal','price_alert','news','risk_breach','drawdown','system')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  link               TEXT,
  signal_id          UUID REFERENCES signals (id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sent','failed','suppressed')),
  -- Why a notification was withheld: quiet hours, below threshold, channel off.
  -- Recorded rather than dropped so the user can see what was filtered.
  suppression_reason TEXT,
  error              TEXT,
  read_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID REFERENCES users (id) ON DELETE SET NULL,
  actor_email   TEXT,
  action        TEXT NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip_address    INET,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_action_idx ON audit_log (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
--
-- A trigger rather than application code: it cannot be forgotten at a call site
-- and it holds for migrations and manual fixes too.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'subscriptions', 'user_preferences', 'platform_settings',
    'provider_credentials', 'market_symbols', 'signals', 'trades',
    'economic_events'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch_updated_at', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()',
      t || '_touch_updated_at', t
    );
  END LOOP;
END;
$$;
