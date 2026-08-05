/**
 * Background jobs.
 *
 * Everything the platform does without being asked lives here: the signal scan,
 * expiry, portfolio valuation, the risk monitor, news ingestion and the retention
 * sweeps. One file so the full set of things that touch the database on a timer is
 * readable at once — a job hidden inside the module it serves is a job nobody
 * remembers is running.
 *
 * Four properties every job gets from the runner, none of which are optional in
 * practice:
 *
 *   1. **Singleton across instances.** Each job takes a Redis lock before it runs.
 *      Three API replicas on a 60-second scan would otherwise mean three model
 *      calls per symbol per minute, three sets of alerts, and a bill that scales
 *      with replica count instead of with work. `acquireLock` fails *open* when
 *      Redis is down, which is the right trade: duplicate work during a cache
 *      outage beats no analysis at all.
 *   2. **Never overlapping with itself.** A scan of forty symbols can take longer
 *      than the interval that triggered it. Without the in-flight guard the
 *      overrun compounds until the pool or the provider's rate limit gives out.
 *   3. **Never fatal.** A job that throws is logged and its next tick runs
 *      normally. An unhandled rejection in a timer callback terminates the process
 *      on modern Node, and taking the API down because a news feed 502'd would be
 *      absurd.
 *   4. **Cheap when idle.** Jobs that depend on external configuration check for
 *      it first and return early. A platform with no news token configured must
 *      not log an error every ten minutes forever.
 *
 * Timers are `unref`'d so they never hold the event loop open — shutdown is
 * `stopScheduler()`, and a job already in flight is awaited by `drainScheduler()`
 * rather than killed, so a half-written valuation sweep does not become the
 * database's problem.
 */

import { config } from './core/config.js';
import { moduleLogger } from './core/logger.js';
import { acquireLock } from './db/redis.js';
import { pruneSessions } from './modules/auth/index.js';
import { pruneOlderThan as pruneImages, releaseStuck } from './modules/images/index.js';
import {
  classifyPending,
  ingestLatest,
  prune as pruneNews,
  sourceStatus,
} from './modules/news/index.js';
import {
  notifyDrawdown,
  notifyRiskBreach,
  notifySignal,
  pruneOlderThan as pruneNotifications,
} from './modules/notifications/index.js';
// Imported from the repository rather than the module barrel: the barrel also
// exports `adminRouter`, and the admin routes import `schedulerStatus` from here.
// Going through the barrel would close that loop.
import { platformStats } from './modules/admin/repository.js';
import { markAllToMarket, usersWithActivity } from './modules/portfolio/index.js';
import { current as currentRisk, drawdownState } from './modules/risk/index.js';
import { expire, pruneSignals, scan } from './modules/signals/index.js';
import { wsStats } from './ws/index.js';

const log = moduleLogger('scheduler');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/* -------------------------------------------------------------------------- */
/* Job definitions                                                            */
/* -------------------------------------------------------------------------- */

interface Job {
  /** Also the Redis lock key, so it must be stable across deploys. */
  name: string;
  intervalMs: number;
  /**
   * Lock TTL. Must exceed the job's realistic worst-case duration: a lock that
   * expires mid-run lets a second instance start the same work. `null` means the
   * job is per-instance and takes no lock at all.
   */
  lockTtlSec: number | null;
  /**
   * Run shortly after boot rather than waiting a full interval. True for jobs
   * whose delay is visible to a user (expiry, valuation); false for sweeps where
   * waiting is harmless and a restart loop would otherwise re-run them endlessly.
   */
  atBoot: boolean;
  /** Returns a summary object for the completion log, or nothing. */
  run: () => Promise<Record<string, unknown> | void>;
}

