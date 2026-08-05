/**
 * The connection hub — who is connected, what they are listening to, and how a
 * message reaches them.
 *
 * Two delivery paths, and the distinction between them is the whole design:
 *
 *   {@link Hub.deliver} — local only. Used for data this instance *fetched*.
 *     Every instance polls for what its own clients asked for, so broadcasting a
 *     quote would send every other instance a price they either already have or
 *     have nobody to give it to.
 *
 *   {@link Hub.publish} — local plus every other instance, via Redis pub/sub.
 *     Used for *events*: a signal generated on instance A must reach a client
 *     connected to instance B, and no amount of polling on B will produce it.
 *
 * Local delivery in `publish` happens immediately rather than waiting for the
 * message to come back around through Redis. A Redis outage then degrades
 * cross-instance fan-out — clients on other instances miss the event — instead
 * of silencing the socket entirely for everyone. Messages returning from Redis
 * carry the id of the instance that sent them and are dropped here if that id is
 * our own, which is what keeps the immediate delivery from duplicating.
 */

import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { ServerMessage, Timeframe, UserRole } from '@quantdesk/shared';
import { moduleLogger } from '../core/logger.js';
import { broadcastTopic, publishBroadcast, subscribeBroadcast } from '../db/redis.js';
import {
  MAX_CHANNELS_PER_CONNECTION,
  RATE_MAX_MESSAGES,
  RATE_WINDOW_MS,
  parseChannel,
} from './protocol.js';

const log = moduleLogger('ws:hub');

/** Identifies this process among the instances sharing a Redis. */
const INSTANCE_ID = randomUUID();

export interface Principal {
  id: string;
  email: string;
  role: UserRole;
}

/** What crosses Redis. The origin is what makes local-first delivery safe. */
interface BroadcastEnvelope {
  origin: string;
  message: ServerMessage;
}

function isEnvelope(value: unknown): value is BroadcastEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<BroadcastEnvelope>;
  return typeof candidate.origin === 'string' && typeof candidate.message === 'object';
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One socket, with everything the hub needs to reason about it.
 *
 * Subscriptions live on the connection *and* in the hub's reverse index. The
 * duplication is deliberate: fan-out needs channel → connections, and cleanup on
 * disconnect needs connection → channels, and deriving either from the other
 * would be a full scan at exactly the moment there is least time for one.
 */
export class Connection {
  readonly id = randomUUID();
  readonly socket: WebSocket;
  readonly ip: string;
  readonly connectedAt = Date.now();
  readonly channels = new Set<string>();

  principal: Principal | null = null;

  /** Cleared on every pong; a connection still false at the next sweep is gone. */
  awaitingPong = false;

  private windowStartedAt = Date.now();
  private messagesInWindow = 0;

  constructor(socket: WebSocket, ip: string) {
    this.socket = socket;
    this.ip = ip;
  }

  get userId(): string | null {
    return this.principal?.id ?? null;
  }

  /**
   * Send, tolerating a socket that closed between the fan-out and the write.
   *
   * A fan-out iterates a set that a disconnect may be mutating; a throw here
   * would abort delivery to every remaining subscriber on the channel.
   */
  send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    try {
      this.socket.send(JSON.stringify(message));
    } catch (err) {
      log.debug({ err, connectionId: this.id }, 'Send failed');
    }
  }

  /**
   * Count an inbound message against this connection's allowance.
   *
   * A fixed window rather than a token bucket: the limit exists to stop a
   * runaway client loop, not to shape traffic, and the burst a window boundary
   * permits is smaller than any amount of work these messages cause.
   */
  admitMessage(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= RATE_WINDOW_MS) {
      this.windowStartedAt = now;
      this.messagesInWindow = 0;
    }
    this.messagesInWindow += 1;
    return this.messagesInWindow <= RATE_MAX_MESSAGES;
  }
}

/* -------------------------------------------------------------------------- */
/* Hub                                                                        */
/* -------------------------------------------------------------------------- */

export interface HubStats {
  instanceId: string;
  connections: number;
  authenticated: number;
  channels: number;
  subscriptions: number;
}

class Hub {
  private readonly connections = new Map<string, Connection>();
  private readonly subscribers = new Map<string, Set<Connection>>();
  private readonly byIp = new Map<string, number>();
  private detachRedis: (() => void) | null = null;

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Begin listening for events published by other instances.
   *
   * Failure is logged, not thrown. A hub that cannot reach Redis still serves
   * every client attached to this process; refusing to start would take the
   * whole API down over a degraded accelerator.
   */
  async start(): Promise<void> {
    if (this.detachRedis) return;
    try {
      this.detachRedis = await subscribeBroadcast((channel, payload) => {
        if (!isEnvelope(payload)) return;
        if (payload.origin === INSTANCE_ID) return; // Already delivered locally.
        this.deliver(broadcastTopic(channel), payload.message);
      });
      log.info({ instanceId: INSTANCE_ID }, 'WebSocket hub subscribed to broadcasts');
    } catch (err) {
      log.error({ err }, 'Hub could not subscribe to Redis — cross-instance push is disabled');
    }
  }

