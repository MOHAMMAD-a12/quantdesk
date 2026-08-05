/**
 * Migration runner.
 *
 * Applies every `.sql` file in `migrations/` in filename order, exactly once,
 * each inside its own transaction. An advisory lock serialises concurrent
 * runners so `docker compose up` with multiple API replicas cannot double-apply.
 *
 * Usage: `npm run migrate` (from the repo root or apps/api).
 */

import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closeDatabase } from './pool.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('migrate');

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Arbitrary but fixed — must match across all processes. */
const ADVISORY_LOCK_ID = 4_827_113;

interface AppliedRow {
  name: string;
  checksum: string;
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: number }> {
  await ensureMigrationsTable();

  const client = await pool.connect();
  const applied: string[] = [];
  let skipped = 0;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => a.localeCompare(b, 'en'));

    if (files.length === 0) {
      log.warn({ dir: MIGRATIONS_DIR }, 'No migration files found');
      return { applied, skipped };
    }

    const { rows: doneRows } = await client.query<AppliedRow>(
      'SELECT name, checksum FROM schema_migrations',
    );
    const done = new Map(doneRows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 16);
      const previous = done.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          // Editing an applied migration silently diverges environments. Refuse
          // rather than guess which version is authoritative.
          throw new Error(
            `Migration "${file}" was modified after being applied ` +
              `(recorded ${previous}, now ${checksum}). Add a new migration instead.`,
          );
        }
        skipped += 1;
        continue;
      }

      const start = Date.now();
      log.info({ file }, 'Applying migration');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)',
          [file, checksum, Date.now() - start],
        );
        await client.query('COMMIT');
        applied.push(file);
        log.info({ file, ms: Date.now() - start }, 'Migration applied');
      } catch (err) {
        await client.query('ROLLBACK');
        log.error({ err, file }, 'Migration failed — rolled back');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    client.release();
  }

  return { applied, skipped };
}

/** Direct invocation (`tsx src/db/migrate.ts`) runs and exits. */
const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('/db/migrate.ts');

if (invokedDirectly) {
  runMigrations()
    .then(({ applied, skipped }) => {
      if (applied.length === 0) {
        log.info({ skipped }, 'Database already up to date');
      } else {
        log.info({ applied, skipped }, `Applied ${applied.length} migration(s)`);
      }
    })
    .catch((err: unknown) => {
      log.fatal({ err }, 'Migration run failed');
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
