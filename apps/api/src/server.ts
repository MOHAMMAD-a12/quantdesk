/**
 * Process entrypoint.
 *
 * The order below is the whole content of this file, and each step is where it is
 * for a reason:
 *
 *   1. **Migrate.** Before anything can serve a request. A process that accepts
 *      traffic against a schema it has not yet applied answers with column-does-
 *      not-exist errors, which look like application bugs and are not.
 *   2. **Verify dependencies.** Postgres is required and the process exits without
 *      it — every route reads the database, so a "running" API with no database is
 *      a health check that lies. Redis is *not* required: caching, rate limiting
 *      and cross-instance fan-out all degrade rather than fail, and refusing to
 *      boot over a cache outage converts a partial degradation into an outage.
 *   3. **Initialise providers.** So the boot log states what the platform can
 *      actually do — which market feeds, which model, which alert transports. An
 *      operator should not have to make a request to discover the answer.
 *   4. **Listen, then attach the WebSocket server, then start the scheduler.** The
 *      HTTP server exists first because the hub needs something to attach to; the
 *      scheduler goes last because a scan firing before the sockets are up would
 *      have nowhere to publish.
 *
 * Shutdown reverses it, and the sequence matters more than the startup one:
 * stop accepting work, drain what is in flight, then close the connections that
 * in-flight work depends on. Closing the pool first would fail every request that
 * was still being served — which is precisely the data loss a graceful shutdown
 * exists to avoid.
 */

import type { Server } from 'node:http';
import { createServer } from 'node:http';

import { createApp } from './app.js';
import { config } from './core/config.js';
import { logger } from './core/logger.js';
import { closeDatabase, pingDatabase } from './db/pool.js';
import { closeRedis, pingRedis } from './db/redis.js';
import { runMigrations } from './db/migrate.js';
import { transportStatus, closeTransports } from './modules/notifications/index.js';
import { aiRegistry } from './providers/ai/index.js';
import { marketRegistry } from './providers/market/registry.js';
import { drainScheduler, startScheduler, stopScheduler } from './scheduler.js';
import { attachWebSocketServer, closeWebSocketServer, WS_PATH } from './ws/index.js';

const log = logger.child({ module: 'server' });

/** Past this, shutdown stops being graceful and the process exits regardless. */
const SHUTDOWN_TIMEOUT_MS = 20_000;

let server: Server | null = null;
let shuttingDown = false;

/* -------------------------------------------------------------------------- */
/* Boot                                                                       */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  log.info(
    { env: config.env, node: process.version, pid: process.pid },
    'QuantDesk API starting',
  );

  await migrate();
  await checkDependencies();
  await describeCapabilities();

  server = createServer(createApp());

  // Node's default is 5s, which is shorter than some proxies' keep-alive and
  // shows up as sporadic 502s under a load balancer. 65s clears the common
  // 60s upstream default.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 70_000;

  await listen(server);
  await attachWebSocketServer(server);
  startScheduler();

  log.info(
    {
      url: `http://${config.server.host}:${config.server.port}`,
      ws: `ws://${config.server.host}:${config.server.port}${WS_PATH}`,
      cors: config.server.corsOrigins,
    },
    'QuantDesk API ready',
  );
}

/**
 * Apply pending migrations.
 *
 * Runs on every boot, not just the first. The advisory lock inside the runner
 * makes that safe with any number of replicas starting at once, and the
 * alternative — a separate migration step an operator must remember — is how a
 * deploy ends up serving new code against an old schema.
 */
async function migrate(): Promise<void> {
  try {
    const { applied, skipped } = await runMigrations();
    if (applied.length > 0) {
      log.info({ applied, skipped }, `Applied ${applied.length} migration(s)`);
    } else {
      log.info({ skipped }, 'Database schema up to date');
    }
  } catch (err) {
    log.fatal({ err }, 'Migrations failed — refusing to start');
    await shutdownResources();
    process.exit(1);
  }
}

async function checkDependencies(): Promise<void> {
  if (!(await pingDatabase())) {
    log.fatal({ url: redact(config.db.url) }, 'Cannot reach PostgreSQL — refusing to start');
    await shutdownResources();
    process.exit(1);
  }
  log.info('PostgreSQL connected');

  if (await pingRedis()) {
    log.info('Redis connected');
  } else {
    // Deliberately a warning. See the header: the platform is designed to run
    // without Redis, at reduced capability, and this is the one place that
    // decision is visible at runtime.
    log.warn(
      'Redis unavailable — caching, rate limiting and cross-instance WebSocket ' +
        'fan-out are degraded. The API will run and recover automatically.',
    );
  }
}

/**
 * Log what this deployment can do, once, at boot.
 *
 * `marketRegistry.init()` and `transportStatus()` each log their own inventory, so
 * what is added here is only what they cannot say: whether the market data is
 * *real*, and whether the model layer is reachable.
 *
 * The synthetic-only warning is the important one. That provider exists so the
 * platform is demoable with no credentials at all, and it produces numbers no
 * exchange published — running on it unknowingly is the single most dangerous
 * configuration mistake available here, so it is stated in the loudest terms the
 * log has.
 */
