/**
 * Signal persistence.
 *
 * Signals are stored, not recomputed on read. Three reasons, all the same point —
 * a signal is a *statement made at a moment in time*:
 *
 *  - Re-deriving it later would use newer candles and produce a different
 *    answer, which makes every performance statistic meaningless.
 *  - The AI narrative cost a real model call and must not be regenerated.
 *  - Track record is the platform's only honest claim to competence, and a
 *    track record you can silently recompute is not a track record.
 *
 * That is why there is no UPDATE path for a signal's levels or reasoning. Status
 * moves forward, `realised_r` is filled in on resolution, and nothing else about
 * a persisted signal ever changes.
 */

import type {
  ConfidenceBreakdown,
  ConfluenceFactor,
  Direction,
  Signal,
  SignalAccuracyBucket,
  SignalAction,
  SignalPerformance,
  SignalQuality,
  SignalStatus,
  TakeProfitTarget,
  Timeframe,
  TrendDirection,
} from '@quantdesk/shared';
import { buildWhere, query, queryOne } from '../../db/pool.js';
import { toEpoch, toEpochRequired, toNum, toNumRequired } from '../../db/rows.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Declared as a type alias rather than an interface deliberately: `query<T>`
 * constrains `T extends QueryResultRow`, which is an index-signature type, and
 * TypeScript only grants implicit index signatures to type aliases. An interface
 * would fail that constraint.
 *
 * Every `NUMERIC` column is typed `string` and every `TIMESTAMPTZ` as `Date`,
 * matching what the driver actually hands back — see `db/rows.ts`.
 */
type SignalRow = {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  action: SignalAction;
  quality: SignalQuality;
  status: SignalStatus;
  confidence: string;
  confidence_breakdown: unknown;
  probability_score: string;
  risk_score: string;
  entry: string | null;
  entry_zone_low: string | null;
  entry_zone_high: string | null;
  stop_loss: string | null;
  take_profits: unknown;
  risk_reward_ratio: string | null;
  trend_direction: TrendDirection;
  bias: Direction;
  trend_strength: string;
  reasoning: string;
  market_structure_explanation: string;
  key_factors: unknown;
  invalidation: string;
  confluence: unknown;
  confluence_score: string;
  expected_duration: string;
  expected_duration_ms: string;
  expected_move_percent: string;
  price_at_generation: string;
  ai_provider: string | null;
  ai_model: string | null;
  deterministic_only: boolean;
  synthetic: boolean;
  realised_r: string | null;
  closed_at: Date | null;
  expires_at: Date;
  created_at: Date;
};

const COLUMNS = `
  id, symbol, timeframe, action, quality, status,
  confidence, confidence_breakdown, probability_score, risk_score,
  entry, entry_zone_low, entry_zone_high, stop_loss, take_profits, risk_reward_ratio,
  trend_direction, bias, trend_strength,
  reasoning, market_structure_explanation, key_factors, invalidation,
  confluence, confluence_score,
  expected_duration, expected_duration_ms, expected_move_percent,
  price_at_generation, ai_provider, ai_model, deterministic_only, synthetic,
  realised_r, closed_at, expires_at, created_at
`;

/**
 * Row → domain object.
 *
 * The entry zone is reassembled from two columns into the nested shape the
 * domain type uses. It is stored flat because a range is queryable that way —
 * "which signals had an entry band covering this price" is a question the
 * performance evaluator asks, and it cannot be indexed inside a JSONB blob.
 */
