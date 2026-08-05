/**
 * Request context: correlation ids and HTTP logging.
 *
 * Every request gets an id that flows into the log line, the error envelope and
 * the `X-Request-Id` response header. When a user reports a failure the id in
 * their error message locates the exact log entry.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../core/logger.js';

/** Accept an upstream id when present so traces span the proxy boundary. */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.get('x-request-id');
  // Bound the length and charset: this value is echoed in a response header,
  // so an unvalidated upstream string is a header-injection vector.
  const id =
    incoming && /^[\w-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.id = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).id,
  // 4xx is the client's problem, not an application error — logging it at
  // `error` makes real failures impossible to find.
  customLogLevel(_req, res, err) {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage(req, res) {
    return `${req.method} ${req.url} → ${res.statusCode}`;
  },
  // Health checks would otherwise dominate the log volume.
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/api/health',
  },
  serializers: {
    req(req) {
      return { id: req.id, method: req.method, url: req.url };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
});
