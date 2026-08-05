/**
 * Trade and equity persistence.
 *
 * PnL is computed once, at close, and stored. It is never recomputed on read.
 *
 * That is the single most important rule in this file. A closed trade is a
 * historical fact: it was entered at a price, exited at a price, and cost a known
 * amount in fees. Recomputing its result later — against a revised fee schedule,
 * a corrected tick size, or a symbol whose contract size an admin has since
 * edited — would silently rewrite the user's track record, and a track record
 * that changes when you refresh the page is not one anybody can learn from.
 *
 * The `trades` table therefore carries denormalised `pnl`, `pnl_percent`,
 * `r_multiple` and `risk_amount` columns. They are written in the same statement
 * that sets the exit price, so there is no window in which a trade is closed but
 * unscored.
 */

import type { Trade, TradeSide, TradeStatus } from '@quantdesk/shared';
import { buildWhere, query, queryOne } from '../../db/pool.js';
import { fromEpoch, toEpoch, toEpochRequired, toNum, toNumRequired, toStrArray } from '../../db/rows.js';

type TradeRow = {
  id: string;
  user_id: string;
  signal_id: string | null;
  symbol: string;
  direction: TradeSide;
  status: TradeStatus;
  entry_price: string;
  quantity: string;
  stop_loss: string | null;
  take_profit: string | null;
  exit_price: string | null;
  fees: string;
  pnl: string | null;
  pnl_percent: string | null;
  r_multiple: string | null;
  risk_amount: string | null;
  strategy: string | null;
  notes: string | null;
  tags: string[] | null;
  emotion: string | null;
  mistakes: string[] | null;
  execution_rating: number | null;
  screenshot_url: string | null;
  opened_at: Date;
  closed_at: Date | null;
};

const COLUMNS = `
  id, user_id, signal_id, symbol, direction, status,
  entry_price, quantity, stop_loss, take_profit, exit_price,
  fees, pnl, pnl_percent, r_multiple, risk_amount,
  strategy, notes, tags, emotion, mistakes, execution_rating, screenshot_url,
  opened_at, closed_at
`;

