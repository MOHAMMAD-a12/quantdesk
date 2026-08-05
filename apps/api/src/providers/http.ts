/**
 * HTTP client for outbound provider calls.
 *
 * Centralised so every upstream request gets the same timeout, retry policy and
 * error translation. Without this, each adapter grows its own subtly different
 * fetch wrapper and a hung provider takes a request thread with it.
 *
 * Retries are deliberately narrow: only idempotent GETs, only on transport
 * errors and 429/5xx. A 400 or 401 is a configuration mistake — retrying it
 * wastes the caller's rate limit and delays the real diagnosis.
 */

import { request } from 'undici';
import { ProviderError } from '../core/errors.js';
import { moduleLogger } from '../core/logger.js';

const log = moduleLogger('provider:http');

export interface GetJsonOptions {
  /** Provider name, used in error messages and logs. */
  provider: string;
  url: string;
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms. */
  timeoutMs?: number;
  /** Total attempts including the first. */
  attempts?: number;
  /** Query parameters, appended and encoded. */
  query?: Record<string, string | number | boolean | undefined>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_ATTEMPTS = 3;

/** Statuses worth another attempt. */
function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

function buildUrl(url: string, query?: GetJsonOptions['query']): string {
  if (!query) return url;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

/**
 * GET and parse JSON, with bounded retries and exponential backoff.
 *
 * @throws {ProviderError} On exhausted retries, non-2xx, or unparseable body.
 */
export async function getJson<T>(options: GetJsonOptions): Promise<T> {
  const {
    provider,
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    attempts = DEFAULT_ATTEMPTS,
  } = options;

  const url = buildUrl(options.url, options.query);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'QuantDesk/1.0', ...headers },
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return (await res.body.json()) as T;
      }

      // Drain the body or undici keeps the connection open.
      const text = await res.body.text().catch(() => '');

      if (isRetryable(res.statusCode) && attempt < attempts) {
        const backoff = retryDelay(attempt, res.headers['retry-after']);
        log.warn(
          { provider, status: res.statusCode, attempt, backoff },
          'Provider request failed — retrying',
        );
        await sleep(backoff);
        continue;
      }

      throw new ProviderError(
        provider,
        `HTTP ${res.statusCode}${text ? `: ${truncate(text)}` : ''}`,
      );
    } catch (err) {
      lastError = err;

      // A ProviderError from the block above is already final.
      if (err instanceof ProviderError) throw err;

      if (attempt < attempts) {
        const backoff = retryDelay(attempt);
        log.warn({ provider, err, attempt, backoff }, 'Provider transport error — retrying');
        await sleep(backoff);
        continue;
      }
    }
  }

  throw new ProviderError(
    provider,
    `Request failed after ${attempts} attempts`,
    lastError,
  );
}

export interface PostJsonOptions extends Omit<GetJsonOptions, 'query'> {
  body: unknown;
}

/**
 * POST JSON and parse the JSON response.
 *
 * Used by the AI adapters and the notification channels. The retry policy is
 * tighter than `getJson`'s — default two attempts, and only on 429/5xx — because
 * a POST that reached the server may have had an effect even though the response
 * was lost. For completions that means a duplicate charge; for a webhook it means
 * a duplicate message. Neither is corrupting, but neither is free either.
 *
 * @throws {ProviderError} On exhausted retries, non-2xx, or unparseable body.
 */
export async function postJson<T>(options: PostJsonOptions): Promise<T> {
  const {
    provider,
    headers = {},
    timeoutMs = 60_000,
    attempts = 2,
    body,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await request(options.url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'QuantDesk/1.0',
          ...headers,
        },
        body: JSON.stringify(body),
        headersTimeout: timeoutMs,
        bodyTimeout: timeoutMs,
      });

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return (await res.body.json()) as T;
      }

      const text = await res.body.text().catch(() => '');

      if (isRetryable(res.statusCode) && attempt < attempts) {
        const backoff = retryDelay(attempt, res.headers['retry-after']);
        log.warn(
          { provider, status: res.statusCode, attempt, backoff },
          'Provider POST failed — retrying',
        );
        await sleep(backoff);
        continue;
      }

      throw new ProviderError(
        provider,
        `HTTP ${res.statusCode}${text ? `: ${truncate(text)}` : ''}`,
      );
    } catch (err) {
      lastError = err;
      if (err instanceof ProviderError) throw err;

      if (attempt < attempts) {
        const backoff = retryDelay(attempt);
        log.warn({ provider, err, attempt, backoff }, 'Provider POST transport error — retrying');
        await sleep(backoff);
        continue;
      }
    }
  }

  throw new ProviderError(provider, `POST failed after ${attempts} attempts`, lastError);
}

/**
 * POST and discard the body — for fire-and-forget webhooks that answer with
 * something other than JSON (Discord replies 204 with no content at all).
 *
 * @returns The HTTP status code.
 * @throws {ProviderError} On non-2xx or transport failure.
 */
export async function postForStatus(options: PostJsonOptions): Promise<number> {
  const { provider, headers = {}, timeoutMs = 15_000, body } = options;

  try {
    const res = await request(options.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'QuantDesk/1.0',
        ...headers,
      },
      body: JSON.stringify(body),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const text = await res.body.text().catch(() => '');
    if (res.statusCode >= 200 && res.statusCode < 300) return res.statusCode;

    throw new ProviderError(
      provider,
      `HTTP ${res.statusCode}${text ? `: ${truncate(text)}` : ''}`,
    );
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError(provider, 'POST failed', err);
  }
}

/**
 * Backoff with jitter.
 *
 * Jitter matters when several symbols fail at once: without it every retry fires
 * in the same millisecond and re-triggers the same rate limit.
 */
function retryDelay(attempt: number, retryAfterHeader?: string | string[]): number {
  const header = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, 30_000);
    }
  }
  const base = Math.min(250 * 2 ** (attempt - 1), 4_000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, max = 200): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Coerce a provider's string-or-number numeric into a number. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
