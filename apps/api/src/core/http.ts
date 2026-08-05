/**
 * Response helpers.
 *
 * Every successful response in the API is an `ApiSuccess<T>` and every failure is
 * an `ApiFailure` (produced by the error middleware). Routing every write through
 * these helpers is what makes that true — a handler that calls `res.json(user)`
 * directly ships a body the shared client cannot parse, and nothing would catch
 * it at compile time because `res.json` accepts anything.
 */

import type { Response } from 'express';
import type { ApiSuccess, Paginated } from '@quantdesk/shared';

/** 200 with a data envelope. */
export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): void {
  const body: ApiSuccess<T> = meta ? { success: true, data, meta } : { success: true, data };
  res.status(200).json(body);
}

/** 201 for resource creation. */
export function created<T>(res: Response, data: T): void {
  res.status(201).json({ success: true, data } satisfies ApiSuccess<T>);
}

/**
 * 200 with a page of results.
 *
 * `hasMore` is derived rather than supplied, so a caller cannot report a page as
 * final while a `total` says otherwise.
 */
export function okPage<T>(
  res: Response,
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): void {
  const payload: Paginated<T> = {
    items,
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
  ok(res, payload);
}

/** 204 for successful operations with nothing to return. */
export function noContent(res: Response): void {
  res.status(204).end();
}
