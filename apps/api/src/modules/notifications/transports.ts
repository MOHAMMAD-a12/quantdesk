/**
 * Notification transports.
 *
 * One function per channel, each with the same shape: take a payload and a
 * destination, either succeed or throw with a message a human can act on. No
 * transport reads the database, decides whether a message *should* be sent, or
 * retries — those are the dispatcher's job, and a transport that made its own
 * delivery decisions would put half the routing logic somewhere nobody thinks to
 * look for it.
 *
 * Every transport is **optional at runtime**. An unconfigured channel throws
 * `ChannelUnconfiguredError`, which the dispatcher records as a suppression
 * rather than a failure: a platform deployed without an SMTP server has not
 * broken, it simply cannot send email, and filling the error log with that fact
 * once per signal teaches operators to ignore the error log.
 */

import webpush from 'web-push';
import { config } from '../../core/config.js';
import { moduleLogger } from '../../core/logger.js';
import { closeMailer, isMailerConfigured, sendMailOrThrow } from '../../core/mailer.js';

const log = moduleLogger('notify:transport');

/** Outbound timeout. Generous, but bounded — nothing here may hang a dispatch. */
const TIMEOUT_MS = 10_000;

/**
 * A channel that cannot send because it was never configured.
 *
 * Distinct from a delivery failure. The dispatcher treats this as "suppressed,
 * reason: not configured" and does not retry, because retrying a missing API key
 * will not find one.
 */
export class ChannelUnconfiguredError extends Error {
  constructor(channel: string, missing: string) {
    super(`${channel} is not configured — set ${missing}`);
    this.name = 'ChannelUnconfiguredError';
  }
}

/**
 * A destination the user's own settings got wrong — a dead webhook, a bot the
 * user blocked, an expired push subscription.
 *
 * Also not retryable, and unlike an unconfigured channel it is worth surfacing:
 * the user is expecting alerts on a channel that can no longer receive them.
 */
export class ChannelRejectedError extends Error {
  /** True when the destination is gone for good and should be disabled. */
  readonly permanent: boolean;

  constructor(message: string, permanent = false) {
    super(message);
    this.name = 'ChannelRejectedError';
    this.permanent = permanent;
  }
}

export interface OutboundMessage {
  title: string;
  body: string;
  /** Absolute URL back into the app. */
  link: string | null;
  /** Drives colour and iconography where the channel supports it. */
  severity: 'info' | 'success' | 'warning' | 'danger';
}

/* -------------------------------------------------------------------------- */
/* Telegram                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Send via the Telegram Bot API.
 *
 * `parse_mode` is deliberately omitted. Signal bodies contain characters
 * Telegram's Markdown parser treats as markup — `*`, `_`, `[`, and crucially the
 * `.` in every price — and a message that fails to parse is rejected outright.
 * A plain-text alert that arrives beats a formatted one that 400s.
 */
export async function sendTelegram(chatId: string, message: OutboundMessage): Promise<void> {
  const token = config.notifications.telegramBotToken;
  if (!token) throw new ChannelUnconfiguredError('Telegram', 'TELEGRAM_BOT_TOKEN');

  const text = [
    `${severityIcon(message.severity)} ${message.title}`,
    '',
    message.body,
    ...(message.link ? ['', message.link] : []),
  ].join('\n');

  const res = await post(`https://api.telegram.org/bot${token}/sendMessage`, {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });

  if (res.ok) return;

  // 403 means the user blocked the bot; 400 with this description means they
  // never started it. Both are permanent until the user acts, so the channel is
  // disabled rather than retried forever.
  const permanent =
    res.status === 403 || (res.status === 400 && /chat not found|bot was blocked/i.test(res.text));

  throw new ChannelRejectedError(`Telegram rejected the message (${res.status}): ${res.text}`, permanent);
}

/* -------------------------------------------------------------------------- */
/* Discord                                                                    */
/* -------------------------------------------------------------------------- */

const DISCORD_COLOURS: Record<OutboundMessage['severity'], number> = {
  info: 0x38bdf8,
  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
};

/**
 * Send to a Discord webhook.
 *
 * The user's own webhook takes precedence over the platform-wide one. The
 * platform default exists for operational alerts to a team channel; per-user
 * webhooks are how individual traders route their own signals.
 */
export async function sendDiscord(
  webhookUrl: string | null,
  message: OutboundMessage,
): Promise<void> {
  const url = webhookUrl ?? config.notifications.discordWebhookUrl;
  if (!url) throw new ChannelUnconfiguredError('Discord', 'DISCORD_WEBHOOK_URL');

  const res = await post(url, {
    embeds: [
      {
        title: message.title.slice(0, 256),
        description: message.body.slice(0, 4096),
        color: DISCORD_COLOURS[message.severity],
        ...(message.link ? { url: message.link } : {}),
        footer: { text: 'QuantDesk' },
      },
    ],
  });

  if (res.ok) return;

  // 404 and 401 mean the webhook was deleted or rotated. It will never work
  // again, so the user needs to be told rather than silently retried.
  const permanent = res.status === 404 || res.status === 401;
  throw new ChannelRejectedError(`Discord rejected the webhook (${res.status}): ${res.text}`, permanent);
}

/* -------------------------------------------------------------------------- */
/* Email                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Send via the shared SMTP transport in `core/mailer`.
 *
 * Not its own transport. A second nodemailer pool pointed at the same server
 * would double the connection count for no benefit, and would mean password
 * resets and signal alerts could disagree about whether email works.
 */
