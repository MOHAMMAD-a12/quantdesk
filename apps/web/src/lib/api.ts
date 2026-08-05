import type { ApiFailure, ApiResponse, ApiSuccess, Paginated } from '@quantdesk/shared';
import { browserEnv, serverApiUrl } from './env';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: ApiFailure['error']['fields'];
  readonly requestId: string | undefined;

  constructor(status: number, error: ApiFailure['error']) {
    super(error.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = error.code;
    this.fields = error.fields;
    this.requestId = error.requestId;
  }
}

export interface RequestOptions extends Omit<RequestInit, 'body' | 'headers'> {
  accessToken?: string | null;
  body?: unknown;
  headers?: HeadersInit;
  /** `server` uses Compose's private URL; client calls use the public URL. */
  target?: 'browser' | 'server';
}

/**
 * The single REST boundary. Every response reaches the UI through the shared
 * `ApiSuccess` / `ApiFailure` envelope, which keeps a reverse-proxy HTML error
 * or a malformed payload from becoming a mysterious undefined property later.
 */
export async function apiResult<T>(path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
  const { accessToken, body, headers, target = 'browser', ...init } = options;
  const base = target === 'server' ? serverApiUrl : browserEnv.NEXT_PUBLIC_API_URL;
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');

  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);

  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as ApiResponse<T> | null;
  if (!payload || typeof payload !== 'object' || !('success' in payload)) {
    throw new ApiError(response.status, {
      code: 'INVALID_API_RESPONSE',
      message: 'The API returned an unexpected response.',
    });
  }

  if (!payload.success) throw new ApiError(response.status, payload.error);
  if (!response.ok) {
    throw new ApiError(response.status, {
      code: 'HTTP_ERROR',
      message: `Request failed with status ${response.status}`,
    });
  }

  return payload;
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  return (await apiResult<T>(path, options)).data;
}

export async function apiPage<T>(path: string, options: RequestOptions = {}): Promise<Paginated<T>> {
  return api<Paginated<T>>(path, options);
}

export function isApiSuccess<T>(value: ApiResponse<T>): value is ApiSuccess<T> {
  return value.success;
}
