/**
 * The market stream — what turns subscriptions into messages.
 *
 * The platform's market data providers are REST adapters, so "live" here means
 * a short polling loop rather than an upstream socket. That choice is what makes
 * the provider layer interchangeable: a venue that offers no streaming API is a
 * first-class provider, and adding one that does means adding a push source that
 * calls the same {@link deliver} functions rather than rewriting the hub.
 *
 * **Nothing is fetched for an empty room.** Every tick starts by asking the hub
 * what is actually being watched and returns immediately if the answer is
 * nothing. An idle deployment must cost zero provider rate limit — a background
 * loop that polls a full symbol board with no clients attached is how a free API
 * tier is exhausted overnight, and the operator would have no way to tell from
 * the outside that it was happening.
 *
 * The registry caches every read in Redis (five seconds for quotes), so several
 * instances polling the same symbol collapse into roughly one upstream call.
 */

import { WS_CHANNELS, type Candle, type Timeframe } from '@quantdesk/shared';
import { moduleLogger } from '../core/logger.js';
import { listSymbols, resolveSymbols, type SymbolRecord } from '../modules/markets/index.js';
import { fearGreed } from '../modules/news/index.js';
import { marketRegistry } from '../providers/market/registry.js';
import { hub } from './hub.js';

const log = moduleLogger('ws:stream');

/**
 * Cadences.
 *
 * Quotes are the only sub-ten-second loop, because a price that updates every
 * thirty seconds reads as a broken dashboard. Everything else moves slowly by
 * nature — funding rates print hourly, the Fear & Greed index daily — and
 * polling them faster than they change spends rate limit on identical bytes.
 */
const QUOTE_INTERVAL_MS = 4_000;
const CANDLE_INTERVAL_MS = 15_000;
const DERIVATIVES_INTERVAL_MS = 30_000;
const FEAR_GREED_INTERVAL_MS = 5 * 60_000;

/**
 * Ceiling on the symbols the `quotes` board channel expands to.
 *
 * A deployment tracking two hundred instruments would otherwise turn one
 * dashboard subscription into a two-hundred-symbol upstream fetch every four
 * seconds. The universe is ordered by `display_order`, so the cap keeps the
 * instruments an operator chose to put first.
 */
const MAX_BOARD_SYMBOLS = 40;

/** Ceiling on concurrently streamed chart series. */
const MAX_CANDLE_STREAMS = 24;

type Timer = ReturnType<typeof setInterval>;

const timers: Timer[] = [];

/** Last known open time per candle channel, for detecting a bar close. */
const lastBarOpen = new Map<string, number>();

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Start every loop.
 *
 * `unref()` on each timer so a pending tick never holds the process open during
 * shutdown — the loops exist to serve connections, and by the time the server is
 * closing there are none left to serve.
 */
export function startMarketStream(): void {
  if (timers.length > 0) return;

  timers.push(
    every(QUOTE_INTERVAL_MS, quoteTick),
    every(CANDLE_INTERVAL_MS, candleTick),
    every(DERIVATIVES_INTERVAL_MS, derivativesTick),
    every(FEAR_GREED_INTERVAL_MS, fearGreedTick),
  );

  log.info(
    { quoteMs: QUOTE_INTERVAL_MS, candleMs: CANDLE_INTERVAL_MS },
    'Market stream started',
  );
}

export function stopMarketStream(): void {
  for (const timer of timers) clearInterval(timer);
  timers.length = 0;
  lastBarOpen.clear();
}

/**
 * Schedule a tick that cannot overlap itself.
 *
 * Without the in-flight guard a provider that starts taking eight seconds to
 * answer a four-second loop accumulates concurrent requests until the connection
 * pool or the upstream rate limit gives out — and the symptom would be a
 * *slower* provider looking like an attack from this platform.
 */
