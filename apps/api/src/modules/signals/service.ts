/**
 * Signal generation.
 *
 * This is where the platform's central rule is enforced, so it is worth stating
 * plainly one more time:
 *
 *   **The deterministic engine decides. The model explains.**
 *
 * `generateSignal()` in `analysis/signal.ts` produces the entry, the stop, the
 * targets, the risk-reward, the probability, the risk score and the technical
 * confidence — all from candles, with no model involved. Only *after* that is an
 * LLM shown the finished verdict and asked for narrative.
 *
 * The narration step may overwrite exactly five fields:
 *
 *   reasoning, marketStructureExplanation, keyFactors, invalidation, and the
 *   `aiConviction` component of the confidence breakdown.
 *
 * It may never write a price. `SIGNAL_JSON_SCHEMA` gives the model no slot for
 * one, which is a stronger guarantee than instructing it not to — but the merge
 * below is written so that even a model that ignored the schema entirely could
 * not move a level.
 *
 * `aiConviction` is the single exception to "the model contributes no numbers",
 * and it is deliberate: conviction is the one quantity the model is actually
 * being asked for. It feeds `buildConfidence` as one weighted component among
 * six, so a wildly wrong conviction moves the published confidence but cannot
 * dominate it.
 */

import { randomUUID } from 'node:crypto';
import type {
  EconomicEvent,
  Signal,
  SignalEngineConfig,
  TechnicalAnalysis,
  Timeframe,
} from '@quantdesk/shared';
import { z } from 'zod';
import { moduleLogger } from '../../core/logger.js';
import { ProviderError } from '../../core/errors.js';
import { buildConfidence, generateSignal } from '../../analysis/signal.js';
import {
  SIGNAL_JSON_SCHEMA,
  SIGNAL_SYSTEM_PROMPT,
  buildSignalPrompt,
} from '../../providers/ai/prompts.js';
import { aiRegistry } from '../../providers/ai/registry.js';
import { extractJson } from '../../providers/ai/types.js';
import { marketRegistry } from '../../providers/market/registry.js';
import { publishSignal, publishSignalUpdate } from '../../ws/index.js';
import * as analysis from '../analysis/index.js';
import * as markets from '../markets/repository.js';
import * as news from '../news/index.js';
import * as settings from '../settings/index.js';
import * as repository from './repository.js';

const log = moduleLogger('signals');

/**
 * How far ahead to look for market-moving releases.
 *
 * Twelve hours rather than the calendar's full week: an FOMC print eight days
 * out is not a reason to hesitate on a 1h setup, and padding the prompt with
 * distant events dilutes the ones that actually fall inside the trade's horizon.
 */
const EVENT_HORIZON_MS = 12 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* The AI contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The narration response, validated rather than trusted.
 *
 * `SIGNAL_JSON_SCHEMA` is enforced by providers that support structured output,
 * but three of the four providers may not, so the same shape is re-checked here.
 * Every field is bounded: `aiConviction` is clamped to 0–100 by the schema, and
 * the strings are capped so a runaway generation cannot push a 40KB paragraph
 * into a TEXT column and out to every dashboard that renders it.
 */
const narrationSchema = z.object({
  agreesWithDirection: z.boolean(),
  aiConviction: z.number().min(0).max(100),
  reasoning: z.string().min(1).max(4000),
  marketStructureExplanation: z.string().min(1).max(4000),
  keyFactors: z.array(z.string().min(1).max(300)).min(1).max(8),
  invalidation: z.string().min(1).max(1000),
  expectedDuration: z.string().min(1).max(120),
  riskNotes: z.string().max(1000).optional().default(''),
});

type Narration = z.infer<typeof narrationSchema>;

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

export interface GenerateRequest {
  symbol: string;
  timeframe: Timeframe;
  /** Skip the LLM entirely and publish the engine's verdict as-is. */
  deterministicOnly?: boolean;
  /** Per-request floor, still clamped to the global engine minimum. */
  minConfidence?: number;
  /** The requesting user, or null for scheduler-initiated scans. */
  userId?: string | null;
  /** Persist the result. False for previews that must not pollute the record. */
  persist?: boolean;
  now?: number;
}

export interface GenerateResult {
  signal: Signal;
  /** Populated on WAIT — which gate rejected the setup. */
  waitReason: string | null;
  /** True when the narration step ran and succeeded. */
  narrated: boolean;
  /** Why narration was skipped or failed, for the admin panel. */
  narrationError: string | null;
  /** True when the daily cap suppressed persistence. */
  capped: boolean;
}