function mapSignal(row: SignalRow): Signal {
  const zoneLow = toNum(row.entry_zone_low);
  const zoneHigh = toNum(row.entry_zone_high);
  const closedAt = toEpoch(row.closed_at);
  const realisedR = toNum(row.realised_r);

  return {
    id: row.id,
    symbol: row.symbol,
    timeframe: row.timeframe,
    action: row.action,

    confidence: toNumRequired(row.confidence),
    confidenceBreakdown: breakdownFrom(row.confidence_breakdown),
    probabilityScore: toNumRequired(row.probability_score),
    riskScore: toNumRequired(row.risk_score),
    quality: row.quality,

    entry: toNum(row.entry),
    entryZone: zoneLow !== null && zoneHigh !== null ? { low: zoneLow, high: zoneHigh } : null,
    stopLoss: toNum(row.stop_loss),
    takeProfits: targetsFrom(row.take_profits),
    riskRewardRatio: toNum(row.risk_reward_ratio),

    trendDirection: row.trend_direction,
    bias: row.bias,
    trendStrength: toNumRequired(row.trend_strength),

    reasoning: row.reasoning,
    marketStructureExplanation: row.market_structure_explanation,
    keyFactors: stringArrayFrom(row.key_factors),
    invalidation: row.invalidation,

    expectedDuration: row.expected_duration,
    // BIGINT arrives as a string for the same reason NUMERIC does — it can
    // exceed a double. A duration in ms cannot, so a plain Number is safe here.
    expectedDurationMs: Number(row.expected_duration_ms),
    expectedMovePercent: toNumRequired(row.expected_move_percent),

    confluence: confluenceFrom(row.confluence),
    confluenceScore: toNumRequired(row.confluence_score),

    status: row.status,
    priceAtGeneration: toNumRequired(row.price_at_generation),
    createdAt: toEpochRequired(row.created_at),
    expiresAt: toEpochRequired(row.expires_at),
    // Spread rather than assigned: `closedAt` and `realisedR` are optional in the
    // domain type, and an explicit `undefined` would serialise to JSON as an
    // absent key anyway — but assigning it makes `'closedAt' in signal` true,
    // which is a different answer to "has this resolved?".
    ...(closedAt !== null ? { closedAt } : {}),
    ...(realisedR !== null ? { realisedR } : {}),

    // The columns are nullable because a row may predate the provenance fields;
    // the domain type is not. The deterministic engine is the honest default —
    // it produced the numbers even when an LLM narrated them.
    aiProvider: row.ai_provider ?? 'deterministic',
    aiModel: row.ai_model ?? 'quant-engine',
    deterministicOnly: row.deterministic_only,
    synthetic: row.synthetic,
  };
}

/* -------------------------------------------------------------------------- */
/* JSONB narrowing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * JSONB columns are narrowed, not cast.
 *
 * A row written by an earlier version of the engine may be missing a field the
 * current `ConfidenceBreakdown` requires. Casting would hand the UI an
 * `undefined` where it expects a number and render "NaN%" on a confidence meter.
 * Narrowing substitutes a neutral 50 and stays readable.
 */
function breakdownFrom(value: unknown): ConfidenceBreakdown {
  const o = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const n = (key: string, fallback: number): number => {
    const raw = o[key];
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  };

  return {
    // `overall` falls back to 0, not 50: an unknown confidence must not read as
    // a middling-but-real one on the meter.
    overall: n('overall', 0),
    technical: n('technical', 50),
    mtfAlignment: n('mtfAlignment', 50),
    structure: n('structure', 50),
    volume: n('volume', 50),
    sentiment: n('sentiment', 50),
    aiConviction: n('aiConviction', 50),
  };
}

function targetsFrom(value: unknown): TakeProfitTarget[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (t): t is TakeProfitTarget =>
      typeof t === 'object' &&
      t !== null &&
      typeof (t as TakeProfitTarget).price === 'number' &&
      typeof (t as TakeProfitTarget).rr === 'number',
  );
}

function confluenceFrom(value: unknown): ConfluenceFactor[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (f): f is ConfluenceFactor =>
      typeof f === 'object' && f !== null && typeof (f as ConfluenceFactor).label === 'string',
  );
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Persist a generated signal.
 *
 * The engine's own `id` is used as the primary key rather than letting Postgres
 * generate one, so the object returned to the caller and the row on disk carry
 * the same identifier without a round trip.
 *
 * The `signals_levels_consistency` CHECK is honoured by construction: the engine
 * emits null levels on WAIT and non-null levels otherwise, and those values pass
 * straight through. A violation here means the engine is wrong, and it should
 * fail loudly at the database rather than be coerced into a row that
 * misrepresents what it decided.
 *
 * @param generatedBy The requesting user, or null for scheduler-initiated scans.
 */
