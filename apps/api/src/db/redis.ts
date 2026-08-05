/**
 * Redis: caching, rate-limit counters and the pub/sub backbone for the
 * WebSocket hub.
 *
 * Redis is treated as an accelerator, never a source of truth. Every cache read
 * failure degrades to a live fetch rather than an error, so a Redis outage makes
 * the platform slower, not broken.
 */

import { Redis, type RedisOptions } from 'ioredis';
import { config } from '../core/config.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('redis');

const baseOptions: RedisOptions = {
  keyPrefix: config.redis.keyPrefix,
  maxRetriesPerRequest: 2,
  enableReadyCheck: true,
  // Exponential-ish backoff capped at 5s so a restarting Redis reconnects
  // promptly without hammering it.
  retryStrategy: (times) => Math.min(times * 250, 5_000),
  lazyConnect: false,
};

/** Primary client for GET/SET/INCR work. */
export const redis = new Redis(config.redis.url, baseOptions);

/**
 * Dedicated subscriber. A connection in subscribe mode cannot issue normal
 * commands, so pub/sub needs its own socket.
 */
export const redisSub = new Redis(config.redis.url, { ...baseOptions, keyPrefix: undefined });

/** Publisher, kept separate so a slow subscriber cannot block publishes. */
export const redisPub = new Redis(config.redis.url, { ...baseOptions, keyPrefix: undefined });

let degraded = false;

for (const [name, client] of [
  ['main', redis],
  ['sub', redisSub],
  ['pub', redisPub],
] as const) {
  client.on('error', (err: Error) => {
    if (!degraded) {
      degraded = true;
      log.error({ err, client: name }, 'Redis error — falling back to uncached reads');
    }
  });
  client.on('ready', () => {
    if (degraded) log.info({ client: name }, 'Redis recovered');
    degraded = false;
  });
}

/** True when the last observed connection state was healthy. */
export function isRedisHealthy(): boolean {
  return redis.status === 'ready';
}

export async function pingRedis(): Promise<boolean> {
  try {
    const res = await redis.ping();
    return res === 'PONG';
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Cache helpers                                                              */
/* -------------------------------------------------------------------------- */

/** Read and JSON-parse a key. Returns null on miss or any failure. */
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    log.debug({ err, key }, 'cacheGet failed');
    return null;
  }
}

/** JSON-serialise and store with a TTL in seconds. Failures are swallowed. */
export async function cacheSet(key: string, value: unknown, ttlSec: number): Promise<void> {
  try {
    await redis.set(key, JSON.stringify(value), 'EX', Math.max(1, Math.floor(ttlSec)));
  } catch (err) {
    log.debug({ err, key }, 'cacheSet failed');
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await redis.del(...keys);
  } catch (err) {
    log.debug({ err, keys }, 'cacheDel failed');
  }
}

/**
 * Delete every key matching a glob pattern using SCAN.
 *
 * SCAN rather than KEYS: KEYS blocks the server for the whole keyspace, which is
 * unacceptable on a shared instance.
 *
 * @param pattern Glob relative to the configured key prefix, e.g. `candles:BTCUSDT:*`.
 */
export async function cacheDelPattern(pattern: string): Promise<number> {
  const full = `${config.redis.keyPrefix}${pattern}`;
  let cursor = '0';
  let removed = 0;
  try {
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', full, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) {
        // These come back with the prefix already attached, so bypass the
        // prefixing client to avoid double-prefixing.
        removed += await redisPub.del(...keys);
      }
    } while (cursor !== '0');
  } catch (err) {
    log.debug({ err, pattern }, 'cacheDelPattern failed');
  }
  return removed;
}

/**
 * Read-through cache. Calls `producer` on a miss and stores the result.
 *
 * `null`/`undefined` results are not cached, so a transient upstream failure
 * does not get pinned for the TTL.
 */
export async function cacheWrap<T>(
  key: string,
  ttlSec: number,
  producer: () => Promise<T>,
): Promise<T> {
  const hit = await cacheGet<T>(key);
  if (hit !== null) return hit;
  const value = await producer();
  if (value !== null && value !== undefined) {
    await cacheSet(key, value, ttlSec);
  }
  return value;
}

/**
 * Best-effort distributed lock, used to stop N API instances from all running
 * the same market scan.
 *
 * @returns A release function, or null if the lock is already held.
 */
