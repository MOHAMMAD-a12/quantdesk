/**
 * The notifications module — how the platform interrupts people.
 *
 * Three layers, deliberately separate:
 *
 *   - `transports.ts` knows how to send on a channel and nothing else.
 *   - `service.ts` decides *whether* to send, to whom, and records every outcome.
 *   - `repository.ts` is the history, the duplicate guard, and push subscriptions.
 *
 * Callers outside this module use the `notify*` functions. They take a domain
 * event — a signal, a breach — and are safe to `await` anywhere, because dispatch
 * never throws: an alert failing must not fail the analysis that produced it.
 */

export { notificationsRouter } from './routes.js';

export {
  dispatch,
  notifyDrawdown,
  notifyRiskBreach,
  notifySignal,
  notifySystem,
  type DispatchOptions,
  type NotifyEvent,
} from './service.js';

export {
  alreadyNotified,
  deleteSubscription,
  list,
  markAllRead,
  markRead,
  pruneOlderThan,
  saveSubscription,
  subscriptionsFor,
  unreadCount,
  type NotificationFilter,
  type PushSubscription,
  type RecordInput,
} from './repository.js';

/**
 * `transportStatus` and `closeTransports` are exported for the server
 * entrypoint: one logs what can send at boot, the other drains the pooled SMTP
 * connections on shutdown.
 */
export { closeTransports, transportStatus, type OutboundMessage } from './transports.js';