const jobs: Job[] = [
  {
    name: 'signal-scan',
    intervalMs: config.signals.scanIntervalMs,
    // Generous: a full universe scan is several provider calls plus a model call
    // per symbol, and being throttled upstream stretches it further.
    lockTtlSec: 15 * 60,
    atBoot: false,
    run: scanAndNotify,
  },
  {
    name: 'signal-expire',
    intervalMs: MINUTE,
    lockTtlSec: 50,
    atBoot: true,
    run: async () => ({ expired: (await expire()).length }),
  },
  {
    name: 'portfolio-mark',
    intervalMs: 5 * MINUTE,
    lockTtlSec: 4 * 60,
    atBoot: true,
    run: async () => markAllToMarket(),
  },
  {
    name: 'risk-monitor',
    intervalMs: 15 * MINUTE,
    lockTtlSec: 10 * 60,
    atBoot: false,
    run: riskMonitor,
  },
  {
    name: 'news-ingest',
    intervalMs: 10 * MINUTE,
    lockTtlSec: 9 * 60,
    atBoot: true,
    run: newsCycle,
  },
  {
    name: 'images-release-stuck',
    intervalMs: 5 * MINUTE,
    lockTtlSec: 60,
    atBoot: true,
    run: async () => ({ released: await releaseStuck() }),
  },
  {
    name: 'retention',
    intervalMs: 6 * HOUR,
    lockTtlSec: 30 * 60,
    atBoot: false,
    run: retention,
  },
  {
    // No lock: each instance reports its own socket counts, and a lock would
    // mean only one replica's numbers ever reach the log.
    name: 'heartbeat',
    intervalMs: 15 * MINUTE,
    lockTtlSec: null,
    atBoot: false,
    run: heartbeat,
  },
];

/* -------------------------------------------------------------------------- */
/* Job bodies                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Scan the universe, then alert on what it found.
 *
 * The notification step lives here rather than inside `signals.generate` on
 * purpose. `generate` also serves the interactive endpoint, where the user is
 * looking at the result they just requested — pushing them a Telegram message
 * about it would be noise. A scan has no such audience, so this is the one place
 * that fans a signal out.
 *
 * Alerts are dispatched sequentially and each is caught individually. `dispatch`
 * already swallows its own failures, so this is belt-and-braces against a bug in
 * the routing layer costing us the rest of the batch.
 */
async function scanAndNotify(): Promise<Record<string, unknown>> {
  const result = await scan();

  let notified = 0;
  for (const signal of result.signals) {
    try {
      const outcome = await notifySignal(signal);
      notified += outcome.notified;
    } catch (err) {
      log.error({ err, signalId: signal.id }, 'Signal notification failed');
    }
  }

  // The signals array is dropped from the log line — it is several kilobytes of
  // reasoning prose per entry, and the counts are what an operator reads.
  const { signals: _signals, ...counts } = result;
  return { ...counts, notified };
}

/**
 * Check every active account against its own risk limits.
 *
 * Only users with open or recently closed trades are examined. Sweeping the whole
 * user table would spend most of its time computing zero exposure for dormant
 * accounts.
 *
 * Both alerts are rate-limited to one per user per six hours by holding a Redis
 * key and deliberately never releasing it — the lock's TTL *is* the cooldown. A
 * breach is a standing condition rather than an event, so without this a user
 * sitting over their limit would be told again every fifteen minutes until they
 * muted the platform entirely.
 */
async function riskMonitor(): Promise<Record<string, unknown>> {
  const users = await usersWithActivity();
  if (users.length === 0) return { users: 0 };

  const COOLDOWN_SEC = 6 * HOUR / 1000;
  let breaches = 0;
  let drawdowns = 0;
  let failed = 0;

  for (const userId of users) {
    try {
      const exposure = await currentRisk(userId);
      if (exposure.breached && (await firstInWindow(`alert:risk:${userId}`, COOLDOWN_SEC))) {
        await notifyRiskBreach(userId, exposure);
        breaches += 1;
      }

      const state = await drawdownState(userId);
      if (state.alerting && (await firstInWindow(`alert:drawdown:${userId}`, COOLDOWN_SEC))) {
        await notifyDrawdown(userId, state.drawdownPercent, state.alertThresholdPercent);
        drawdowns += 1;
      }
    } catch (err) {
      failed += 1;
      log.warn({ err, userId }, 'Risk check failed for user');
    }
  }

  return { users: users.length, breaches, drawdowns, failed };
}