/**
 * Generate a signal for one symbol/timeframe.
 *
 * Never throws because of the AI layer. A missing key, a rate limit, a malformed
 * response and a hard provider outage all resolve to the same outcome: a complete
 * signal, `deterministicOnly: true`, and a populated `narrationError`. The
 * numbers were never the model's to produce, so losing it costs prose and
 * nothing else.
 *
 * @throws {UnsupportedSymbolError} when the symbol is not in the tradable universe
 * @throws {InsufficientDataError} when there is not enough history to analyse
 * @throws {ProviderError} when no market data provider can serve the symbol
 */
export async function generate(req: GenerateRequest): Promise<GenerateResult> {
  const {
    symbol,
    timeframe,
    deterministicOnly = false,
    userId = null,
    persist = true,
    now = Date.now(),
  } = req;

  const record = await markets.requireSymbol(symbol);
  const config = await effectiveConfig(req.minConfidence);

  // MTF is always on for signal generation, unlike the bare analysis endpoint.
  // `minMtfAlignment` is one of the gates, and evaluating it against an analysis
  // that has no MTF block would either pass everything or reject everything.
  const technical = await analysis.analyseSymbol({
    symbol: record.symbol,
    timeframe,
    mtf: true,
    correlations: false,
    lookback: config.lookbackBars,
  });

  const result = generateSignal({
    analysis: technical,
    config,
    pricePrecision: record.pricePrecision,
    generatedBy: userId,
    now,
  });

  let signal = result.signal;
  let narrated = false;
  let narrationError: string | null = null;

  // WAIT signals are not narrated. There is no trade to explain, the engine's
  // own `waitReason` already says which gate rejected it, and spending a model
  // call on every rejected scan across a fifty-symbol universe would be the
  // largest single line on the AI bill for no user-visible benefit.
  const worthNarrating = !deterministicOnly && signal.action !== 'WAIT';

  if (worthNarrating) {
    const narration = await narrate(technical, signal, record, result.waitReason, userId, now);
    if (narration.ok) {
      signal = applyNarration(signal, technical, narration.value, {
        provider: narration.provider,
        model: narration.model,
      });
      narrated = true;
    } else {
      narrationError = narration.error;
    }
  } else if (deterministicOnly) {
    narrationError = null;
  }

  // Re-gate after narration. The AI conviction feeds back into confidence, so a
  // signal that cleared `minConfidence` on technicals alone can fall below it
  // once a sceptical model has weighed in — and publishing it anyway would make
  // the threshold decorative.
  if (signal.action !== 'WAIT' && signal.confidence < config.minConfidence) {
    signal = downgradeToWait(
      signal,
      `Confidence ${signal.confidence.toFixed(1)} fell below the ${config.minConfidence} threshold after AI review`,
    );
    return {
      signal: persist ? await persistAndPublish(signal, userId) : signal,
      waitReason: signal.invalidation,
      narrated,
      narrationError,
      capped: false,
    };
  }

  // The per-symbol daily cap. Checked here rather than before generation on
  // purpose: the operator still wants to *see* the setup in a preview, and the
  // cap exists to limit what gets recorded and notified, not what gets computed.
  let capped = false;
  if (persist && signal.action !== 'WAIT') {
    const today = await repository.countTodayFor(record.symbol);
    if (today >= config.maxSignalsPerSymbolPerDay) {
      capped = true;
      log.info(
        { symbol: record.symbol, today, cap: config.maxSignalsPerSymbolPerDay },
        'Daily signal cap reached; not persisting',
      );
    }
  }

  const persisted =
    persist && !capped ? await persistAndPublish(signal, userId) : signal;

  return { signal: persisted, waitReason: result.waitReason, narrated, narrationError, capped };
}

/**
 * Write the signal and announce it on the live feed.
 *
 * The broadcast follows the write and never precedes it: a client that receives a
 * signal it cannot then fetch by id would be looking at something that does not
 * exist yet, and if the insert failed, never will. `publishSignal` does not throw
 * — a socket nobody is listening on must not fail a persisted signal.
 */
async function persistAndPublish(signal: Signal, userId: string | null): Promise<Signal> {
  const stored = await repository.insertSignal(signal, userId);
  publishSignal(stored);
  return stored;
}

/* -------------------------------------------------------------------------- */
/* Narration                                                                  */
/* -------------------------------------------------------------------------- */

type NarrationOutcome =
  | { ok: true; value: Narration; provider: string; model: string }
  | { ok: false; error: string };

/**
 * Ask the model to explain the engine's verdict.
 *
 * Returns a result rather than throwing, because every failure mode here is
 * non-fatal by design and the caller's handling is identical for all of them.
 */