export async function insertSignal(signal: Signal, generatedBy: string | null): Promise<Signal> {
  const row = await queryOne<SignalRow>(
    `INSERT INTO signals (
       id, symbol, timeframe, action, quality, status,
       confidence, confidence_breakdown, probability_score, risk_score,
       entry, entry_zone_low, entry_zone_high, stop_loss, take_profits, risk_reward_ratio,
       trend_direction, bias, trend_strength,
       reasoning, market_structure_explanation, key_factors, invalidation,
       confluence, confluence_score,
       expected_duration, expected_duration_ms, expected_move_percent,
       price_at_generation, ai_provider, ai_model, deterministic_only, synthetic,
       generated_by, expires_at, created_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8::jsonb, $9, $10,
       $11, $12, $13, $14, $15::jsonb, $16,
       $17, $18, $19,
       $20, $21, $22::jsonb, $23,
       $24::jsonb, $25,
       $26, $27, $28,
       $29, $30, $31, $32, $33,
       $34, to_timestamp($35::bigint / 1000.0), to_timestamp($36::bigint / 1000.0)
     )
     RETURNING ${COLUMNS}`,
    [
      signal.id,
      signal.symbol,
      signal.timeframe,
      signal.action,
      signal.quality,
      signal.status,
      signal.confidence,
      JSON.stringify(signal.confidenceBreakdown),
      signal.probabilityScore,
      signal.riskScore,
      signal.entry,
      signal.entryZone?.low ?? null,
      signal.entryZone?.high ?? null,
      signal.stopLoss,
      JSON.stringify(signal.takeProfits),
      signal.riskRewardRatio,
      signal.trendDirection,
      signal.bias,
      signal.trendStrength,
      signal.reasoning,
      signal.marketStructureExplanation,
      JSON.stringify(signal.keyFactors),
      signal.invalidation,
      JSON.stringify(signal.confluence),
      signal.confluenceScore,
      signal.expectedDuration,
      signal.expectedDurationMs,
      signal.expectedMovePercent,
      signal.priceAtGeneration,
      signal.aiProvider,
      signal.aiModel,
      signal.deterministicOnly,
      signal.synthetic,
      generatedBy,
      signal.expiresAt,
      signal.createdAt,
    ],
  );

  // RETURNING guarantees a row on a successful INSERT; a constraint violation
  // throws before reaching here. The fallback only keeps the signature total.
  return row ? mapSignal(row) : signal;
}

const TERMINAL_STATUSES = new Set<SignalStatus>([
  'tp1_hit',
  'tp2_hit',
  'tp3_hit',
  'stopped_out',
  'expired',
  'invalidated',
  'cancelled',
]);

/** Whether a status is one a signal can never move out of. */
export function isTerminal(status: SignalStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Advance a signal's status.
 *
 * `realisedR` and `closedAt` are written together with a terminal status in one
 * statement, so a signal can never be observed as closed-but-unscored — a state
 * the performance aggregate would silently drop from its win rate.
 *
 * `updated_at` is left alone: a trigger maintains it for this table, and setting
 * it here would be both redundant and a second source of truth.
 */
export async function updateStatus(
  id: string,
  status: SignalStatus,
  options: { realisedR?: number | null; closedAt?: number | null; now?: number } = {},
): Promise<void> {
  const closedAt =
    options.closedAt ?? (TERMINAL_STATUSES.has(status) ? (options.now ?? Date.now()) : null);

  await query(
    `UPDATE signals SET
       status     = $2,
       realised_r = COALESCE($3, realised_r),
       closed_at  = CASE WHEN $4::bigint IS NULL THEN closed_at
                         ELSE to_timestamp($4::bigint / 1000.0) END
     WHERE id = $1`,
    [id, status, options.realisedR ?? null, closedAt],
  );
}

/**
 * Append a lifecycle event.
 *
 * The `signal_events` log is append-only and is what makes performance auditable:
 * `signals.status` says where a signal ended up, this says how it got there. The
 * excursion figures in {@link performance} are derived entirely from these rows.
 */
export async function recordEvent(
  signalId: string,
  event: string,
  price: number | null,
  note: string | null = null,
): Promise<void> {
  await query(`INSERT INTO signal_events (signal_id, event, price, note) VALUES ($1, $2, $3, $4)`, [
    signalId,
    event,
    price,
    note,
  ]);
}

/**
 * Expire signals past their horizon.
 *
 * Run by the scheduler. An idea that has not resolved within its expected window
 * has been overtaken by events, and leaving it "active" would both clutter the
 * UI and inflate the open count that accuracy is measured against.
 *
 * @param now Injected rather than read inside, so the job is testable.
 * @returns The ids expired, so the caller can push status changes over the
 *   WebSocket instead of making every client poll.
 */
export async function expireStale(now = Date.now()): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `UPDATE signals SET
       status    = 'expired',
       closed_at = to_timestamp($1::bigint / 1000.0)
     WHERE status IN ('active', 'triggered')
       AND expires_at < to_timestamp($1::bigint / 1000.0)
     RETURNING id`,
    [now],
  );
  return rows.map((r) => r.id);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export interface SignalFilter {
  symbol?: string | undefined;
  action?: SignalAction | undefined;
  status?: SignalStatus | undefined;
  timeframe?: Timeframe | undefined;
  minConfidence?: number | undefined;
  from?: number | undefined;
  to?: number | undefined;
  page: number;
  pageSize: number;
}

