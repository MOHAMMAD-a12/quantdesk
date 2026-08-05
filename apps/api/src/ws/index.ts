/**
 * The WebSocket layer — live prices, chart updates and event push.
 *
 * The public surface is deliberately narrow: the entrypoint attaches it, the
 * scheduler and the signal and notification services push through it, and the
 * admin health view reads its statistics. Nothing outside this directory touches
 * the hub, the connection objects or the polling loops.
 *
 * Every publish function here is **fire-and-forget and never throws**. A signal
 * that was generated and persisted has happened whether or not a socket was
 * listening, and a producer that failed because a broadcast failed would be
 * trading a real outcome for a cosmetic one.
 */

import { WS_CHANNELS, type Signal } from '@quantdesk/shared';
import { hub } from './hub.js';

export { attachWebSocketServer, closeWebSocketServer, WS_PATH } from './server.js';
export { startMarketStream, stopMarketStream } from './stream.js';
export type { HubStats } from './hub.js';

/**
 * Push a signal to everyone watching signals, and everyone watching that symbol.
 *
 * Broadcast (Redis-backed) rather than delivered locally: the scan runs on
 * whichever instance the scheduler happens to be on, and the clients waiting for
 * the result are spread across all of them.
 */
export function publishSignal(signal: Signal): void {
  hub.publishAll([WS_CHANNELS.signals(), WS_CHANNELS.signalsFor(signal.symbol)], {
    type: 'signal',
    data: signal,
  });
}

/**
 * Push a signal whose status changed — hit, stopped, invalidated, expired.
 *
 * The same message shape as a new signal. Clients key on `signal.id` and replace
 * their copy, which is what makes an expiry sweep visible immediately instead of
 * on the next poll: a dashboard showing an "active" setup that resolved twenty
 * minutes ago is worse than showing nothing.
 */
export function publishSignalUpdate(signal: Signal): void {
  publishSignal(signal);
}

export interface LiveNotification {
  kind: string;
  title: string;
  body: string;
  link: string | null;
}

/**
 * Push a notification into a user's private channel.
 *
 * The in-app row is already written by the time this is called — the database is
 * the record and this is only the live nudge, so a user with no socket open
 * loses nothing and finds it in their feed.
 */
export function publishUserNotification(userId: string, notification: LiveNotification): void {
  hub.publish(WS_CHANNELS.user(userId), { type: 'notification', data: notification });
}

/** Connection and subscription counts, for the admin health view. */
export function wsStats(): ReturnType<typeof hub.stats> {
  return hub.stats();
}