/**
 * Whether this is the first time in the window that `key` has come up.
 *
 * A cooldown built on `acquireLock` without the release. Fails open when Redis is
 * unavailable, matching the rest of the platform: a duplicate risk alert during an
 * outage is a nuisance, a missed one is the whole point of the feature.
 */
async function firstInWindow(key: string, ttlSec: number): Promise<boolean> {
  return (await acquireLock(key, ttlSec)) !== null;
}

/**
 * Pull new articles, then classify whatever is still unlabelled.
 *
 * Classification is a separate step from ingestion rather than part of it: the
 * article rows are worth having even when no AI provider is configured or the
 * model call fails, and coupling the two would mean a model outage loses the news.
 */
async function newsCycle(): Promise<Record<string, unknown> | void> {
  if (!sourceStatus().anyConfigured) return;

  const ingested = await ingestLatest();
  const classified = await classifyPending();

  return { ...ingested, classified };
}

/**
 * Retention sweeps.
 *
 * Run together and in parallel because they touch different tables and none
 * depends on another. Individually settled so one failing sweep does not skip the
 * rest for the next six hours.
 *
 * What is *not* pruned: trades, equity snapshots and audit rows. A trading journal
 * whose history quietly evaporates is worthless, and an audit log with a retention
 * policy is an audit log an operator can wait out.
 */
async function retention(): Promise<Record<string, unknown>> {
  const { retention: limits } = config.scheduler;
  const cutoff = new Date(Date.now() - limits.notificationDays * 24 * HOUR);

  const [signals, images, notifications, news, sessions] = await Promise.allSettled([
    pruneSignals(limits.signalDays),
    pruneImages(limits.imageDays),
    pruneNotifications(cutoff),
    pruneNews(),
    pruneSessions(),
  ]);

  return {
    signals: settled(signals),
    images: settled(images),
    notifications: settled(notifications),
    news: settled(news),
    sessions: settled(sessions),
  };
}

function settled(result: PromiseSettledResult<number>): number | string {
  if (result.status === 'fulfilled') return result.value;
  log.warn({ err: result.reason }, 'Retention sweep failed');
  return 'failed';
}

/**
 * Periodic proof of life, with enough shape to be useful.
 *
 * Logged at info so it survives a production log level, and structured so a log
 * aggregator can chart signal volume and socket counts without a metrics
 * endpoint. Deliberately not a health check — nothing here can fail a probe.
 */
async function heartbeat(): Promise<Record<string, unknown>> {
  const stats = await platformStats().catch(() => null);

  return {
    uptimeSeconds: Math.round(process.uptime()),
    rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    websocket: wsStats(),
    ...(stats ? { users: stats.users.active, signals24h: stats.signals.last24h } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

interface Running {
  timer: NodeJS.Timeout;
  inFlight: Promise<void> | null;
}

const running = new Map<string, Running>();

// `stopScheduler` must clear the map so late timer callbacks cannot start work,
// but shutdown still has to wait for work that began before that point. Keep the
// promises independently: deriving them from `running` after `stopScheduler()`
// would see an empty map and close the database under a scan that is still writing.
const inFlight = new Set<Promise<void>>();

/**
 * Start every job.
 *
 * Boot runs are staggered by a few seconds each. Firing four jobs the instant the
 * process is ready would have them contend for the connection pool at exactly the
 * moment the first requests arrive, which is the worst possible time to be slow.
 */
export function startScheduler(): void {
  if (!config.scheduler.enabled) {
    log.info('Scheduler disabled — no background jobs will run');
    return;
  }

  if (running.size > 0) {
    log.warn('Scheduler already started');
    return;
  }

  let bootDelay = 3_000;

  for (const job of jobs) {
    const state: Running = {
      timer: setInterval(() => void tick(job), job.intervalMs),
      inFlight: null,
    };
    state.timer.unref();
    running.set(job.name, state);

    if (job.atBoot) {
      const delay = bootDelay;
      bootDelay += 4_000;
      const boot = setTimeout(() => void tick(job), delay);
      boot.unref();
    }
  }

  log.info(
    { jobs: jobs.map((j) => j.name), scanIntervalMs: config.signals.scanIntervalMs },
    'Scheduler started',
  );
}

/** Stop the timers. In-flight work is left to finish; see `drainScheduler`. */
export function stopScheduler(): void {
  for (const state of running.values()) clearInterval(state.timer);
  running.clear();
  log.info('Scheduler stopped');
}

/**
 * Wait for any job still running to finish.
 *
 * Bounded, because shutdown cannot hang on a scan that is blocked on a provider
 * that has stopped answering. Past the deadline the process exits and the lock
 * expires on its own; the job is idempotent and the next instance will redo it.
 */
export async function drainScheduler(timeoutMs = 10_000): Promise<void> {
  const pending = [...inFlight];
  if (pending.length === 0) return;

  log.info({ jobs: pending.length }, 'Waiting for background jobs to finish');

  await Promise.race([
    Promise.allSettled(pending),
    new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, timeoutMs);
      timeout.unref();
    }),
  ]);
}