export async function sendEmail(address: string, message: OutboundMessage): Promise<void> {
  if (!isMailerConfigured() || !config.notifications.smtp.from) {
    throw new ChannelUnconfiguredError('Email', 'SMTP_HOST and SMTP_FROM');
  }

  try {
    await sendMailOrThrow({
      to: address,
      subject: message.title,
      text: [message.body, ...(message.link ? ['', message.link] : [])].join('\n'),
      html: emailHtml(message),
    });
  } catch (err) {
    // 5xx SMTP replies are permanent (no such mailbox); 4xx are transient
    // (mailbox full, greylisted) and worth another attempt later.
    const code = (err as { responseCode?: number }).responseCode;
    const permanent = typeof code === 'number' && code >= 500 && code < 600;
    throw new ChannelRejectedError(`Email delivery failed: ${describe(err)}`, permanent);
  }
}

/**
 * Minimal inline-styled HTML.
 *
 * Inline styles and a table-free layout because email clients strip `<style>`
 * blocks and disagree about everything else. All interpolated values go through
 * {@link escapeHtml} — a signal's reasoning text is model output, and model
 * output is untrusted input like any other.
 */
function emailHtml(message: OutboundMessage): string {
  const accent = {
    info: '#38bdf8',
    success: '#22c55e',
    warning: '#f59e0b',
    danger: '#ef4444',
  }[message.severity];

  const button = message.link
    ? `<p style="margin:24px 0 0"><a href="${escapeHtml(message.link)}" style="background:${accent};color:#0b1120;padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600">Open in QuantDesk</a></p>`
    : '';

  return `<!doctype html><html><body style="margin:0;padding:24px;background:#0b1120;font-family:ui-sans-serif,system-ui,sans-serif">
<div style="max-width:560px;margin:0 auto;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:28px;color:#e5e7eb">
<div style="border-left:3px solid ${accent};padding-left:12px;margin-bottom:20px">
<h1 style="margin:0;font-size:18px;color:#f9fafb">${escapeHtml(message.title)}</h1></div>
<div style="white-space:pre-wrap;font-size:14px;line-height:1.6;color:#cbd5e1">${escapeHtml(message.body)}</div>
${button}
<p style="margin:28px 0 0;font-size:12px;color:#64748b">
This is analysis, not financial advice. You are receiving it because you enabled email alerts in QuantDesk.
</p></div></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* -------------------------------------------------------------------------- */
/* Web push                                                                   */
/* -------------------------------------------------------------------------- */

let vapidReady = false;

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * Send a browser push notification.
 *
 * A 404 or 410 from the push service means the subscription is dead — the user
 * cleared their browser data or revoked permission. That is reported as
 * permanent so the dispatcher deletes the row; keeping dead subscriptions is how
 * a push queue silently becomes mostly garbage.
 */
export async function sendWebPush(target: PushTarget, message: OutboundMessage): Promise<void> {
  const vapid = config.notifications.vapid;
  if (!vapid.publicKey || !vapid.privateKey) {
    throw new ChannelUnconfiguredError('Web push', 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
  }

  if (!vapidReady) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
    vapidReady = true;
  }

  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    ...(message.link ? { link: message.link } : {}),
    severity: message.severity,
  });

  try {
    await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      { TTL: 1800 }, // Half an hour: a trade setup is not worth waking a device for tomorrow.
    );
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    const permanent = status === 404 || status === 410;
    throw new ChannelRejectedError(`Web push failed: ${describe(err)}`, permanent);
  }
}

/* -------------------------------------------------------------------------- */
/* Shared plumbing                                                            */
/* -------------------------------------------------------------------------- */

interface PostResult {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * POST JSON with a hard timeout.
 *
 * `AbortSignal.timeout` rather than a manual race: an abandoned promise still
 * holds its socket, and a notification fan-out that leaks one socket per slow
 * webhook exhausts the pool within a day.
 */
async function post(url: string, body: unknown): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Read at most a few KB of the error body. Some webhook endpoints answer a
    // failed POST with an HTML page, and there is no reason to hold it in memory.
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 512);

    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    // A network error is transient by definition — DNS, TLS, timeout. Not
    // permanent, so the dispatcher may try again.
    throw new ChannelRejectedError(`Request to ${hostOf(url)} failed: ${describe(err)}`, false);
  }
}

function severityIcon(severity: OutboundMessage['severity']): string {
  return { info: 'ℹ️', success: '✅', warning: '⚠️', danger: '🚨' }[severity];
}

/** Host only — a webhook URL contains its own secret and must not be logged. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the endpoint';
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Verify configured channels at boot.
 *
 * Called once from the server entrypoint. It logs what can and cannot send so
 * that "I'm not getting alerts" is answerable from the startup log rather than
 * by reasoning about which environment variables were set.
 */
export function transportStatus(): Record<string, boolean> {
  const smtp = config.notifications.smtp;
  const vapid = config.notifications.vapid;

  const status = {
    in_app: true,
    telegram: Boolean(config.notifications.telegramBotToken),
    discord: Boolean(config.notifications.discordWebhookUrl),
    email: Boolean(smtp.host && smtp.from),
    web_push: Boolean(vapid.publicKey && vapid.privateKey),
  };

  log.info(status, 'Notification transports');
  return status;
}

/** Close the pooled SMTP connections on shutdown. */
export function closeTransports(): void {
  closeMailer();
}