export async function listSignals(
  filter: SignalFilter,
): Promise<{ items: Signal[]; total: number }> {
  // `buildWhere` skips null/undefined conditions and numbers the placeholders,
  // so an absent filter costs nothing and the parameter array stays aligned.
  const { clause, params, nextIndex } = buildWhere([
    { sql: 'symbol = ??', value: filter.symbol?.toUpperCase() },
    { sql: 'action = ??', value: filter.action },
    { sql: 'status = ??', value: filter.status },
    { sql: 'timeframe = ??', value: filter.timeframe },
    { sql: 'confidence >= ??', value: filter.minConfidence },
    { sql: 'created_at >= to_timestamp(??::bigint / 1000.0)', value: filter.from },
    { sql: 'created_at <= to_timestamp(??::bigint / 1000.0)', value: filter.to },
  ]);

  // Count and page are two queries rather than one with a window function: the
  // count must ignore the LIMIT, and `COUNT(*) OVER ()` would force Postgres to
  // materialise every matching row to answer a paged request.
  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM signals ${clause}`,
    params,
  );

  const offset = (filter.page - 1) * filter.pageSize;
  const rows = await query<SignalRow>(
    `SELECT ${COLUMNS} FROM signals ${clause}
     ORDER BY created_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, filter.pageSize, offset],
  );

  return { items: rows.map(mapSignal), total: Number(countRow?.count ?? 0) };
}

export async function findSignal(id: string): Promise<Signal | null> {
  const row = await queryOne<SignalRow>(`SELECT ${COLUMNS} FROM signals WHERE id = $1`, [id]);
  return row ? mapSignal(row) : null;
}

/**
 * Currently-open signals.
 *
 * Excludes WAIT: a WAIT is a recorded decision *not* to trade — useful for
 * auditing the engine, but not something to show on a live-positions panel or
 * hand to the performance monitor, which would have nothing to monitor.
 */
export async function listActive(limit = 100): Promise<Signal[]> {
  const rows = await query<SignalRow>(
    `SELECT ${COLUMNS} FROM signals
     WHERE status IN ('active', 'triggered')
       AND action <> 'WAIT'
     ORDER BY confidence DESC, created_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapSignal);
}

/**
 * The most recent signal for a symbol/timeframe, whatever its status.
 *
 * Used for deduplication: without it, re-emitting the same setup on every scan
 * cycle would notify a user five times about one idea.
 */
export async function latestFor(symbol: string, timeframe: Timeframe): Promise<Signal | null> {
  const row = await queryOne<SignalRow>(
    `SELECT ${COLUMNS} FROM signals
     WHERE symbol = $1 AND timeframe = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [symbol.toUpperCase(), timeframe],
  );
  return row ? mapSignal(row) : null;
}

/**
 * How many actionable signals a symbol has produced today.
 *
 * Counted against `maxSignalsPerSymbolPerDay`. WAITs are excluded because they
 * are not what the cap exists to limit — the cap guards against notification
 * spam, and a WAIT notifies no one.
 *
 * Written as `created_at::date = CURRENT_DATE` to match the
 * `signals_symbol_day_idx` expression index, so this stays an index lookup
 * rather than a scan of the symbol's whole history.
 */