async function narrate(
  technical: TechnicalAnalysis,
  signal: Signal,
  record: markets.SymbolRecord,
  waitReason: string | null,
  userId: string | null,
  now: number,
): Promise<NarrationOutcome> {
  if (!(await aiRegistry.isAvailable())) {
    return { ok: false, error: 'No AI provider is configured' };
  }

  // High-impact releases inside the signal's own horizon are the context most
  // likely to change a trader's mind about holding it. An empty list here is a
  // real answer — no calendar configured also means no events to warn about.
  let upcomingEvents: EconomicEvent[] = [];
  try {
    upcomingEvents = await news.upcomingHighImpact(EVENT_HORIZON_MS);
  } catch (err) {
    log.debug({ err }, 'Economic calendar unavailable for signal narration');
  }

  // The context block. Fetched here rather than read off `technical`, because
  // `TechnicalAnalysis` is pure candle-derived output and deliberately carries
  // no external state — the engine must be reproducible from bars alone.
  // Settled individually so a dead news feed costs the sentiment paragraph and
  // not the whole narration.
  const [derivatives, sentiment, fearGreed] = await Promise.all([
    marketRegistry.getDerivatives(record).catch(() => null),
    news.sentiment(record.symbol).catch(() => null),
    news.fearGreed().catch(() => null),
  ]);

  const prompt = buildSignalPrompt({
    analysis: technical,
    symbolName: record.name,
    assetClass: record.assetClass,
    pricePrecision: record.pricePrecision,
    proposed: {
      action: signal.action,
      entry: signal.entry,
      entryZone: signal.entryZone,
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits,
      riskRewardRatio: signal.riskRewardRatio,
      // The engine records its stop rationale inside `invalidation`; passing it
      // through means the model explains the stop that exists rather than
      // inventing a justification for one it would have chosen.
      stopRationale: signal.invalidation,
      technicalConfidence: signal.confidenceBreakdown.technical,
      waitReason,
    },
    derivatives,
    sentiment,
    fearGreed,
    upcomingEvents,
    now,
  });

  try {
    const completion = await aiRegistry.complete({
      system: SIGNAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      jsonSchema: SIGNAL_JSON_SCHEMA,
      purpose: 'signal',
      userId,
    });

    const raw = extractJson<unknown>(completion.text);
    if (raw === null) {
      return { ok: false, error: 'AI response contained no parseable JSON' };
    }

    const parsed = narrationSchema.safeParse(raw);
    if (!parsed.success) {
      // Logged at warn rather than error: a schema miss is a provider-quality
      // problem worth surfacing, not an incident. The signal still ships.
      log.warn(
        { symbol: signal.symbol, issues: parsed.error.issues.slice(0, 5) },
        'AI narration failed validation',
      );
      return { ok: false, error: 'AI response did not match the expected shape' };
    }

    return { ok: true, value: parsed.data, provider: completion.provider, model: completion.model };
  } catch (err) {
    const message =
      err instanceof ProviderError ? err.message : 'AI provider call failed';
    log.warn({ err, symbol: signal.symbol }, 'Signal narration failed');
    return { ok: false, error: message };
  }
}

/**
 * Merge narration into the signal.
 *
 * Written as an explicit field-by-field construction rather than a spread, so
 * that adding a field to `Narration` cannot silently start overwriting a
 * numeric field on `Signal`. The five text fields and `aiConviction` are the
 * whole of the model's influence, and this function is the only place that
 * influence is applied.
 */
function applyNarration(
  signal: Signal,
  technical: TechnicalAnalysis,
  narration: Narration,
  provenance: { provider: string; model: string },
): Signal {
  // Recompute confidence with the model's conviction folded in. Calling
  // `buildConfidence` rather than adjusting the number by hand keeps one
  // definition of how the six components combine — the deterministic path and
  // the narrated path must not drift into two different formulas.
  const recomputed = buildConfidence(technical, signal.bias, narration.aiConviction);

  // Disagreement is expressed as a confidence penalty, never as a direction
  // change. If the model thinks a long is wrong, that is real information about
  // uncertainty — but the structural evidence that produced the direction is
  // still there, and letting prose flip a stop and three targets would put the
  // model back in charge of the numbers.
  const confidence = narration.agreesWithDirection
    ? recomputed.overall
    : Math.round(recomputed.overall * 0.75 * 100) / 100;

  const invalidation = narration.riskNotes.trim()
    ? `${narration.invalidation} ${narration.riskNotes.trim()}`
    : narration.invalidation;

  return {
    ...signal,
    confidence,
    confidenceBreakdown: { ...recomputed, overall: confidence },
    reasoning: narration.reasoning,
    marketStructureExplanation: narration.marketStructureExplanation,
    keyFactors: narration.keyFactors,
    invalidation,
    expectedDuration: narration.expectedDuration,
    // Provenance flips: this signal's prose came from a named model, and the UI
    // badge that says so must name the run that actually happened rather than
    // the engine default `assemble()` stamped on it.
    aiProvider: provenance.provider,
    aiModel: provenance.model,
    deterministicOnly: false,
  };
}