export async function acquireLock(
  key: string,
  ttlSec: number,
): Promise<(() => Promise<void>) | null> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const ok = await redis.set(`lock:${key}`, token, 'EX', Math.max(1, ttlSec), 'NX');
    if (ok !== 'OK') return null;
  } catch {
    // Redis down: let the caller proceed rather than stalling the scanner.
    return async () => {};
  }
  return async () => {
    try {
      // Only release our own lock — a lock that expired and was re-taken by
      // another worker must not be deleted here.
      const current = await redis.get(`lock:${key}`);
      if (current === token) await redis.del(`lock:${key}`);
    } catch {
      /* lock expires on its own */
    }
  };
}

/** Increment a counter, setting the TTL only on first write. Returns the count. */
export async function incrementWithTtl(key: string, ttlSec: number): Promise<number> {
  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, Math.max(1, ttlSec));
    return count;
  } catch {
    // Fail open: a Redis outage should not lock every user out.
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Pub/sub                                                                    */
/* -------------------------------------------------------------------------- */

export type RedisMessageHandler = (channel: string, payload: unknown) => void;

const handlers = new Set<RedisMessageHandler>();

redisSub.on('pmessage', (_pattern: string, channel: string, message: string) => {
  let payload: unknown;
  try {
    payload = JSON.parse(message);
  } catch {
    payload = message;
  }
  for (const handler of handlers) {
    try {
      handler(channel, payload);
    } catch (err) {
      log.error({ err, channel }, 'Pub/sub handler threw');
    }
  }
});

/**
 * Subscribe to the platform broadcast namespace. Used by the WebSocket hub so a
 * message published on any API instance reaches clients on every instance.
 */
export async function subscribeBroadcast(handler: RedisMessageHandler): Promise<() => void> {
  handlers.add(handler);
  if (handlers.size === 1) {
    await redisSub.psubscribe(`${config.redis.keyPrefix}bcast:*`);
    log.info('Subscribed to broadcast channel');
  }
  return () => handlers.delete(handler);
}

/** Publish to the broadcast namespace. */
export async function publishBroadcast(topic: string, payload: unknown): Promise<void> {
  try {
    await redisPub.publish(`${config.redis.keyPrefix}bcast:${topic}`, JSON.stringify(payload));
  } catch (err) {
    log.debug({ err, topic }, 'publishBroadcast failed');
  }
}

/** Strip the prefix + `bcast:` from a channel name received by a subscriber. */
export function broadcastTopic(channel: string): string {
  return channel.replace(`${config.redis.keyPrefix}bcast:`, '');
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit(), redisPub.quit()]);
  log.info('Redis connections closed');
}

/** Canonical cache keys — centralised so invalidation patterns stay in sync. */
export const CacheKeys = {
  candles: (symbol: string, timeframe: string, limit: number) =>
    `candles:${symbol}:${timeframe}:${limit}`,
  quote: (symbol: string) => `quote:${symbol}`,
  quotesBatch: (symbols: string[]) => `quotes:${[...symbols].sort().join(',')}`,
  analysis: (symbol: string, timeframe: string) => `analysis:${symbol}:${timeframe}`,
  derivatives: (symbol: string) => `derivs:${symbol}`,
  fearGreed: () => 'feargreed',
  news: (category: string, symbol: string | undefined, limit: number) =>
    `news:${category}:${symbol ?? 'all'}:${limit}`,
  calendar: (from: string, to: string) => `calendar:${from}:${to}`,
  correlation: (symbol: string) => `corr:${symbol}`,
  symbols: () => 'symbols:all',
  aiSettings: () => 'settings:ai',
  signalConfig: () => 'settings:signal',
  session: (sid: string) => `session:${sid}`,
  aiUsage: (userId: string, day: string) => `aiusage:${userId}:${day}`,
} as const;

/** TTLs in seconds, tuned to each data type's natural refresh rate. */
export const CacheTtl = {
  /** Intraday candles change every bar; keep this short. */
  candlesIntraday: 20,
  candlesDaily: 300,
  quote: 5,
  analysis: 45,
  derivatives: 30,
  fearGreed: 900,
  news: 300,
  calendar: 1800,
  correlation: 600,
  symbols: 300,
  settings: 60,
} as const;
