/**
 * Notification dispatch.
 *
 * The routing rules live here and nowhere else. Everything upstream — the signal
 * scanner, the risk monitor — calls one of the `notify*` functions with a domain
 * event and does not know what a Telegram chat id is; everything downstream is a
 * dumb transport that sends what it is given.
 *
 * Four gates stand between an event and a message, checked in this order:
 *
 *   1. **Threshold** — the user's own `notifyMinConfidence`, not the platform's.
 *   2. **Duplicate** — has this user already been told about this signal on this
 *      channel? The scanner is idempotent and will re-evaluate after a restart.
 *   3. **Quiet hours** — in the user's timezone.
 *   4. **Channel enabled and addressable.**
 *
 * A message that fails a gate is **recorded as suppressed with its reason**, not
 * dropped. That row is the difference between a user who can tune their
 * thresholds from evidence and one who concludes the alerts are broken.
 *
 * Delivery is never awaited by the caller's critical path. `dispatch` catches
 * everything: a Telegram outage must not fail the signal generation that
 * triggered it, because the signal is the valuable part and the alert is a
 * convenience.
 */

import type {
  NotificationChannel,
  NotificationKind,
  RiskExposure,
  Signal,
  UserPreferences,
} from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { moduleLogger } from '../../core/logger.js';
import { publishUserNotification } from '../../ws/index.js';
import { findUserById } from '../auth/repository.js';
import * as preferences from '../preferences/repository.js';
import * as repo from './repository.js';
import {
  ChannelRejectedError,
  ChannelUnconfiguredError,
  sendDiscord,
  sendEmail,
  sendTelegram,
  sendWebPush,
  type OutboundMessage,
} from './transports.js';

const log = moduleLogger('notify');

/** How many users are fanned out to concurrently. */
const FAN_OUT_CONCURRENCY = 8;

