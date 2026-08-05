/**
 * SMTP email delivery.
 *
 * Lives in `core` rather than in the notifications module because
 * account-security email (password resets) must work even if notifications are
 * disabled for a user — a reset link is not a notification the user can opt out
 * of, it is the recovery path for their account.
 *
 * The transport is created lazily and only when SMTP is configured. With no
 * configuration {@link isMailerConfigured} reports false and callers degrade
 * explicitly; nothing here silently pretends to have sent a message.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { config } from './config.js';
import { moduleLogger } from './logger.js';

const log = moduleLogger('mailer');

let transporter: Transporter | null = null;
let initialised = false;

/** True when SMTP credentials are present. */
export function isMailerConfigured(): boolean {
  return Boolean(config.notifications.smtp.host);
}

function getTransport(): Transporter | null {
  if (initialised) return transporter;
  initialised = true;

  const smtp = config.notifications.smtp;
  if (!smtp.host) {
    log.warn('SMTP is not configured — email delivery is disabled');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    ...(smtp.user && smtp.pass ? { auth: { user: smtp.user, pass: smtp.pass } } : {}),
    // Bound the wait so a black-holed SMTP host cannot pin a request open.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    // Pooled because the notification fan-out shares this transport: a scan that
    // alerts twenty watchers should not open twenty connections, which most
    // providers treat as abuse and several will block outright.
    pool: true,
    maxConnections: 3,
  });

  log.info({ host: smtp.host, port: smtp.port, secure: smtp.secure }, 'SMTP transport ready');
  return transporter;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Send an email, surfacing the failure.
 *
 * The notification dispatcher needs this variant: an SMTP 5xx means the mailbox
 * does not exist and the channel should be turned off, while a 4xx means try
 * again later. {@link sendMail} throws that distinction away by design, and a
 * dispatcher that could not tell the two apart would either disable channels
 * over a full inbox or retry a dead address forever.
 *
 * @throws when SMTP is unconfigured, or with the underlying nodemailer error
 *   (which carries `responseCode`) when the server rejects the message.
 */
export async function sendMailOrThrow(message: MailMessage): Promise<void> {
  const transport = getTransport();
  if (!transport) throw new Error('SMTP is not configured');

  await transport.sendMail({
    from: config.notifications.smtp.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });
}

/**
 * Send an email.
 *
 * @returns `true` when handed to the SMTP server, `false` when unconfigured or
 *   the send failed. Never throws: the caller's operation (a password reset
 *   request, a signal notification) succeeded or failed on its own merits, and a
 *   mail outage should not convert that into a 500.
 */
export async function sendMail(message: MailMessage): Promise<boolean> {
  try {
    await sendMailOrThrow(message);
    return true;
  } catch (err) {
    log.error({ err, to: message.to, subject: message.subject }, 'Email delivery failed');
    return false;
  }
}

/** Verify the SMTP connection, for the admin panel's provider health view. */
export async function verifyMailer(): Promise<boolean> {
  const transport = getTransport();
  if (!transport) return false;
  try {
    await transport.verify();
    return true;
  } catch (err) {
    log.warn({ err }, 'SMTP verification failed');
    return false;
  }
}

/**
 * Drain the pooled connections on shutdown.
 *
 * Without this a pooled transport keeps its sockets open and the process will
 * not exit on SIGTERM, which turns every deploy into a thirty-second wait for
 * the orchestrator's kill timer.
 */
export function closeMailer(): void {
  transporter?.close();
  transporter = null;
  initialised = false;
}