function mapTrade(row: TradeRow): Trade {
  return {
    id: row.id,
    userId: row.user_id,
    symbol: row.symbol,
    side: row.direction,
    status: row.status,
    entryPrice: toNumRequired(row.entry_price, 0),
    quantity: toNumRequired(row.quantity, 0),
    stopLoss: toNum(row.stop_loss),
    takeProfit: toNum(row.take_profit),
    exitPrice: toNum(row.exit_price),
    // Null rather than 0 while open. Zero is a real result — a scratch trade —
    // and a chart that plots an open position at break-even is asserting
    // something the trade has not yet said.
    pnl: toNum(row.pnl),
    pnlPercent: toNum(row.pnl_percent),
    rMultiple: toNum(row.r_multiple),
    fees: toNumRequired(row.fees, 0),
    openedAt: toEpochRequired(row.opened_at),
    closedAt: toEpoch(row.closed_at),
    signalId: row.signal_id,
    notes: row.notes,
    tags: toStrArray(row.tags),
    executionRating: row.execution_rating,
    screenshotUrl: row.screenshot_url,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export interface OpenTradeInput {
  userId: string;
  symbol: string;
  side: TradeSide;
  entryPrice: number;
  quantity: number;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number | null;
  signalId: string | null;
  notes: string | null;
  tags: string[];
}

/**
 * Record an opened position.
 *
 * `risk_amount` is captured here, not at close, because it is a property of the
 * decision: it is what the trader accepted losing when they entered. Deriving it
 * later from a stop that has since been trailed would report a risk they never
 * actually took, and every R multiple computed from it would be wrong.
 */
export async function openTrade(input: OpenTradeInput): Promise<Trade> {
  const riskAmount =
    input.stopLoss === null
      ? null
      : Math.abs(input.entryPrice - input.stopLoss) * input.quantity;

  const row = await queryOne<TradeRow>(
    `INSERT INTO trades (
       user_id, symbol, direction, entry_price, quantity, stop_loss, take_profit,
       risk_amount, signal_id, notes, tags, opened_at, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], COALESCE($12, now()), 'open')
     RETURNING ${COLUMNS}`,
    [
      input.userId,
      input.symbol,
      input.side,
      input.entryPrice,
      input.quantity,
      input.stopLoss,
      input.takeProfit,
      riskAmount,
      input.signalId,
      input.notes,
      input.tags,
      fromEpoch(input.openedAt),
    ],
  );

  if (!row) throw new Error('Failed to record trade');
  return mapTrade(row);
}

export interface CloseTradeInput {
  exitPrice: number;
  closedAt: number | null;
  fees: number;
  notes: string | null;
  executionRating: number | null;
}

/**
 * Close a position and score it.
 *
 * The scoring happens in SQL, in the same statement as the status change, so a
 * trade cannot exist in a closed-but-unscored state even briefly. The three
 * results it writes:
 *
 *   - `pnl` — direction-aware, net of fees. Fees are subtracted because a
 *     result that ignores costs flatters every strategy, and the ones it
 *     flatters most are the high-frequency ones where costs decide the outcome.
 *   - `pnl_percent` — against the capital committed, not the account. Position
 *     sizing already varies with conviction; measuring return on notional keeps
 *     the two questions separate.
 *   - `r_multiple` — against the risk accepted at entry. This is the number that
 *     makes trades of different sizes comparable, and the one expectancy is
 *     built from.
 *
 * `WHERE status = 'open'` makes the write idempotent under a double-submit: the
 * second call matches nothing and returns null rather than overwriting a
 * recorded result with a second exit price.
 */
export async function closeTrade(
  id: string,
  userId: string,
  input: CloseTradeInput,
): Promise<Trade | null> {
  const row = await queryOne<TradeRow>(
    `UPDATE trades SET
       status      = 'closed',
       exit_price  = $3,
       fees        = $4,
       closed_at   = COALESCE($5, now()),
       notes       = COALESCE($6, notes),
       execution_rating = COALESCE($7, execution_rating),

       pnl = CASE WHEN direction = 'long'
                  THEN ($3 - entry_price) * quantity - $4
                  ELSE (entry_price - $3) * quantity - $4
             END,

       pnl_percent = CASE WHEN entry_price * quantity = 0 THEN NULL ELSE
             (CASE WHEN direction = 'long'
                   THEN ($3 - entry_price) * quantity - $4
                   ELSE (entry_price - $3) * quantity - $4
              END) / (entry_price * quantity) * 100
             END,

       r_multiple = CASE WHEN risk_amount IS NULL OR risk_amount = 0 THEN NULL ELSE
             (CASE WHEN direction = 'long'
                   THEN ($3 - entry_price) * quantity - $4
                   ELSE (entry_price - $3) * quantity - $4
              END) / risk_amount
             END

     WHERE id = $1 AND user_id = $2 AND status = 'open'
     RETURNING ${COLUMNS}`,
    [id, userId, input.exitPrice, input.fees, fromEpoch(input.closedAt), input.notes, input.executionRating],
  );

  return row ? mapTrade(row) : null;
}

export interface UpdateTradeInput {
  stopLoss?: number | null;
  takeProfit?: number | null;
  notes?: string | null;
  tags?: string[];
  executionRating?: number | null;
}

/**
 * Amend a trade's management levels and journal fields.
 *
 * Note what is *not* updatable: entry price, quantity, side, and — critically —
 * `risk_amount`. Trailing a stop changes what the position can still lose from
 * here; it does not change what was risked at entry, and rewriting that would
 * retroactively improve every R multiple in the user's history.
 *
 * `undefined` means "leave alone" and `null` means "clear", which is why each
 * field is passed as a pair: a single parameter cannot distinguish the two.
 */
export async function updateTrade(
  id: string,
  userId: string,
  patch: UpdateTradeInput,
): Promise<Trade | null> {
  const row = await queryOne<TradeRow>(
    `UPDATE trades SET
       stop_loss        = CASE WHEN $3 THEN $4  ELSE stop_loss END,
       take_profit      = CASE WHEN $5 THEN $6  ELSE take_profit END,
       notes            = CASE WHEN $7 THEN $8  ELSE notes END,
       tags             = CASE WHEN $9 THEN $10::text[] ELSE tags END,
       execution_rating = CASE WHEN $11 THEN $12 ELSE execution_rating END
     WHERE id = $1 AND user_id = $2
     RETURNING ${COLUMNS}`,
    [
      id,
      userId,
      patch.stopLoss !== undefined,
      patch.stopLoss ?? null,
      patch.takeProfit !== undefined,
      patch.takeProfit ?? null,
      patch.notes !== undefined,
      patch.notes ?? null,
      patch.tags !== undefined,
      patch.tags ?? null,
      patch.executionRating !== undefined,
      patch.executionRating ?? null,
    ],
  );

  return row ? mapTrade(row) : null;
}

/** Cancel an unfilled position. Only legal while open, and never scored. */
export async function cancelTrade(id: string, userId: string): Promise<Trade | null> {
  const row = await queryOne<TradeRow>(
    `UPDATE trades SET status = 'cancelled', closed_at = now()
     WHERE id = $1 AND user_id = $2 AND status = 'open'
     RETURNING ${COLUMNS}`,
    [id, userId],
  );
  return row ? mapTrade(row) : null;
}

export async function deleteTrade(id: string, userId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `DELETE FROM trades WHERE id = $1 AND user_id = $2 RETURNING id`,
    [id, userId],
  );
  return rows.length > 0;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function findTrade(id: string): Promise<Trade | null> {
  const row = await queryOne<TradeRow>(`SELECT ${COLUMNS} FROM trades WHERE id = $1`, [id]);
  return row ? mapTrade(row) : null;
}

export interface TradeFilter {
  userId: string;
  status?: TradeStatus | undefined;
  symbol?: string | undefined;
  side?: TradeSide | undefined;
  from?: number | undefined;
  to?: number | undefined;
  tag?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listTrades(
  filter: TradeFilter,
): Promise<{ items: Trade[]; total: number }> {
  const { clause, params, nextIndex } = buildWhere([
    { sql: 'user_id = ??', value: filter.userId },
    filter.status ? { sql: 'status = ??', value: filter.status } : null,
    filter.symbol ? { sql: 'symbol = ??', value: filter.symbol } : null,
    filter.side ? { sql: 'direction = ??', value: filter.side } : null,
    filter.from !== undefined ? { sql: 'opened_at >= ??', value: fromEpoch(filter.from) } : null,
    filter.to !== undefined ? { sql: 'opened_at <= ??', value: fromEpoch(filter.to) } : null,
    filter.tag ? { sql: '?? = ANY (tags)', value: filter.tag } : null,
  ]);

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM trades ${clause}`,
    params,
  );

  const rows = await query<TradeRow>(
    `SELECT ${COLUMNS} FROM trades ${clause}
     ORDER BY opened_at DESC
     LIMIT $${nextIndex} OFFSET $${nextIndex + 1}`,
    [...params, filter.pageSize, (filter.page - 1) * filter.pageSize],
  );

  return { items: rows.map(mapTrade), total: Number(countRow?.count ?? 0) };
}

/** Every open position. Unpaged — the concurrent-trade limit bounds it. */
export async function openPositions(userId: string): Promise<Trade[]> {
  const rows = await query<TradeRow>(
    `SELECT ${COLUMNS} FROM trades
     WHERE user_id = $1 AND status = 'open'
     ORDER BY opened_at DESC`,
    [userId],
  );
  return rows.map(mapTrade);
}

/**
 * Closed trades in a window, oldest first.
 *
 * Chronological because everything built on top of this — the equity curve,
 * drawdown, streaks — is path-dependent, and sorting it at each call site is
 * three chances to forget.
 */
export async function closedTrades(
  userId: string,
  from: number | null = null,
  to: number | null = null,
): Promise<Trade[]> {
  const rows = await query<TradeRow>(
    `SELECT ${COLUMNS} FROM trades
     WHERE user_id = $1 AND status = 'closed'
       AND ($2::timestamptz IS NULL OR closed_at >= $2)
       AND ($3::timestamptz IS NULL OR closed_at <= $3)
     ORDER BY closed_at ASC`,
    [userId, fromEpoch(from), fromEpoch(to)],
  );
  return rows.map(mapTrade);
}

/** Distinct tags a user has used, for the journal's filter chips. */
export async function tagsFor(userId: string): Promise<Array<{ tag: string; count: number }>> {
  const rows = await query<{ tag: string; count: string }>(
    `SELECT UNNEST(tags) AS tag, COUNT(*)::text AS count
       FROM trades
      WHERE user_id = $1
      GROUP BY tag
      ORDER BY COUNT(*) DESC, tag ASC
      LIMIT 100`,
    [userId],
  );
  return rows.map((r) => ({ tag: r.tag, count: Number(r.count) }));
}

/**
 * Trades against the signal that suggested them.
 *
 * This is what closes the loop on the platform's own claims: a signal marked
 * `tp2_hit` is only worth something if the people who took it actually finished
 * ahead, and this join is the only place those two records meet.
 */
export async function signalAttribution(
  userId: string,
  limit = 200,
): Promise<Array<{ signalId: string; trades: number; totalR: number; wins: number }>> {
  const rows = await query<{
    signal_id: string;
    trades: string;
    total_r: string | null;
    wins: string;
  }>(
    `SELECT signal_id,
            COUNT(*)::text                            AS trades,
            SUM(r_multiple)::text                     AS total_r,
            COUNT(*) FILTER (WHERE pnl > 0)::text     AS wins
       FROM trades
      WHERE user_id = $1 AND signal_id IS NOT NULL AND status = 'closed'
      GROUP BY signal_id
      ORDER BY MAX(closed_at) DESC
      LIMIT $2`,
    [userId, limit],
  );

  return rows.map((r) => ({
    signalId: r.signal_id,
    trades: Number(r.trades),
    totalR: toNumRequired(r.total_r, 0),
    wins: Number(r.wins),
  }));
}

/* -------------------------------------------------------------------------- */
/* Equity snapshots                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Record today's equity mark.
 *
 * One row per user per day, upserted. The curve could be reconstructed from the
 * trade history alone, but only for days on which a trade closed — and a
 * drawdown that skips the flat weeks understates how long the user actually spent
 * underwater, which is the part that decides whether a strategy is survivable.
 */
export async function snapshotEquity(
  userId: string,
  balance: number,
  equity: number,
  realisedPnl: number,
  asOf: Date = new Date(),
): Promise<void> {
  await query(
    `INSERT INTO equity_snapshots (user_id, as_of, balance, equity, realised_pnl)
     VALUES ($1, $2::date, $3, $4, $5)
     ON CONFLICT (user_id, as_of) DO UPDATE SET
       balance = EXCLUDED.balance,
       equity = EXCLUDED.equity,
       realised_pnl = EXCLUDED.realised_pnl`,
    [userId, asOf, balance, equity, realisedPnl],
  );
}

export async function equityCurve(
  userId: string,
  days = 365,
): Promise<Array<{ time: number; equity: number; balance: number }>> {
  const rows = await query<{ as_of: Date; equity: string; balance: string }>(
    `SELECT as_of, equity, balance FROM equity_snapshots
     WHERE user_id = $1 AND as_of > (CURRENT_DATE - make_interval(days => $2::int))
     ORDER BY as_of ASC`,
    [userId, days],
  );

  return rows.map((r) => ({
    time: toEpochRequired(r.as_of),
    equity: toNumRequired(r.equity, 0),
    balance: toNumRequired(r.balance, 0),
  }));
}

/** Every user holding an open position, for the nightly equity mark. */
export async function usersWithActivity(): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM trades WHERE status = 'open'
     UNION
     SELECT DISTINCT user_id FROM trades WHERE closed_at > now() - interval '2 days'`,
  );
  return rows.map((r) => r.user_id);
}
