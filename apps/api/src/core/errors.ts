/**
 * Typed application errors.
 *
 * Every error thrown by application code should be an `AppError` subclass so
 * the error middleware can map it to a stable code + status without guessing.
 * Unknown throwables become a 500 with no internal detail leaked to the client.
 */

import { ERROR_CODES, type ErrorCode, type ApiFieldError } from '@quantdesk/shared';

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly fields?: ApiFieldError[];
  /** Extra context recorded in logs but never returned to the client. */
  readonly context?: Record<string, unknown>;
  /** When false, the error middleware logs at `warn` instead of `error`. */
  readonly expected: boolean;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    opts: {
      fields?: ApiFieldError[];
      context?: Record<string, unknown>;
      expected?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
    if (opts.fields) this.fields = opts.fields;
    if (opts.context) this.context = opts.context;
    this.expected = opts.expected ?? status < 500;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Validation failed', fields: ApiFieldError[] = []) {
    super(422, ERROR_CODES.VALIDATION_ERROR, message, { fields });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(401, ERROR_CODES.UNAUTHORIZED, message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(403, ERROR_CODES.FORBIDDEN, message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, ERROR_CODES.NOT_FOUND, `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(409, ERROR_CODES.CONFLICT, message);
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', retryAfterSec?: number) {
    super(429, ERROR_CODES.RATE_LIMITED, message, { context: { retryAfterSec } });
  }
}

export class QuotaExceededError extends AppError {
  constructor(message = 'Daily quota exceeded for your plan') {
    super(429, ERROR_CODES.QUOTA_EXCEEDED, message);
  }
}

/** Upstream market-data or news provider failed. */
export class ProviderError extends AppError {
  constructor(provider: string, message: string, cause?: unknown) {
    super(502, ERROR_CODES.PROVIDER_ERROR, `${provider}: ${message}`, {
      context: { provider },
      cause,
    });
  }
}

/** No AI provider is configured, reachable, or enabled. */
export class AiUnavailableError extends AppError {
  constructor(message = 'No AI provider is currently available') {
    super(503, ERROR_CODES.AI_UNAVAILABLE, message);
  }
}

export class UnsupportedSymbolError extends AppError {
  constructor(symbol: string) {
    super(
      400,
      ERROR_CODES.UNSUPPORTED_SYMBOL,
      `No configured data provider can serve "${symbol}"`,
      { context: { symbol } },
    );
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super(413, ERROR_CODES.PAYLOAD_TOO_LARGE, `File exceeds the ${maxBytes} byte limit`);
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(allowed: readonly string[]) {
    super(
      415,
      ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
      `Unsupported file type. Allowed: ${allowed.join(', ')}`,
    );
  }
}

export class InternalError extends AppError {
  constructor(message = 'An unexpected error occurred', cause?: unknown) {
    super(500, ERROR_CODES.INTERNAL_ERROR, message, { cause, expected: false });
  }
}

/** Narrowing helper for `catch (e: unknown)` blocks. */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/** Best-effort message extraction from an unknown throwable. */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
