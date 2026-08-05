/**
 * Zod request validation.
 *
 * The schemas live in `@quantdesk/shared` and are the *same* objects the web
 * forms validate against, so client and server can never disagree about what a
 * valid request looks like.
 *
 * Validated output replaces the raw input. That is deliberate: downstream
 * handlers receive parsed, coerced, stripped data and cannot accidentally read
 * an unvalidated field that a client smuggled in.
 */

import type { NextFunction, Request, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import type { ApiFieldError } from '@quantdesk/shared';
import { ValidationError } from '../core/errors.js';

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

function toFieldErrors(err: ZodError, source: string): ApiFieldError[] {
  return err.issues.map((issue) => ({
    path: [source, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

/**
 * Validate any combination of body/query/params.
 *
 * All three parts are checked before throwing so the client sees every problem
 * at once rather than fixing them one round-trip at a time.
 */
export function validate(schemas: RequestSchemas) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const fields: ApiFieldError[] = [];

    if (schemas.body) {
      const parsed = schemas.body.safeParse(req.body);
      if (parsed.success) req.body = parsed.data;
      else fields.push(...toFieldErrors(parsed.error, 'body'));
    }

    if (schemas.query) {
      const parsed = schemas.query.safeParse(req.query);
      // Express 4 defines `query` as a getter on some versions; assigning via
      // defineProperty keeps this working regardless.
      if (parsed.success) {
        Object.defineProperty(req, 'query', {
          value: parsed.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        fields.push(...toFieldErrors(parsed.error, 'query'));
      }
    }

    if (schemas.params) {
      const parsed = schemas.params.safeParse(req.params);
      if (parsed.success) {
        Object.defineProperty(req, 'params', {
          value: parsed.data,
          writable: true,
          configurable: true,
          enumerable: true,
        });
      } else {
        fields.push(...toFieldErrors(parsed.error, 'params'));
      }
    }

    if (fields.length > 0) {
      next(new ValidationError('Request validation failed', fields));
      return;
    }
    next();
  };
}

/**
 * Typed accessors for validated request parts.
 *
 * Express's own types can't know what `validate()` produced, so these give
 * handlers a checked view without scattering `as` casts through the routes.
 */
export function body<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return req.body as z.infer<S>;
}

export function queryOf<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return req.query as unknown as z.infer<S>;
}

export function paramsOf<S extends ZodTypeAny>(req: Request, _schema: S): z.infer<S> {
  return req.params as unknown as z.infer<S>;
}