export async function countTodayFor(symbol: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM signals
     WHERE symbol = $1
       AND action <> 'WAIT'
       AND created_at::date = CURRENT_DATE`,
    [symbol.toUpperCase()],
  );
  return Number(row?.count ?? 0);
}

/* -------------------------------------------------------------------------- */
/* Performance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Per-signal outcomes for the analytics view.
 *
 * The excursion figures are derived from the `signal_events` log rather than
 * stored on the signal, because they are a property of the price path, not of
 * the decision. Knowing a trade ran 2.4R in profit before stopping out is what
 * separates a bad entry from a bad exit — and neither the entry nor the stop
 * alone tells you which happened.
 *
 * Excursion is expressed in R, so the denominator is the risk distance
 * `|entry - stop|`. `NULLIF` guards the degenerate zero-risk case: a signal whose
 * stop sits on its entry has no R scale, and dividing by it would yield a
 * division error rather than an honest null.
 */
export async function performance(limit = 200): Promise<SignalPerformance[]> {
  const rows = await query<{
    id: string;
    symbol: string;
    action: SignalAction;
    status: SignalStatus;
    confidence: string;
    realised_r: string | null;
    max_favourable_r: string | null;
    max_adverse_r: string | null;
    duration_ms: string | null;
    created_at: Date;
  }>(
    `SELECT s.id, s.symbol, s.action, s.status, s.confidence, s.realised_r,
            exc.best  / NULLIF(ABS(s.entry - s.stop_loss), 0) AS max_favourable_r,
            exc.worst / NULLIF(ABS(s.entry - s.stop_loss), 0) AS max_adverse_r,
            CASE WHEN s.closed_at IS NULL THEN NULL
                 ELSE (EXTRACT(EPOCH FROM (s.closed_at - s.created_at)) * 1000)::bigint::text
            END AS duration_ms,
            s.created_at
       FROM signals s
       LEFT JOIN LATERAL (
         -- Signed distance in the trade's favour, so one expression covers both
         -- directions: for a SELL, price falling below entry is favourable.
         SELECT MAX(CASE WHEN s.action = 'BUY' THEN e.price - s.entry
                         ELSE s.entry - e.price END) AS best,
                MIN(CASE WHEN s.action = 'BUY' THEN e.price - s.entry
                         ELSE s.entry - e.price END) AS worst
           FROM signal_events e
          WHERE e.signal_id = s.id
            AND e.price IS NOT NULL
       ) exc ON TRUE
      WHERE s.action <> 'WAIT'
      ORDER BY s.created_at DESC
      LIMIT $1`,
    [limit],
  );

  return rows.map((row) => ({
    signalId: row.id,
    symbol: row.symbol,
    action: row.action,
    status: row.status,
    confidence: toNumRequired(row.confidence),
    realisedR: toNum(row.realised_r),
    maxFavourableR: toNum(row.max_favourable_r),
    maxAdverseR: toNum(row.max_adverse_r),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    createdAt: toEpochRequired(row.created_at),
  }));
}

/**
 * Accuracy sliced by confidence band.
 *
 * This is the number that tells an operator whether the confidence figure means
 * anything at all. A calibrated engine wins roughly 80% of its 80-confidence
 * signals; one that wins 45% of them is producing a decorative number, and only
 * this breakdown reveals it.
 *
 * Open signals are counted but excluded from the win rate — including them would
 * make a fresh burst of signals look like a sudden collapse in accuracy.
 */
export async function accuracyByBand(sinceMs?: number): Promise<SignalAccuracyBucket[]> {
  const params: unknown[] = [];
  let sinceClause = '';
  if (sinceMs !== undefined) {
    params.push(sinceMs);
    sinceClause = `AND created_at >= to_timestamp($${params.length}::bigint / 1000.0)`;
  }

  const rows = await query<{
    band: string;
    total: string;
    wins: string;
    losses: string;
    open: string;
    avg_r: string | null;
  }>(
    `SELECT
       (FLOOR(confidence / 10) * 10)::int || '-' || (FLOOR(confidence / 10) * 10 + 9)::int AS band,
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE realised_r > 0)::text  AS wins,
       COUNT(*) FILTER (WHERE realised_r <= 0)::text AS losses,
       COUNT(*) FILTER (WHERE realised_r IS NULL)::text AS open,
       AVG(realised_r) FILTER (WHERE realised_r IS NOT NULL) AS avg_r
     FROM signals
     WHERE action <> 'WAIT' ${sinceClause}
     GROUP BY FLOOR(confidence / 10)
     ORDER BY FLOOR(confidence / 10) DESC`,
    params,
  );

  return rows.map((row) => {
    const wins = Number(row.wins);
    const losses = Number(row.losses);
    const resolved = wins + losses;
    const avgR = toNumRequired(row.avg_r, 0);

    return {
      band: row.band,
      total: Number(row.total),
      wins,
      losses,
      open: Number(row.open),
      winRate: resolved === 0 ? 0 : round((wins / resolved) * 100, 2),
      avgR: round(avgR, 3),
      // Expectancy in R per trade. Equal to `avgR` by construction — expectancy
      // is winRate x avgWin + lossRate x avgLoss, which reduces to the mean R
      // over resolved trades. Both are surfaced because expectancy is the figure
      // position sizing depends on, and leaving the caller to derive it invites
      // someone to derive it differently.
      expectancy: round(avgR, 3),
    };
  });
}

function round(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/**
 * Delete resolved signals past the retention horizon.
 *
 * Open signals are never pruned regardless of age — an unresolved position is
 * not stale data, it is an outstanding claim, and `expireStale` is what closes
 * those out.
 */
export async function pruneSignals(olderThanDays: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM signals
     WHERE created_at < now() - make_interval(days => $1::int)
       AND status NOT IN ('active', 'triggered')
     RETURNING id`,
    [olderThanDays],
  );
  return rows.length;
}
