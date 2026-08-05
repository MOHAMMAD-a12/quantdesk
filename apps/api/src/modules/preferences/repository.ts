/**
 * Per-user preferences: risk limits, watchlist, notification routing.
 *
 * These are the numbers the platform uses when it acts *on behalf of* a user —
 * how much of the account a position may risk, what confidence a signal needs
 * before it interrupts them, which channels it may interrupt them on. They are
 * deliberately separate from `platform_settings`, which the operator controls:
 * an admin raising the global minimum confidence must not silently lower a
 * user's own stricter threshold, and this table is where that distinction lives.
 *
 * The row is created with the user, so every read here can assume it exists.
 * `ensure` remains as a repair path for accounts predating the column or restored
 * from a partial backup — a missing preferences row would otherwise make the risk
 * engine fall back to defaults without saying so, which is exactly the kind of
 * silent substitution that gets someone's account size wrong.
 */

import type { NotificationChannelSettings, UserPreferences } from '@quantdesk/shared';
import { query, queryOne } from '../../db/pool.js';
import { toNumRequired, toStrArray } from '../../db/rows.js';

type PreferencesRow = {
  user_id: string;
  min_signal_confidence: string;
  notify_min_confidence: string;
  watchlist: string[] | null;
  default_timeframe: string;
  risk_per_trade_percent: string;
  max_daily_risk_percent: string;
  max_weekly_risk_percent: string;
  max_concurrent_trades: number;
  account_balance: string;
  account_currency: string;
  channels: unknown;
};

const COLUMNS = `
  user_id, min_signal_confidence, notify_min_confidence, watchlist, default_timeframe,
  risk_per_trade_percent, max_daily_risk_percent, max_weekly_risk_percent,
  max_concurrent_trades, account_balance, account_currency, channels
`;

/**
 * The shape a user gets before they have configured anything.
 *
 * Conservative on purpose: 1% per trade, 3% daily, 6% weekly and five concurrent
 * positions are the limits a risk desk would impose on a new trader, and a
 * default that has to be loosened deliberately is safer than one that has to be
 * tightened before it does damage.
 */
export function defaultChannels(): NotificationChannelSettings {
  return {
    email: { enabled: false, address: null },
    telegram: { enabled: false, chatId: null },
    discord: { enabled: false, webhookUrl: null },
    webPush: { enabled: false },
    quietHours: null,
  };
}

/**
 * Narrow the `channels` JSONB.
 *
 * Field-by-field rather than a cast. This object decides whether the platform is
 * allowed to send someone a message and to what address; a malformed row that
 * cast cleanly could enable a channel nobody turned on, or carry a stale webhook
 * from a workspace the user has left.
 */
function channelsFrom(value: unknown): NotificationChannelSettings {
  const base = defaultChannels();
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return base;

  const raw = value as Record<string, unknown>;

  const flag = (key: string): boolean => {
    const entry = raw[key];
    if (typeof entry !== 'object' || entry === null) return false;
    return (entry as { enabled?: unknown }).enabled === true;
  };

  const text = (key: string, field: string): string | null => {
    const entry = raw[key];
    if (typeof entry !== 'object' || entry === null) return null;
    const candidate = (entry as Record<string, unknown>)[field];
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  };

  const quiet = raw['quietHours'];
  const quietHours =
    typeof quiet === 'object' &&
    quiet !== null &&
    typeof (quiet as { start?: unknown }).start === 'string' &&
    typeof (quiet as { end?: unknown }).end === 'string'
      ? { start: (quiet as { start: string }).start, end: (quiet as { end: string }).end }
      : null;

  return {
    email: { enabled: flag('email'), address: text('email', 'address') },
    telegram: { enabled: flag('telegram'), chatId: text('telegram', 'chatId') },
    discord: { enabled: flag('discord'), webhookUrl: text('discord', 'webhookUrl') },
    webPush: { enabled: flag('webPush') },
    quietHours,
  };
}

function mapPreferences(row: PreferencesRow): UserPreferences {
  return {
    userId: row.user_id,
    minSignalConfidence: toNumRequired(row.min_signal_confidence, 65),
    notifyMinConfidence: toNumRequired(row.notify_min_confidence, 78),
    watchlist: toStrArray(row.watchlist),
    defaultTimeframe: row.default_timeframe,
    riskPerTradePercent: toNumRequired(row.risk_per_trade_percent, 1),
    maxDailyRiskPercent: toNumRequired(row.max_daily_risk_percent, 3),
    maxWeeklyRiskPercent: toNumRequired(row.max_weekly_risk_percent, 6),
    maxConcurrentTrades: row.max_concurrent_trades,
    accountBalance: toNumRequired(row.account_balance, 0),
    accountCurrency: row.account_currency,
    channels: channelsFrom(row.channels),
  };
}

/** Read a user's preferences, creating the row if it is somehow absent. */
export async function get(userId: string): Promise<UserPreferences> {
  const row = await queryOne<PreferencesRow>(
    `SELECT ${COLUMNS} FROM user_preferences WHERE user_id = $1`,
    [userId],
  );

  if (row) return mapPreferences(row);
  return ensure(userId);
}