async function describeCapabilities(): Promise<void> {
  marketRegistry.init();

  if (!marketRegistry.hasLiveProvider()) {
    log.warn(
      { providers: marketRegistry.listProviders() },
      'NO LIVE MARKET DATA PROVIDER IS CONFIGURED. Prices, candles and every ' +
        'signal derived from them are synthetic and must not be traded on. Set ' +
        'BINANCE_ENABLED=true or add a provider API key in .env.',
    );
  }

  const ai = aiRegistry.configuredProviders();
  if (ai.length > 0) {
    const available = await aiRegistry.isAvailable().catch(() => false);
    log.info({ providers: ai, available }, 'AI providers configured');
  } else {
    log.warn(
      'No AI provider is configured. The deterministic analysis engine still ' +
        'works in full; narrative reasoning, news classification and chart image ' +
        'analysis are unavailable.',
    );
  }

  transportStatus();
}

function listen(target: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      target.off('listening', onListening);
      // EADDRINUSE during a rolling restart is the single most common boot
      // failure, and the default message does not name the port.
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${config.server.port} is already in use`));
        return;
      }
      reject(err);
    };
    const onListening = () => {
      target.off('error', onError);
      resolve();
    };

    target.once('error', onError);
    target.once('listening', onListening);
    target.listen(config.server.port, config.server.host);
  });
}

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Ordered, idempotent shutdown.
 *
 * A second signal is ignored rather than escalating: an impatient operator
 * pressing Ctrl-C twice should not abort a drain that is halfway through writing
 * portfolio valuations. The hard timeout below is the escape hatch, and it does
 * not depend on anyone sending anything.
 */
async function shutdown(reason: string, exitCode = 0): Promise<void> {
  if (shuttingDown) {
    log.debug({ reason }, 'Shutdown already in progress');
    return;
  }
  shuttingDown = true;
  log.info({ reason }, 'Shutting down');

  const hard = setTimeout(() => {
    log.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out — forcing exit');
    process.exit(exitCode === 0 ? 1 : exitCode);
  }, SHUTDOWN_TIMEOUT_MS);
  hard.unref();

  try {
    // 1. No new background work or WebSocket upgrades. Timer callbacks that had
    //    already started stay tracked by `drainScheduler`, even though
    //    `stopScheduler` clears its registry.
    stopScheduler();
    await closeWebSocketServer();

    // 2. Stop accepting HTTP connections; existing requests run to completion.
    if (server) await closeServer(server);

    // 3. Let background work finish while its database and provider dependencies
    //    still exist. `drainScheduler` is bounded by its own timeout.
    await drainScheduler();

    // 4. Only now release what all of the above was using.
    await shutdownResources();

    log.info('Shutdown complete');
  } catch (err) {
    log.error({ err }, 'Error during shutdown');
    exitCode = exitCode === 0 ? 1 : exitCode;
  } finally {
    clearTimeout(hard);
    process.exit(exitCode);
  }
}

function closeServer(target: Server): Promise<void> {
  return new Promise((resolve) => {
    target.close(() => resolve());
    // Idle keep-alive sockets hold `close` open until their timeout expires.
    // Node 18.2+ ends them immediately; requests in flight are unaffected.
    target.closeIdleConnections?.();
  });
}

/**
 * Release the pool, the Redis clients and the SMTP connections.
 *
 * Settled rather than sequenced: they are independent, and one hanging must not
 * prevent the others from closing cleanly. Also called from the boot failure paths
 * above, where no server exists yet — which is why it is separate from `shutdown`.
 */
async function shutdownResources(): Promise<void> {
  const results = await Promise.allSettled([closeTransports(), closeRedis(), closeDatabase()]);
  for (const result of results) {
    if (result.status === 'rejected') log.warn({ err: result.reason }, 'Resource close failed');
  }
}

/** Never log a connection string with its password in it. */
function redact(url: string): string {
  return url.replace(/\/\/([^:/@]+):([^@]*)@/, '//$1:***@');
}

/* -------------------------------------------------------------------------- */
/* Process signals                                                            */
/* -------------------------------------------------------------------------- */

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * An unhandled rejection or uncaught exception leaves the process in a state no
 * one has reasoned about — a half-applied transaction, a released-twice client, a
 * lock held by nobody. It is logged and the process exits non-zero so the
 * supervisor replaces it with one whose state is known.
 *
 * `express`'s error middleware already catches everything a request can throw, so
 * reaching here means a bug outside the request lifecycle.
 */
process.on('unhandledRejection', (reason) => {
  log.fatal({ err: reason }, 'Unhandled promise rejection');
  void shutdown('unhandledRejection', 1);
});

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});

main().catch(async (err: unknown) => {
  log.fatal({ err }, 'Fatal error during startup');
  await shutdownResources();
  process.exit(1);
});
