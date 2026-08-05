/**
 * Structured logging via pino.
 *
 * Redaction is non-negotiable: this logger sees request bodies and provider
 * payloads, both of which can carry credentials.
 */

import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: config.logLevel,
  base: { service: 'quantdesk-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'res.headers["set-cookie"]',
      'password',
      'newPassword',
      'currentPassword',
      '*.password',
      'token',
      'accessToken',
      'refreshToken',
      '*.apiKey',
      'apiKey',
      'body.password',
      'body.newPassword',
    ],
    censor: '[redacted]',
  },
  // Pretty output in dev; newline-delimited JSON in production for shippers.
  ...(config.isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

/** Child logger for a named subsystem, e.g. `logger.child({ module: 'engine' })`. */
export function moduleLogger(name: string) {
  return logger.child({ module: name });
}