/** Create the row at its defaults. Idempotent. */
export async function ensure(userId: string): Promise<UserPreferences> {
  const row = await queryOne<PreferencesRow>(
    `INSERT INTO user_preferences (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING ${COLUMNS}`,
    [userId],
  );

  if (!row) throw new Error('Failed to create user preferences');
  return mapPreferences(row);
}

/** The fields a user may change. */
export interface PreferencesPatch {
  minSignalConfidence?: number;
  notifyMinConfidence?: number;
  watchlist?: string[];
  defaultTimeframe?: string;
  riskPerTradePercent?: number;
  maxDailyRiskPercent?: number;
  maxWeeklyRiskPercent?: number;
  maxConcurrentTrades?: number;
  accountBalance?: number;
  accountCurrency?: string;
  channels?: Partial<NotificationChannelSettings>;
}

/**
 * Apply a partial update.
 *
 * `COALESCE($n, column)` throughout, so an absent field keeps its stored value
 * rather than reverting to the column default — the difference between "leave my
 * watchlist alone" and "empty my watchlist" is one the API must preserve.
 *
 * `channels` is merged rather than replaced. A client that sends only its
 * Telegram settings should not silently disable email, and a full round-trip of
 * the whole object would make every preferences page a last-write-wins race.
 */
export async function update(userId: string, patch: PreferencesPatch): Promise<UserPreferences> {
  // Merged in application code rather than with `channels || $n::jsonb`, because
  // Postgres's `||` is a shallow merge: sending `{telegram: {chatId: "x"}}` would
  // drop `enabled` from the stored telegram object rather than updating one key.
  const current = await get(userId);
  const channels = patch.channels
    ? mergeChannels(current.channels, patch.channels)
    : current.channels;

  const row = await queryOne<PreferencesRow>(
    `UPDATE user_preferences SET
       min_signal_confidence   = COALESCE($2, min_signal_confidence),
       notify_min_confidence   = COALESCE($3, notify_min_confidence),
       watchlist               = COALESCE($4::text[], watchlist),
       default_timeframe       = COALESCE($5, default_timeframe),
       risk_per_trade_percent  = COALESCE($6, risk_per_trade_percent),
       max_daily_risk_percent  = COALESCE($7, max_daily_risk_percent),
       max_weekly_risk_percent = COALESCE($8, max_weekly_risk_percent),
       max_concurrent_trades   = COALESCE($9, max_concurrent_trades),
       account_balance         = COALESCE($10, account_balance),
       account_currency        = COALESCE($11, account_currency),
       channels                = $12::jsonb
     WHERE user_id = $1
     RETURNING ${COLUMNS}`,
    [
      userId,
      patch.minSignalConfidence ?? null,
      patch.notifyMinConfidence ?? null,
      patch.watchlist ?? null,
      patch.defaultTimeframe ?? null,
      patch.riskPerTradePercent ?? null,
      patch.maxDailyRiskPercent ?? null,
      patch.maxWeeklyRiskPercent ?? null,
      patch.maxConcurrentTrades ?? null,
      patch.accountBalance ?? null,
      patch.accountCurrency ?? null,
      JSON.stringify(channels),
    ],
  );

  if (!row) throw new Error('Preferences row disappeared during update');
  return mapPreferences(row);
}

function mergeChannels(
  current: NotificationChannelSettings,
  patch: Partial<NotificationChannelSettings>,
): NotificationChannelSettings {
  return {
    email: { ...current.email, ...(patch.email ?? {}) },
    telegram: { ...current.telegram, ...(patch.telegram ?? {}) },
    discord: { ...current.discord, ...(patch.discord ?? {}) },
    webPush: { ...current.webPush, ...(patch.webPush ?? {}) },
    // Explicit null means "clear quiet hours", absent means "leave it".
    quietHours: patch.quietHours === undefined ? current.quietHours : patch.quietHours,
  };
}

/**
 * Every user watching a symbol, for the notification fan-out.
 *
 * Returns ids only. The scanner calls this once per generated signal, and
 * hydrating full preference rows for a watchlist that may be thousands of users
 * long — before knowing which of them clear the confidence threshold — is work
 * thrown away.
 */
export async function watchersOf(symbol: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM user_preferences WHERE $1 = ANY (watchlist)`,
    [symbol],
  );
  return rows.map((r) => r.user_id);
}

/**
 * Users who should be told about a signal at this confidence.
 *
 * The threshold comparison happens in SQL against each user's own
 * `notify_min_confidence`, not against a single platform number — the whole
 * point of the per-user setting is that one person's actionable signal is
 * another's noise.
 */
export async function notifiableFor(
  symbol: string,
  confidence: number,
): Promise<UserPreferences[]> {
  const rows = await query<PreferencesRow>(
    `SELECT ${COLUMNS} FROM user_preferences
     WHERE $1 = ANY (watchlist) AND notify_min_confidence <= $2`,
    [symbol, confidence],
  );
  return rows.map(mapPreferences);
}