  stop(): void {
    this.detachRedis?.();
    this.detachRedis = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Membership                                                             */
  /* ---------------------------------------------------------------------- */

  add(connection: Connection): void {
    this.connections.set(connection.id, connection);
    this.byIp.set(connection.ip, (this.byIp.get(connection.ip) ?? 0) + 1);
  }

  /**
   * Remove a connection and every trace of it.
   *
   * Empty channel sets are deleted rather than left behind. A map that only ever
   * grows keys is a slow leak, and the poller reads its work list from these
   * keys — a stale one would keep fetching a symbol nobody is watching.
   */
  remove(connection: Connection): void {
    this.connections.delete(connection.id);

    for (const channel of connection.channels) {
      const set = this.subscribers.get(channel);
      if (!set) continue;
      set.delete(connection);
      if (set.size === 0) this.subscribers.delete(channel);
    }
    connection.channels.clear();

    const count = (this.byIp.get(connection.ip) ?? 1) - 1;
    if (count <= 0) this.byIp.delete(connection.ip);
    else this.byIp.set(connection.ip, count);
  }

  connectionsFromIp(ip: string): number {
    return this.byIp.get(ip) ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Subscriptions                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Register interest.
   *
   * @returns false when the connection is already at its subscription limit.
   *   Re-subscribing to a channel already held is a no-op that returns true, so
   *   a client that re-sends its subscription list after a reconnect is not
   *   punished for it.
   */
  subscribe(connection: Connection, channel: string): boolean {
    if (connection.channels.has(channel)) return true;
    if (connection.channels.size >= MAX_CHANNELS_PER_CONNECTION) return false;

    connection.channels.add(channel);
    const set = this.subscribers.get(channel);
    if (set) set.add(connection);
    else this.subscribers.set(channel, new Set([connection]));
    return true;
  }

  unsubscribe(connection: Connection, channel: string): void {
    if (!connection.channels.delete(channel)) return;
    const set = this.subscribers.get(channel);
    if (!set) return;
    set.delete(connection);
    if (set.size === 0) this.subscribers.delete(channel);
  }

  hasSubscribers(channel: string): boolean {
    return (this.subscribers.get(channel)?.size ?? 0) > 0;
  }

  /* ---------------------------------------------------------------------- */
  /* Delivery                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Send to this instance's subscribers of a channel.
   *
   * The set is copied before iteration because a failed send can close a socket,
   * which removes the connection from the very set being walked.
   */
  deliver(channel: string, message: ServerMessage): number {
    const set = this.subscribers.get(channel);
    if (!set || set.size === 0) return 0;

    for (const connection of [...set]) {
      connection.send(message);
    }
    return set.size;
  }

  /**
   * Send to subscribers on every instance.
   *
   * Local delivery is synchronous; the Redis publish is fire-and-forget, because
   * an event's producer — a signal scan, a notification dispatch — must not
   * block on the message bus.
   */
  publish(channel: string, message: ServerMessage): void {
    this.deliver(channel, message);
    void publishBroadcast(channel, { origin: INSTANCE_ID, message } satisfies BroadcastEnvelope);
  }

  /** Publish to several channels at once, de-duplicating per connection. */
  publishAll(channels: string[], message: ServerMessage): void {
    const seen = new Set<string>();
    for (const channel of channels) {
      if (seen.has(channel)) continue;
      seen.add(channel);
      this.publish(channel, message);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Work lists for the poller                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Symbols with at least one live quote subscriber on this instance.
   *
   * The poller's entire input. When it comes back empty no upstream request is
   * made at all — an idle deployment should cost nothing in provider rate limit,
   * and a scheduler that fetches prices for an empty room is how a free API tier
   * gets exhausted overnight.
   */
  quoteSymbols(): string[] {
    return this.channelSymbols('quote');
  }

  derivativeSymbols(): string[] {
    return this.channelSymbols('derivatives');
  }

  /** Distinct (symbol, timeframe) pairs with a candle subscriber. */
  candleStreams(): Array<{ symbol: string; timeframe: Timeframe }> {
    const streams: Array<{ symbol: string; timeframe: Timeframe }> = [];
    for (const [channel, set] of this.subscribers) {
      if (set.size === 0 || !channel.startsWith('candle:')) continue;
      const parsed = parseChannel(channel);
      if (parsed?.kind === 'candle') {
        streams.push({ symbol: parsed.symbol, timeframe: parsed.timeframe });
      }
    }
    return streams;
  }

  private channelSymbols(prefix: 'quote' | 'derivatives'): string[] {
    const symbols = new Set<string>();
    for (const [channel, set] of this.subscribers) {
      if (set.size === 0 || !channel.startsWith(`${prefix}:`)) continue;
      const parsed = parseChannel(channel);
      if (parsed && (parsed.kind === 'quote' || parsed.kind === 'derivatives')) {
        symbols.add(parsed.symbol);
      }
    }
    return [...symbols];
  }

  /* ---------------------------------------------------------------------- */
  /* Introspection                                                          */
  /* ---------------------------------------------------------------------- */

  /** Every open connection, for the heartbeat sweep and shutdown. */
  all(): Connection[] {
    return [...this.connections.values()];
  }

  stats(): HubStats {
    let authenticated = 0;
    let subscriptions = 0;
    for (const connection of this.connections.values()) {
      if (connection.principal) authenticated += 1;
      subscriptions += connection.channels.size;
    }
    return {
      instanceId: INSTANCE_ID,
      connections: this.connections.size,
      authenticated,
      channels: this.subscribers.size,
      subscriptions,
    };
  }
}

/** Process-wide singleton, like the provider registries. */
export const hub = new Hub();