/**
 * One attempt at one job.
 *
 * The guard order is deliberate: the in-flight check is local and free, so it
 * happens before the lock round-trip. Checking Redis first would mean an
 * overrunning job also spends a network call per tick to discover it is busy.
 */
async function tick(job: Job): Promise<void> {
  const state = running.get(job.name);
  if (!state) return; // Stopped between the timer firing and now.

  if (state.inFlight) {
    log.debug({ job: job.name }, 'Skipped — previous run still in flight');
    return;
  }

  const promise = execute(job);
  state.inFlight = promise;
  inFlight.add(promise);
  try {
    await promise;
  } finally {
    inFlight.delete(promise);
    // Re-read: `stopScheduler` may have cleared the map while this ran, and
    // writing to a stale entry would resurrect a job that was shut down.
    const latest = running.get(job.name);
    if (latest === state) state.inFlight = null;
  }
}

async function execute(job: Job): Promise<void> {
  let release: (() => Promise<void>) | null = null;

  if (job.lockTtlSec !== null) {
    release = await acquireLock(`job:${job.name}`, job.lockTtlSec);
    if (!release) {
      log.debug({ job: job.name }, 'Skipped — another instance holds the lock');
      return;
    }
  }

  const startedAt = Date.now();
  try {
    const summary = await job.run();
    const durationMs = Date.now() - startedAt;

    // Quiet unless there was something to report. A job that logs "did nothing"
    // every minute trains the operator to filter the whole channel out.
    if (summary && Object.keys(summary).length > 0) {
      log.info({ job: job.name, durationMs, ...summary }, 'Job complete');
    } else {
      log.debug({ job: job.name, durationMs }, 'Job complete');
    }
  } catch (err) {
    log.error({ err, job: job.name, durationMs: Date.now() - startedAt }, 'Job failed');
  } finally {
    if (release) await release().catch(() => undefined);
  }
}

/**
 * Run one job immediately, by name.
 *
 * For the admin panel and for operators debugging a job that should have fired.
 * Goes through the same guards — a manual trigger that bypassed the lock would be
 * the one code path capable of the duplicate work everything above prevents.
 */
export async function runJobNow(name: string): Promise<boolean> {
  const job = jobs.find((j) => j.name === name);
  if (!job) return false;
  await tick(job);
  return true;
}

/** Job names and intervals, for the admin health view. */
export function schedulerStatus(): {
  enabled: boolean;
  jobs: Array<{ name: string; intervalMs: number; busy: boolean }>;
} {
  return {
    enabled: config.scheduler.enabled,
    jobs: jobs.map((job) => ({
      name: job.name,
      intervalMs: job.intervalMs,
      busy: running.get(job.name)?.inFlight != null,
    })),
  };
}