function every(intervalMs: number, tick: () => Promise<void>): Timer {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void tick()
      .catch((err: unknown) => {
        // A failed tick is a data-availability problem, not a server fault. It
        // is logged at debug because a rate-limited provider would otherwise
        // produce one error per interval, forever.
        log.debug({ err }, 'Stream tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();
  return timer;
}

/* -------------------------------------------------------------------------- */
/* Quotes                                                                     */
/* -------------------------------------------------------------------------- */

async function quoteTick(): Promise<void> {
  const wantsBoard = hub.hasSubscribers(WS_CHANNELS.quotes());
  const watched = hub.quoteSymbols();
  if (!wantsBoard && watched.length === 0) return;

  const records = await targetSymbols(watched, wantsBoard);
  if (records.length === 0) return;

  const quotes = await marketRegistry.getQuotes(records);
  if (quotes.length === 0) return;

  for (const quote of quotes) {
    hub.deliver(WS_CHANNELS.quote(quote.symbol), { type: 'quote', data: quote });
  }

  if (wantsBoard) {
    hub.deliver(WS_CHANNELS.quotes(), { type: 'quotes', data: quotes });
  }
}

/**
 * Resolve the symbols this tick should fetch.
 *
 * Individually-watched symbols are unioned with the board rather than replacing
 * it, so a chart open on an instrument outside the top of the universe still
 * ticks. Unknown symbols fall out here — `resolveSymbols` filters against the
 * tradable universe — which is why a subscription to a delisted instrument
 * simply goes quiet instead of erroring on every loop.
 */
async function targetSymbols(watched: string[], wantsBoard: boolean): Promise<SymbolRecord[]> {
  if (!wantsBoard) return resolveSymbols(watched);

  const board = (await listSymbols()).slice(0, MAX_BOARD_SYMBOLS);
  const seen = new Set(board.map((s) => s.symbol));
  const extra = (await resolveSymbols(watched)).filter((s) => !seen.has(s.symbol));

  return [...board, ...extra];
}

/* -------------------------------------------------------------------------- */
/* Candles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Push the forming bar, and the previous one at the moment it closes.
 *
 * Two bars are requested rather than one so the close is *observed* rather than
 * inferred. The alternative — deciding a bar has closed because the wall clock
 * crossed its boundary — publishes a bar the provider has not finalised, and the
 * last print of a candle is exactly the number a trader acts on.
 *
 * The forming bar is never synthesised from the quote. A chart drawn from
 * fabricated intra-bar data is indistinguishable from a real one, which is the
 * problem: the platform's whole claim is that what it displays came from a
 * venue.
 */
async function candleTick(): Promise<void> {
  const streams = hub.candleStreams().slice(0, MAX_CANDLE_STREAMS);
  if (streams.length === 0) {
    lastBarOpen.clear();
    return;
  }

  const wanted = new Set(streams.map((s) => WS_CHANNELS.candle(s.symbol, s.timeframe)));
  for (const channel of lastBarOpen.keys()) {
    if (!wanted.has(channel)) lastBarOpen.delete(channel);
  }

  const records = await resolveSymbols(streams.map((s) => s.symbol));
  const bySymbol = new Map(records.map((r) => [r.symbol, r]));

  await Promise.all(
    streams.map(async ({ symbol, timeframe }) => {
      const record = bySymbol.get(symbol);
      if (!record) return;

      try {
        const candles = await marketRegistry.getCandles(record, timeframe, 2, record.preferredProvider);
        emitCandles(symbol, timeframe, candles);
      } catch (err) {
        log.debug({ err, symbol, timeframe }, 'Candle stream tick failed');
      }
    }),
  );
}

function emitCandles(symbol: string, timeframe: Timeframe, candles: Candle[]): void {
  const forming = candles.at(-1);
  if (!forming) return;

  const channel = WS_CHANNELS.candle(symbol, timeframe);
  const previousOpen = lastBarOpen.get(channel);

  // The tracked bar rolled over: the one before the current bar is now final.
  if (previousOpen !== undefined && previousOpen !== forming.time) {
    const closed = candles.at(-2);
    if (closed && closed.time === previousOpen) {
      hub.deliver(channel, {
        type: 'candle',
        data: { symbol, timeframe, candle: closed, closed: true },
      });
    }
  }

  lastBarOpen.set(channel, forming.time);
  hub.deliver(channel, {
    type: 'candle',
    data: { symbol, timeframe, candle: forming, closed: false },
  });
}

/* -------------------------------------------------------------------------- */
/* Derivatives and sentiment                                                  */
/* -------------------------------------------------------------------------- */

async function derivativesTick(): Promise<void> {
  const symbols = hub.derivativeSymbols();
  if (symbols.length === 0) return;

  const records = await resolveSymbols(symbols);

  await Promise.all(
    records.map(async (record) => {
      // Returns null for anything without a derivatives market — an equity has
      // no funding rate, and that is absence, not failure.
      const context = await marketRegistry.getDerivatives(record);
      if (!context) return;
      hub.deliver(WS_CHANNELS.derivatives(record.symbol), {
        type: 'derivatives',
        data: context,
      });
    }),
  );
}

async function fearGreedTick(): Promise<void> {
  if (!hub.hasSubscribers(WS_CHANNELS.fearGreed())) return;

  const index = await fearGreed();
  if (!index) return;

  hub.deliver(WS_CHANNELS.fearGreed(), { type: 'fear_greed', data: index });
}