export interface NotifyEvent {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Path relative to the web app root, e.g. `/signals/abc`. */
  path: string | null;
  severity: OutboundMessage['severity'];
  /** Present for signal alerts; drives the duplicate guard. */
  signalId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Public entry points                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fan a signal out to everyone watching its symbol.
 *
 * The candidate set comes from `preferences.notifiableFor`, which does the
 * threshold comparison in SQL against each user's own minimum. Filtering in
 * application code would mean loading every watcher of a liquid symbol just to
 * discard most of them.
 *
 * WAIT signals are never notified. A WAIT is the engine declining to have an
 * opinion, and interrupting someone to tell them nothing is happening is the
 * fastest way to train them to ignore the ones that matter.
 */
export async function notifySignal(signal: Signal): Promise<{ notified: number; suppressed: number }> {
  if (signal.action === 'WAIT') {
    return { notified: 0, suppressed: 0 };
  }

  // The platform floor applies on top of each user's own setting. An operator
  // who raises the global minimum is saying "we do not stand behind anything
  // below this", and that must override a user who set theirs lower.
  if (signal.confidence < config.signals.notifyMinConfidence) {
    return { notified: 0, suppressed: 0 };
  }

  const watchers = await preferences.notifiableFor(signal.symbol, signal.confidence);
  if (watchers.length === 0) return { notified: 0, suppressed: 0 };

  const direction = signal.action === 'BUY' ? 'Long' : 'Short';
  const event: NotifyEvent = {
    kind: 'signal',
    title: `${direction} ${signal.symbol} · ${signal.confidence.toFixed(0)}% confidence`,
    body: signalBody(signal),
    path: `/signals/${signal.id}`,
    severity: signal.action === 'BUY' ? 'success' : 'warning',
    signalId: signal.id,
  };

  return fanOut(watchers, event);
}

/**
 * Compose the alert text.
 *
 * Levels first, reasoning second. Someone reading this on a phone lock screen
 * needs entry, stop and target in the first line they see; the narrative is what
 * they read once they have decided the trade is worth opening the app for.
 */
function signalBody(signal: Signal): string {
  const lines: string[] = [`${signal.timeframe} · ${signal.quality} setup`];

  if (signal.entry !== null) lines.push(`Entry ${fmt(signal.entry)}`);
  if (signal.stopLoss !== null) lines.push(`Stop ${fmt(signal.stopLoss)}`);

  const targets = signal.takeProfits.map((tp) => fmt(tp.price)).join(' / ');
  if (targets) lines.push(`Targets ${targets}`);

  if (signal.riskRewardRatio !== null) lines.push(`R:R ${signal.riskRewardRatio.toFixed(2)}`);

  // Truncated rather than sent whole: the full reasoning is several paragraphs,
  // Telegram caps a message at 4096 characters, and the alert is a pointer to
  // the analysis rather than the analysis itself.
  const reasoning = signal.reasoning.trim();
  if (reasoning) {
    lines.push('', reasoning.length > 400 ? `${reasoning.slice(0, 397)}...` : reasoning);
  }

  // Stated on every signal, not buried in a settings page. The platform tells
  // people what it thinks; it does not tell them what to do with their money.
  lines.push('', 'Analysis, not financial advice.');

  return lines.join('\n');
}

function fmt(price: number): string {
  // Small prices need more decimals than large ones — an eight-decimal BTC
  // price is unreadable and a two-decimal SHIB price is zero.
  const decimals = price >= 100 ? 2 : price >= 1 ? 4 : 8;
  return price.toFixed(decimals).replace(/\.?0+$/, '');
}

/**
 * Tell a user they have breached a risk limit.
 *
 * Never suppressed by quiet hours. Every other notification here is an
 * opportunity the user can afford to see in the morning; this one says money is
 * currently exposed beyond the limit they themselves set, and a limit that waits
 * politely until 8am is not a limit.
 */
export async function notifyRiskBreach(userId: string, exposure: RiskExposure): Promise<void> {
  if (!exposure.breached) return;

  const prefs = await preferences.get(userId);

  await dispatch(prefs, {
    kind: 'risk_breach',
    title: 'Risk limit breached',
    body: exposure.breaches.join('\n'),
    path: '/risk',
    severity: 'danger',
    signalId: null,
  }, { ignoreQuietHours: true });
}

/** Drawdown alert. Also exempt from quiet hours, for the same reason. */
export async function notifyDrawdown(
  userId: string,
  drawdownPercent: number,
  thresholdPercent: number,
): Promise<void> {
  const prefs = await preferences.get(userId);

  await dispatch(prefs, {
    kind: 'drawdown',
    title: `Drawdown at ${drawdownPercent.toFixed(1)}%`,
    body: `Your equity is ${drawdownPercent.toFixed(1)}% below its peak, past the ${thresholdPercent.toFixed(1)}% level you set. Consider reducing size until the curve recovers.`,
    path: '/portfolio',
    severity: 'danger',
    signalId: null,
  }, { ignoreQuietHours: true });
}

/** Operational message to one user — subscription changes, account events. */
export async function notifySystem(
  userId: string,
  title: string,
  body: string,
  path: string | null = null,
): Promise<void> {
  const prefs = await preferences.get(userId);
  await dispatch(prefs, { kind: 'system', title, body, path, severity: 'info', signalId: null });
}

/* -------------------------------------------------------------------------- */
/* Fan-out                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deliver one event to many users, a few at a time.
 *
 * Bounded concurrency rather than `Promise.all` over the whole set: a popular
 * symbol can have thousands of watchers, and opening thousands of simultaneous
 * outbound connections is indistinguishable from an outgoing DoS as far as
 * Telegram's rate limiter is concerned.
 */
async function fanOut(
  users: UserPreferences[],
  event: NotifyEvent,
): Promise<{ notified: number; suppressed: number }> {
  let notified = 0;
  let suppressed = 0;

  for (let i = 0; i < users.length; i += FAN_OUT_CONCURRENCY) {
    const batch = users.slice(i, i + FAN_OUT_CONCURRENCY);

    const results = await Promise.allSettled(batch.map((prefs) => dispatch(prefs, event)));

    for (const result of results) {
      if (result.status === 'rejected') {
        // Should be unreachable — `dispatch` catches its own errors — but a
        // fan-out that dies partway through would silently skip every user
        // after the failure, so it is caught here too.
        log.error({ err: result.reason }, 'Dispatch threw');
        suppressed += 1;
        continue;
      }
      notified += result.value.sent;
      suppressed += result.value.suppressed;
    }
  }

  log.info({ kind: event.kind, users: users.length, notified, suppressed }, 'Fan-out complete');
  return { notified, suppressed };
}

export interface DispatchOptions {
  /** For alerts that must arrive regardless of the hour. */
  ignoreQuietHours?: boolean;
}

/**
 * Deliver one event to one user across all their enabled channels.
 *
 * Every outcome — sent, failed, suppressed — produces a row. The in-app record
 * is written first and unconditionally, so the notification exists in the user's
 * feed even if every external channel is off or broken.
 *
 * Never throws.
 */
export async function dispatch(
  prefs: UserPreferences,
  event: NotifyEvent,
  options: DispatchOptions = {},
): Promise<{ sent: number; suppressed: number }> {
  const link = event.path ? `${config.server.webOrigin}${event.path}` : null;
  const message: OutboundMessage = {
    title: event.title,
    body: event.body,
    link,
    severity: event.severity,
  };

  const rows: repo.RecordInput[] = [];
  let sent = 0;
  let suppressed = 0;

  const base = {
    userId: prefs.userId,
    kind: event.kind,
    title: event.title,
    body: event.body,
    link,
    signalId: event.signalId,
  };

  // The in-app feed is not a transport — writing the row *is* the delivery — so
  // it is recorded as sent without an attempt.
  rows.push({ ...base, channel: 'in_app', status: 'sent', suppressionReason: null, error: null });
  sent += 1;

  // The live nudge over the user's WebSocket channel, if one is open. Not a
  // channel of its own and not subject to quiet hours: the row exists either
  // way, and pushing it means the bell badge updates without a poll. A user with
  // no socket open loses nothing.
  publishUserNotification(prefs.userId, {
    kind: event.kind,
    title: event.title,
    body: event.body,
    link,
  });

  const quiet = options.ignoreQuietHours ? null : await quietReason(prefs);

  const attempts: Array<{ channel: NotificationChannel; run: () => Promise<void> }> = [];
  const { channels } = prefs;

  if (channels.telegram.enabled && channels.telegram.chatId) {
    const chatId = channels.telegram.chatId;
    attempts.push({ channel: 'telegram', run: () => sendTelegram(chatId, message) });
  }
  if (channels.discord.enabled) {
    const webhook = channels.discord.webhookUrl;
    attempts.push({ channel: 'discord', run: () => sendDiscord(webhook, message) });
  }
  if (channels.email.enabled && channels.email.address) {
    const address = channels.email.address;
    attempts.push({ channel: 'email', run: () => sendEmail(address, message) });
  }
  if (channels.webPush.enabled) {
    attempts.push({ channel: 'web_push', run: () => pushToAll(prefs.userId, message) });
  }

  for (const attempt of attempts) {
    const outcome = await attemptOne(prefs, event, attempt.channel, attempt.run, quiet);
    rows.push({ ...base, ...outcome });
    if (outcome.status === 'sent') sent += 1;
    else suppressed += 1;
  }

  try {
    await repo.insertMany(rows);
  } catch (err) {
    // The message may well have gone out; only the record failed. Logged rather
    // than rethrown, because failing the caller now would suggest the user was
    // not notified when they probably were.
    log.error({ err, userId: prefs.userId }, 'Could not record notifications');
  }

  return { sent, suppressed };
}

/**
 * Run one channel's gates and its send.
 *
 * Returns the row fields describing what happened rather than throwing, so the
 * caller records every channel's outcome uniformly.
 */
async function attemptOne(
  prefs: UserPreferences,
  event: NotifyEvent,
  channel: NotificationChannel,
  run: () => Promise<void>,
  quiet: string | null,
): Promise<Pick<repo.RecordInput, 'channel' | 'status' | 'suppressionReason' | 'error'>> {
  if (quiet) {
    return { channel, status: 'suppressed', suppressionReason: quiet, error: null };
  }

  if (event.signalId) {
    const seen = await repo.alreadyNotified(prefs.userId, event.signalId, channel);
    if (seen) {
      return {
        channel,
        status: 'suppressed',
        suppressionReason: 'Already sent for this signal',
        error: null,
      };
    }
  }

  try {
    await run();
    return { channel, status: 'sent', suppressionReason: null, error: null };
  } catch (err) {
    if (err instanceof ChannelUnconfiguredError) {
      // Not a failure. The operator never set this channel up, and logging it as
      // an error once per notification would bury the real ones.
      return {
        channel,
        status: 'suppressed',
        suppressionReason: err.message,
        error: null,
      };
    }

    if (err instanceof ChannelRejectedError) {
      if (err.permanent) await disableChannel(prefs, channel, err.message);
      return { channel, status: 'failed', suppressionReason: null, error: err.message };
    }

    log.error({ err, channel, userId: prefs.userId }, 'Unexpected transport failure');
    return {
      channel,
      status: 'failed',
      suppressionReason: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Turn off a channel whose destination is permanently gone.
 *
 * A blocked bot or a deleted webhook will never succeed, and retrying it on
 * every signal is both wasted work and a good way to get an IP rate-limited.
 * The user is told through the in-app feed, which by construction still works.
 */
async function disableChannel(
  prefs: UserPreferences,
  channel: NotificationChannel,
  reason: string,
): Promise<void> {
  log.warn({ userId: prefs.userId, channel, reason }, 'Disabling dead channel');

  try {
    switch (channel) {
      case 'telegram':
        await preferences.update(prefs.userId, { channels: { telegram: { enabled: false, chatId: null } } });
        break;
      case 'discord':
        await preferences.update(prefs.userId, {
          channels: { discord: { enabled: false, webhookUrl: null } },
        });
        break;
      case 'email':
        // The address is kept. A bounced email is often a full mailbox rather
        // than a wrong address, and deleting it would make re-enabling the
        // channel a retyping exercise.
        await preferences.update(prefs.userId, {
          channels: { email: { enabled: false, address: prefs.channels.email.address } },
        });
        break;
      default:
        // Push subscriptions are removed individually in `pushToAll`; there is
        // no single destination to clear.
        break;
    }

    await repo.insert({
      userId: prefs.userId,
      channel: 'in_app',
      kind: 'system',
      title: `${channel} alerts disabled`,
      body: `We could not deliver to your ${channel} destination and have turned it off: ${reason}`,
      link: `${config.server.webOrigin}/settings/notifications`,
      signalId: null,
      status: 'sent',
      suppressionReason: null,
      error: null,
    });
  } catch (err) {
    log.error({ err, userId: prefs.userId, channel }, 'Could not disable channel');
  }
}

/**
 * Push to every device a user has registered.
 *
 * Succeeds if any device accepts. A user with a stale subscription on an old
 * laptop and a live one on their phone has been notified, and reporting failure
 * because of the laptop would disable a channel that is working.
 */
async function pushToAll(userId: string, message: OutboundMessage): Promise<void> {
  const subscriptions = await repo.subscriptionsFor(userId);

  if (subscriptions.length === 0) {
    throw new ChannelUnconfiguredError('Web push', 'a browser subscription');
  }

  let delivered = 0;
  const failures: string[] = [];

  for (const sub of subscriptions) {
    try {
      await sendWebPush(sub, message);
      delivered += 1;
    } catch (err) {
      if (err instanceof ChannelRejectedError && err.permanent) {
        await repo.deleteSubscription(sub.endpoint).catch(() => undefined);
      }
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (delivered === 0) {
    throw new ChannelRejectedError(
      `No device accepted the push: ${failures.join('; ')}`,
      // Not permanent even when every device failed: the user may simply have
      // no browser open, and disabling push for that would be wrong.
      false,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Quiet hours                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Whether now falls inside the user's quiet hours.
 *
 * Evaluated in the user's own timezone, and correct across midnight: a window of
 * 22:00–07:00 wraps, so the test is a disjunction rather than a range. Getting
 * that wrong inverts the setting and silences the entire trading day instead of
 * the night.
 */
async function quietReason(prefs: UserPreferences): Promise<string | null> {
  const window = prefs.channels.quietHours;
  if (!window) return null;

  const user = await findUserById(prefs.userId);
  const timezone = user?.timezone ?? 'UTC';

  const minutes = localMinutes(timezone);
  const start = parseClock(window.start);
  const end = parseClock(window.end);

  if (start === null || end === null) return null;

  const inside = start <= end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end; // Wraps past midnight.

  return inside ? `Quiet hours (${window.start}–${window.end})` : null;
}

function localMinutes(timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date());

    const map = new Map(parts.map((p) => [p.type, p.value]));
    const hour = Number(map.get('hour') ?? '0') % 24;
    return hour * 60 + Number(map.get('minute') ?? '0');
  } catch {
    // An unknown timezone must not silence alerts; UTC is wrong by hours, but
    // treating the whole day as quiet would be wrong by everything.
    return new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  }
}

function parseClock(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match?.[1] || !match[2]) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