/**
 * Convert an actionable signal into a WAIT.
 *
 * The levels must be nulled, not merely ignored: `signals_levels_consistency`
 * rejects a WAIT row carrying an entry or a stop, and the constraint is right to
 * — a WAIT displayed with a stop loss reads as a trade the user missed.
 */
function downgradeToWait(signal: Signal, reason: string): Signal {
  return {
    ...signal,
    id: signal.id || randomUUID(),
    action: 'WAIT',
    entry: null,
    entryZone: null,
    stopLoss: null,
    takeProfits: [],
    riskRewardRatio: null,
    expectedMovePercent: 0,
    invalidation: reason,
  };
}

/**
 * The engine config for this request.
 *
 * A per-request `minConfidence` may only raise the bar, never lower it. Allowing
 * a client to pass `minConfidence: 0` would let any caller bypass the operator's
 * threshold and turn every marginal read into a published signal.
 */
async function effectiveConfig(requested?: number): Promise<SignalEngineConfig> {
  const config = await settings.getSignalEngineConfig();
  if (requested === undefined) return config;
  return { ...config, minConfidence: Math.max(config.minConfidence, requested) };
}

/* -------------------------------------------------------------------------- */
/* Scanning                                                                   */
/* -------------------------------------------------------------------------- */

export interface ScanResult {
  scanned: number;
  generated: number;
  waited: number;
  failed: number;
  capped: number;
  signals: Signal[];
}

/**
 * Run the engine across the scannable universe.
 *
 * Sequential rather than concurrent, deliberately. Each symbol costs several
 * provider calls (one per MTF timeframe) plus a model call, and firing fifty of
 * those at once is the reliable way to trip an exchange rate limit and get the
 * whole scan throttled. A scan is a background job; latency is not the metric.
 *
 * Failures are counted and logged, never thrown — one delisted ticker must not
 * abort the cycle for the other forty-nine.
 */
export async function scan(options: { timeframe?: Timeframe; userId?: string | null } = {}): Promise<ScanResult> {
  const timeframe = options.timeframe ?? '1h';
  const universe = await analysis.listScannable();

  const result: ScanResult = {
    scanned: 0,
    generated: 0,
    waited: 0,
    failed: 0,
    capped: 0,
    signals: [],
  };

  for (const record of universe) {
    result.scanned += 1;
    try {
      const generated = await generate({
        symbol: record.symbol,
        timeframe,
        userId: options.userId ?? null,
        persist: true,
      });

      if (generated.capped) result.capped += 1;
      if (generated.signal.action === 'WAIT') {
        result.waited += 1;
      } else if (!generated.capped) {
        result.generated += 1;
        result.signals.push(generated.signal);
      }
    } catch (err) {
      result.failed += 1;
      log.warn({ err, symbol: record.symbol }, 'Scan failed for symbol');
    }
  }

  log.info(result, 'Scan complete');
  return result;
}

/* -------------------------------------------------------------------------- */
/* Reads & lifecycle                                                          */
/* -------------------------------------------------------------------------- */

export const list = repository.listSignals;
export const find = repository.findSignal;
export const active = repository.listActive;
export const latest = repository.latestFor;
export const accuracy = repository.accuracyByBand;
export const performance = repository.performance;

/**
 * Expire signals whose horizon has passed.
 *
 * The status change is broadcast here rather than left to the caller. An expiry
 * sweep is the one status transition no client can predict, and a dashboard
 * showing a setup as "active" twenty minutes after its horizon closed is worse
 * than showing nothing at all.
 *
 * Returns the affected ids so the scheduler can log and report the sweep.
 */
export async function expire(now = Date.now()): Promise<string[]> {
  const ids = await repository.expireStale(now);
  if (ids.length === 0) return ids;

  log.info({ count: ids.length }, 'Expired stale signals');

  // Re-read rather than patching a local copy: the row carries the resolution
  // fields the update wrote, and a broadcast that disagreed with the database
  // would resolve itself only on the client's next reload.
  const updated = await Promise.all(ids.map((id) => repository.findSignal(id).catch(() => null)));
  for (const signal of updated) {
    if (signal) publishSignalUpdate(signal);
  }

  return ids;
}

/**
 * Close a signal out with a realised result.
 *
 * The event log is written first. If the status update then fails, the record
 * shows an outcome that has not yet been applied — recoverable, and visible.
 * The reverse order would show a closed signal with no trace of why, which is
 * the failure mode that quietly corrupts a track record.
 */
export async function resolve(
  id: string,
  status: Parameters<typeof repository.updateStatus>[1],
  options: { realisedR?: number | null; price?: number | null; note?: string | null; now?: number } = {},
): Promise<Signal | null> {
  await repository.recordEvent(id, status, options.price ?? null, options.note ?? null);
  await repository.updateStatus(id, status, {
    realisedR: options.realisedR ?? null,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const updated = await repository.findSignal(id);
  if (updated) publishSignalUpdate(updated);
  return updated;
}
