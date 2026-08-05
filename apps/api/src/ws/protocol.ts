/**
 * WebSocket wire protocol — parsing and validation.
 *
 * The message shapes themselves live in `@quantdesk/shared` so the browser
 * client and this server cannot drift. What lives here is the *server's* side of
 * the contract: rejecting anything that does not match, and turning a channel
 * string into something the hub can act on.
 *
 * Channel names arrive from the network, which means they are attacker input.
 * `parseChannel` is a whitelist — an unrecognised channel is refused rather than
 * stored, because a subscription map keyed on arbitrary strings is a memory
 * exhaustion primitive: a single connection could otherwise register a million
 * distinct channels and hold them all in the process heap.
 */

import { z } from 'zod';
import { TIMEFRAMES, type Timeframe } from '@quantdesk/shared';

/**
 * Subscriptions one connection may hold.
 *
 * Generous enough for a dashboard watching every tracked symbol plus a chart,
 * low enough that ten thousand connections cannot each pin a large set.
 */
export const MAX_CHANNELS_PER_CONNECTION = 64;

/** Largest frame accepted. A client message is a few hundred bytes at most. */
export const MAX_PAYLOAD_BYTES = 8 * 1024;

/** Inbound message allowance, per connection, per {@link RATE_WINDOW_MS}. */
export const RATE_MAX_MESSAGES = 40;
export const RATE_WINDOW_MS = 10_000;

/* -------------------------------------------------------------------------- */
/* Client messages                                                            */
/* -------------------------------------------------------------------------- */

const channelName = z.string().trim().min(1).max(96);

/**
 * The four things a client may say.
 *
 * A discriminated union rather than a hand-rolled `switch` on `msg.type`: an
 * unknown `type`, a missing field or a wrong type all fail at one place with one
 * error path, and adding a message kind is a compile-time change on both sides.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().min(1).max(4096) }),
  z.object({ type: z.literal('subscribe'), channels: z.array(channelName).min(1).max(64) }),
  z.object({ type: z.literal('unsubscribe'), channels: z.array(channelName).min(1).max(64) }),
  z.object({ type: z.literal('ping'), ts: z.number().finite().optional() }),
]);

export type ParsedClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * Decode a frame.
 *
 * Returns `null` for anything that is not a valid message — malformed JSON,
 * binary data, an unknown type. The caller answers with a protocol error rather
 * than closing: a client bug on one message should not tear down a working
 * subscription set.
 */
export function decodeClientMessage(raw: string): ParsedClientMessage | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = clientMessageSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

export type ParsedChannel =
  | { kind: 'quote'; symbol: string }
  | { kind: 'quotes' }
  | { kind: 'candle'; symbol: string; timeframe: Timeframe }
  | { kind: 'signals'; symbol: string | null }
  | { kind: 'derivatives'; symbol: string }
  | { kind: 'fear_greed' }
  | { kind: 'user'; userId: string };

/** Matches the canonical symbol format used throughout the platform. */
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,31}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/**
 * Turn a channel string into a structured subscription, or refuse it.
 *
 * The symbol is *not* checked against the tradable universe here. That would
 * make every subscribe a database read, and the poller already skips symbols it
 * cannot resolve — a subscription to a symbol that does not exist simply never
 * produces a message, which is the correct outcome for a stale bookmark.
 */
export function parseChannel(raw: string): ParsedChannel | null {
  const channel = raw.trim();

  if (channel === 'quotes') return { kind: 'quotes' };
  if (channel === 'fear_greed') return { kind: 'fear_greed' };
  if (channel === 'signals') return { kind: 'signals', symbol: null };

  const separator = channel.indexOf(':');
  if (separator <= 0) return null;

  const prefix = channel.slice(0, separator);
  const rest = channel.slice(separator + 1);
  if (!rest) return null;

  switch (prefix) {
    case 'quote': {
      const symbol = rest.toUpperCase();
      return SYMBOL_PATTERN.test(symbol) ? { kind: 'quote', symbol } : null;
    }
    case 'derivatives': {
      const symbol = rest.toUpperCase();
      return SYMBOL_PATTERN.test(symbol) ? { kind: 'derivatives', symbol } : null;
    }
    case 'signals': {
      const symbol = rest.toUpperCase();
      return SYMBOL_PATTERN.test(symbol) ? { kind: 'signals', symbol } : null;
    }
    case 'candle': {
      const divider = rest.lastIndexOf(':');
      if (divider <= 0) return null;
      const symbol = rest.slice(0, divider).toUpperCase();
      const timeframe = rest.slice(divider + 1);
      if (!SYMBOL_PATTERN.test(symbol) || !isTimeframe(timeframe)) return null;
      return { kind: 'candle', symbol, timeframe };
    }
    case 'user': {
      // A uuid, not merely a non-empty string: `user:` channels are the private
      // notification path, and the id is compared against the authenticated
      // principal below. Constraining the shape keeps the subscription map from
      // accumulating junk keys even before that check runs.
      return UUID_PATTERN.test(rest) ? { kind: 'user', userId: rest.toLowerCase() } : null;
    }
    default:
      return null;
  }
}

/**
 * Canonical form of a parsed channel.
 *
 * Subscriptions are stored under this rather than the raw string so that
 * `quote:btcusdt` and `quote:BTCUSDT` are one entry and one delivery, not two.
 */
export function canonicalChannel(parsed: ParsedChannel): string {
  switch (parsed.kind) {
    case 'quote':
      return `quote:${parsed.symbol}`;
    case 'quotes':
      return 'quotes';
    case 'candle':
      return `candle:${parsed.symbol}:${parsed.timeframe}`;
    case 'signals':
      return parsed.symbol ? `signals:${parsed.symbol}` : 'signals';
    case 'derivatives':
      return `derivatives:${parsed.symbol}`;
    case 'fear_greed':
      return 'fear_greed';
    case 'user':
      return `user:${parsed.userId}`;
  }
}
