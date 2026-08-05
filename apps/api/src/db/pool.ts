/**
 * PostgreSQL access.
 *
 * Every query in the codebase goes through these helpers, and every one of them
 * is parameterised. There is no string-interpolated SQL anywhere in this
 * project — that is the SQL-injection defence, not an add-on filter.
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from '../core/config.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('db');

export const pool = new Pool({
  connectionString: config.db.url,
  max: config.db.poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl: config.db.ssl ? { rejectUnauthorized: false } : undefined,
  // Fail slow queries rather than holding a connection indefinitely.
  statement_timeout: 30_000,
  query_timeout: 30_000,
});

pool.on('error', (err) => {
  // Emitted for idle clients; the pool recovers on its own.
  log.error({ err }, 'Idle Postgres client error');
});

/**
 * Run a parameterised query.
 *
 * @param text SQL with `$1`-style placeholders — never interpolate values.
 * @param params Values bound to the placeholders.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  const start = process.hrtime.bigint();
  try {
    const result = await pool.query<T>(text, params as unknown[]);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (ms > 500) {
      log.warn({ ms: Math.round(ms), sql: text.slice(0, 200) }, 'Slow query');
    }
    return result.rows;
  } catch (err) {
    log.error({ err, sql: text.slice(0, 300) }, 'Query failed');
    throw err;
  }
}

/** Return the first row, or null. */
export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on any
 * throw. The callback receives the dedicated client — use it for every query in
 * the unit of work, or the statements will run outside the transaction.
 */
export async function transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      log.error({ err: rollbackErr }, 'Rollback failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Liveness probe used by /api/health. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    log.error({ err }, 'Database ping failed');
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
  log.info('Postgres pool closed');
}

/**
 * Build a `WHERE` fragment from optional filters.
 *
 * Returns the clause plus the ordered parameter array, keeping call sites free
 * of manual placeholder counting (a common source of injection-adjacent bugs).
 *
 * @param conditions Map of SQL fragment → value. Fragments must contain a `??`
 *                   token which is replaced by the positional placeholder.
 * @param startIndex First placeholder number to use (1-based).
 */
export function buildWhere(
  conditions: Array<{ sql: string; value: unknown } | null | undefined>,
  startIndex = 1,
): { clause: string; params: unknown[]; nextIndex: number } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  for (const cond of conditions) {
    if (!cond || cond.value === undefined || cond.value === null) continue;
    parts.push(cond.sql.replace('??', `$${idx}`));
    params.push(cond.value);
    idx += 1;
  }

  return {
    clause: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '',
    params,
    nextIndex: idx,
  };
}
