/**
 * Central error handling.
 *
 * Two rules govern this file:
 *
 *  1. Every response body is an `ApiFailure` — clients parse one shape.
 *  2. Nothing internal leaks. `AppError` messages are author-written and safe to
 *     show; anything else becomes a generic 500 with the detail confined to the
 *     logs. Stack traces, SQL fragments and driver messages never reach a
 *     client, because they are a reconnaissance gift to an attacker.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiFailure, type ApiFieldError } from '@quantdesk/shared';
import { AppError, InternalError, NotFoundError, isAppError } from '../core/errors.js';
import { moduleLogger } from '../core/logger.js';
import { config } from '../core/config.js';

const log = moduleLogger('http');

/** Postgres error codes worth translating into a meaningful status. */
const PG_CODES: Record<string, { status: number; code: string; message: string }> = {
  // unique_violation
  '23505': { status: 409, code: ERROR_CODES.CONFLICT, message: 'Resource already exists' },
  '23514': {
    status: 422,
    code: ERROR_CODES.VALIDATION_ERROR,
    message: 'Value violates a database constraint',
  },
  '23503': {
    status: 422,
    code: ERROR_CODES.VALIDATION_ERROR,
    message: 'Referenced resource does not exist',
  },
};

interface PgLikeError {
  code?: string;
  constraint?: string;
}

function isPgError(e: unknown): e is PgLikeError {
  return typeof e === 'object' && e !== null && typeof (e as PgLikeError).code === 'string';
}

/** 404 for unmatched routes. Registered after all routers. */
export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
}

/**
 * Terminal error middleware. Must be registered last and must keep all four
 * parameters — Express identifies error handlers by arity.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Headers already flushed (e.g. mid-stream failure): the only correct move is
  // to destroy the socket, since the status line cannot be rewritten.
  if (res.headersSent) {
    log.error({ err, requestId: req.id }, 'Error after headers sent — destroying connection');
    res.destroy();
    return;
  }

  const appError = normalise(err);

  const logPayload = {
    err,
    requestId: req.id,
    method: req.method,
    path: req.path,
    status: appError.status,
    code: appError.code,
    userId: req.user?.id,
    ...appError.context,
  };

  // Expected failures (validation, 401, 404) are noise at `error` level; they
  // are still recorded, just not as incidents.
  if (appError.expected) {
    log.warn(logPayload, appError.message);
  } else {
    log.error(logPayload, 'Unhandled request failure');
  }

  const failure: ApiFailure = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      // pino-http types the request id as `string | number | object`; the
      // envelope declares a string. Coerce rather than assert so a numeric id
      // (e.g. from a proxied upstream) never produces a type lie at runtime.
      requestId: typeof req.id === 'string' ? req.id : String(req.id),
      ...(appError.fields?.length ? { fields: appError.fields } : {}),
    },
  };

  // Retry-After is actionable for a client that is being throttled.
  const retryAfter = appError.context?.retryAfterSec;
  if (appError.status === 429 && typeof retryAfter === 'number') {
    res.setHeader('Retry-After', String(Math.ceil(retryAfter)));
  }

  res.status(appError.status).json(failure);
}

/** Coerce anything throwable into an `AppError`. */
function normalise(err: unknown): AppError {
  if (isAppError(err)) return err;

  // A Zod error escaping the validate() middleware is still a client problem.
  if (err instanceof ZodError) {
    const fields: ApiFieldError[] = err.issues.map((i) => ({
      path: i.path.map(String).join('.'),
      message: i.message,
    }));
    return new AppError(422, ERROR_CODES.VALIDATION_ERROR, 'Request validation failed', {
      fields,
    });
  }

  // Malformed JSON body — express.json() throws a SyntaxError with `body` set.
  if (
    err instanceof SyntaxError &&
    'body' in err &&
    typeof (err as { status?: number }).status === 'number'
  ) {
    return new AppError(400, ERROR_CODES.VALIDATION_ERROR, 'Malformed JSON body');
  }

  if (isPgError(err) && err.code) {
    const mapped = PG_CODES[err.code];
    if (mapped) {
      return new AppError(mapped.status, mapped.code as never, mapped.message, {
        context: { pgCode: err.code, constraint: err.constraint },
      });
    }
  }

  // Unknown: keep the real cause in the log, return nothing specific. In dev the
  // message is surfaced to shorten the debug loop.
  const message = config.isProd
    ? 'An unexpected error occurred'
    : err instanceof Error
      ? err.message
      : String(err);
  return new InternalError(message, err);
}

/**
 * Wrap an async handler so a rejected promise reaches `errorHandler`.
 *
 * Express 4 does not await handlers — without this an async throw becomes an
 * unhandled rejection and the request hangs until it times out.
 */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void fn(req, res, next).catch(next);
  };
}
