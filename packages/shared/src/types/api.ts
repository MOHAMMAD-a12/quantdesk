/**
 * Transport contracts: REST envelopes and WebSocket message shapes.
 * Shared verbatim by the API and the web client so drift is a compile error.
 */

import type { Quote, Candle, Timeframe, FearGreedIndex, DerivativesContext } from './market.js';
import type { Signal } from './signal.js';

// ---------------------------------------------------------------------------
// REST envelopes
// ---------------------------------------------------------------------------

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiFieldError {
  path: string;
  message: string;
}

export interface ApiFailure {
  success: false;
  error: {
    /** Stable machine code, e.g. `VALIDATION_ERROR`, `RATE_LIMITED`. */
    code: string;
    message: string;
    /** Present on 422 validation failures. */
    fields?: ApiFieldError[];
    /** Correlation id for log lookup. */
    requestId?: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Canonical error codes. Kept in sync with apps/api/src/core/errors.ts. */
export const ERROR_CODES = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  UNSUPPORTED_SYMBOL: 'UNSUPPORTED_SYMBOL',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

/** Client → server. */
export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; channels: string[] }
  | { type: 'unsubscribe'; channels: string[] }
  | { type: 'ping'; ts: number };

/** Server → client. */
export type ServerMessage =
  | { type: 'welcome'; connectionId: string; serverTime: number }
  | { type: 'authenticated'; userId: string; role: string }
  | { type: 'subscribed'; channels: string[] }
  | { type: 'unsubscribed'; channels: string[] }
  | { type: 'quote'; data: Quote }
  | { type: 'quotes'; data: Quote[] }
  | { type: 'candle'; data: { symbol: string; timeframe: Timeframe; candle: Candle; closed: boolean } }
  | { type: 'signal'; data: Signal }
  | { type: 'fear_greed'; data: FearGreedIndex }
  | { type: 'derivatives'; data: DerivativesContext }
  | { type: 'notification'; data: { kind: string; title: string; body: string; link: string | null } }
  | { type: 'pong'; ts: number; serverTime: number }
  | { type: 'error'; code: string; message: string };

/**
 * Channel naming convention:
 *   `quote:BTCUSDT`             — per-symbol quote stream
 *   `quotes`                    — all tracked symbols, batched
 *   `candle:BTCUSDT:1m`         — per-symbol/timeframe candle stream
 *   `signals`                   — all public signals
 *   `signals:BTCUSDT`           — per-symbol signals
 *   `user:<userId>`             — private notifications (requires auth)
 *   `fear_greed`                — global sentiment gauge
 *   `derivatives:BTCUSDT`       — funding / OI updates
 */
export const WS_CHANNELS = {
  quote: (symbol: string) => `quote:${symbol}`,
  quotes: () => 'quotes',
  candle: (symbol: string, tf: Timeframe) => `candle:${symbol}:${tf}`,
  signals: () => 'signals',
  signalsFor: (symbol: string) => `signals:${symbol}`,
  user: (userId: string) => `user:${userId}`,
  fearGreed: () => 'fear_greed',
  derivatives: (symbol: string) => `derivatives:${symbol}`,
} as const;

/** Channels that require an authenticated connection. */
export function channelRequiresAuth(channel: string): boolean {
  return channel.startsWith('user:');
}
