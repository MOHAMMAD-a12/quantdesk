/**
 * Chart-screenshot analysis.
 *
 * The one feature in the platform where the model genuinely *is* the measuring
 * instrument. Everywhere else the rule is that the LLM never produces a number;
 * here there is no candle series to compute from — the only source of a price
 * level is what is legible on the image. That inversion is why this module is
 * unusually defensive about provenance:
 *
 *   - `priceScaleReadable` travels with the report, so a UI can refuse to draw a
 *     level the model admitted it inferred from pixel position rather than read
 *     from an axis.
 *   - When the uploaded chart names a symbol we track, the live deterministic
 *     read is attached to the prompt purely as a cross-check. A screenshot taken
 *     three days ago and analysed as current is a real and expensive failure
 *     mode, and a material price disagreement is the only signal available to
 *     catch it.
 *   - Nothing here writes to `signals`. An image read is a second opinion, never
 *     a tracked prediction, because its inputs cannot be reproduced later.
 *
 * Ordering: bytes are normalised, written and recorded *before* the vision call.
 * A model call that times out or blows the quota then leaves a `failed` row with
 * the reason attached, rather than a spinner and nothing on the server.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import type {
  DetectedLevel,
  DetectedZone,
  ImageAnalysis,
  ImageAnalysisReport,
  SupportedImageMime,
  Timeframe,
  UserRole,
} from '@quantdesk/shared';
import { imageMimeSchema } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import {
  PayloadTooLargeError,
  QuotaExceededError,
  UnsupportedMediaTypeError,
  ValidationError,
} from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import {
  aiRegistry,
  buildImagePrompt,
  extractJson,
  IMAGE_JSON_SCHEMA,
  IMAGE_SYSTEM_PROMPT,
} from '../../providers/ai/index.js';
import * as analysis from '../analysis/index.js';
import * as markets from '../markets/repository.js';
import * as repository from './repository.js';

const log = moduleLogger('images');

/**
 * Vision calls need a larger ceiling than text synthesis: the response carries
 * up to six supports, six resistances, five order blocks, five liquidity zones
 * and a multi-paragraph narrative, and a truncated JSON object fails validation
 * entirely rather than degrading.
 */
const MAX_TOKENS = 4096;

/** Uploads a single user may analyse per UTC day, by role. */
const DAILY_UPLOAD_CAP: Record<UserRole, number> = {
  free: 5,
  premium: 60,
  admin: 0, // Unlimited.
};

/**
 * Longest edge of the stored image, in pixels.
 *
 * Chart screenshots arrive as 4K captures where the axis labels are legible at a
 * fraction of that. Downscaling cuts the base64 payload — and therefore the
 * per-call token cost, which scales with image area — while keeping the text
 * crisp enough to read. Below roughly 1600px, price axis digits start to blur on
 * dense charts, which is precisely the information the model is here to extract.
 */
const MAX_EDGE = 1920;

/* -------------------------------------------------------------------------- */
/* The model's response contract                                              */
/* -------------------------------------------------------------------------- */

/**
 * Zod mirror of {@link IMAGE_JSON_SCHEMA}.
 *
 * Deliberately lenient about *presence* and strict about *shape*: a vision model
 * that omits `caveats` should not fail the whole analysis, but a `price` that
 * arrives as the string "around 42000" must not reach a chart-drawing routine.
 * Defaults fill the gaps; wrong types are rejected.
 */
const detectedLevelSchema = z.object({
  price: z.number().finite(),
  confidence: z.number().min(0).max(100).default(50),
  note: z.string().max(400).default(''),
});

const visionSchema = z.object({
  isChart: z.boolean(),
  readability: z.enum(['clear', 'partial', 'poor']).default('partial'),
  detectedSymbol: z.string().max(64).nullable().default(null),
  detectedTimeframe: z.string().max(32).nullable().default(null),
  trend: z.enum(['uptrend', 'downtrend', 'ranging']).default('ranging'),
  summary: z.string().max(8000).default(''),
  supportLevels: z.array(detectedLevelSchema).max(12).default([]),
  resistanceLevels: z.array(detectedLevelSchema).max(12).default([]),
  patterns: z
    .array(
      z.object({
        name: z.string().max(120),
        direction: z.enum(['bullish', 'bearish', 'neutral']).default('neutral'),
        confidence: z.number().min(0).max(100).default(50),
      }),
    )
    .max(16)
    .default([]),
  indicators: z
    .array(z.object({ name: z.string().max(80), reading: z.string().max(400).default('') }))
    .max(16)
    .default([]),
  orderBlocks: z
    .array(
      z.object({
        low: z.number().finite(),
        high: z.number().finite(),
        direction: z.enum(['bullish', 'bearish']),
        note: z.string().max(400).default(''),
      }),
    )
    .max(10)
    .default([]),
  liquidityZones: z
    .array(
      z.object({
        price: z.number().finite(),
        type: z.enum(['buy_side', 'sell_side']),
        note: z.string().max(400).default(''),
      }),
    )
    .max(10)
    .default([]),
  breakouts: z
    .array(
      z.object({
        level: z.number().finite(),
        direction: z.enum(['bullish', 'bearish']),
        confirmed: z.boolean().default(false),
        note: z.string().max(400).default(''),
      }),
    )
    .max(8)
    .default([]),
  tradeIdea: z
    .object({
      action: z.enum(['BUY', 'SELL', 'WAIT']),
      entry: z.number().finite().nullable().default(null),
      stopLoss: z.number().finite().nullable().default(null),
      takeProfits: z.array(z.number().finite()).max(5).default([]),
      riskReward: z.number().finite().nullable().default(null),
      rationale: z.string().max(4000).default(''),
    })
    .nullable()
    .default(null),
  confidence: z.number().min(0).max(100).default(0),
  caveats: z.array(z.string().max(400)).max(10).default([]),
});

type VisionResponse = z.infer<typeof visionSchema>;

/* -------------------------------------------------------------------------- */
/* Model shape → domain shape                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Translate the model's response into {@link ImageAnalysisReport}.
 *
 * The two shapes differ on purpose. The prompt schema is organised the way a
 * chart analyst works through an image — supports, then resistances, then blocks,
 * then a trade idea — because a schema that reads like the task produces better
 * completions. The domain type is organised the way the UI and the rest of the
 * platform consume it, with order blocks and liquidity pools collapsed into one
 * `zones` array because they render identically as shaded rectangles.
 *
 * Keeping the translation in one explicit function, rather than reusing one type
 * for both, means changing the prompt to improve completions cannot silently
 * change what a stored report means.
 */
function toReport(v: VisionResponse, hintedSymbol: string | null): ImageAnalysisReport {
  const zones: DetectedZone[] = [
    ...v.orderBlocks.map(
      (b): DetectedZone => ({
        kind: 'order_block',
        direction: b.direction,
        // Normalised: the model occasionally reports the pair inverted, and a
        // top below its bottom would render as a zero-height rectangle.
        top: Math.max(b.high, b.low),
        bottom: Math.min(b.high, b.low),
        note: b.note,
        confidence: v.confidence,
      }),
    ),
    ...v.liquidityZones.map(
      (l): DetectedZone => ({
        kind: 'liquidity',
        // Buy-side liquidity sits above price and is what a bullish sweep runs
        // into, so it is drawn bearish for the trader looking at it.
        direction: l.type === 'buy_side' ? 'bearish' : 'bullish',
        // A liquidity pool is a price, not a band. Both edges carry it so the
        // renderer can draw a hairline zone without special-casing.
        top: l.price,
        bottom: l.price,
        note: l.note,
        confidence: v.confidence,
      }),
    ),
  ];

  const idea = v.tradeIdea;

  const levelsFrom = (
    items: VisionResponse['supportLevels'],
    kind: DetectedLevel['kind'],
  ): DetectedLevel[] =>
    items.map((l) => ({ price: l.price, label: l.note, kind, confidence: l.confidence }));

  return {
    // The model's own reading wins over the user's hint when both are present:
    // the point of the feature is what is on the chart, and a mismatch is
    // surfaced through `warnings` rather than resolved silently.
    detectedPlatform: null,
    detectedSymbol: v.detectedSymbol ?? hintedSymbol,
    detectedTimeframe: v.detectedTimeframe,
    // Only a clear axis justifies treating the numbers as prices. On a partial
    // or poor read they are approximations, and the UI needs to know which.
    priceScaleReadable: v.readability === 'clear',

    trend: v.isChart ? v.trend : 'unclear',
    trendNote: v.summary.slice(0, 600),

    supports: levelsFrom(v.supportLevels, 'support'),
    resistances: levelsFrom(v.resistanceLevels, 'resistance'),
    zones,
    patterns: v.patterns.map((p) => `${p.name} (${p.direction}, ${Math.round(p.confidence)}%)`),
    indicatorsVisible: v.indicators.map((i) =>
      i.reading ? `${i.name}: ${i.reading}` : i.name,
    ),
    breakouts: v.breakouts.map(
      (b) =>
        `${b.direction === 'bullish' ? 'Upside' : 'Downside'} break of ${b.level}` +
        `${b.confirmed ? ' (confirmed)' : ' (unconfirmed)'}${b.note ? ` — ${b.note}` : ''}`,
    ),

    // WAIT and an absent trade idea are the same statement about direction.
    bias: idea === null ? 'neutral' : idea.action === 'BUY' ? 'long' : idea.action === 'SELL' ? 'short' : 'neutral',
    entry: idea?.entry ?? null,
    stopLoss: idea?.stopLoss ?? null,
    takeProfits: idea?.takeProfits ?? [],
    riskRewardRatio: idea?.riskReward ?? null,

    report: buildNarrative(v),
    confidence: v.isChart ? v.confidence : 0,
    warnings: buildWarnings(v, hintedSymbol),
  };
}

/**
 * Compose the long-form report.
 *
 * The model returns a summary and, separately, a rationale for its trade idea.
 * Presenting them as two disconnected blocks in the UI reads as an unfinished
 * thought, so they are joined here with the setup stated in between.
 */
function buildNarrative(v: VisionResponse): string {
  if (!v.isChart) {
    return 'The uploaded image does not appear to be a price chart, so no technical read was produced.';
  }

  const parts: string[] = [v.summary.trim()];

  if (v.tradeIdea && v.tradeIdea.action !== 'WAIT') {
    const t = v.tradeIdea;
    const levels = [
      t.entry !== null ? `entry ${t.entry}` : null,
      t.stopLoss !== null ? `stop ${t.stopLoss}` : null,
      t.takeProfits.length > 0 ? `targets ${t.takeProfits.join(' / ')}` : null,
      t.riskReward !== null ? `R:R ${t.riskReward.toFixed(2)}` : null,
    ].filter((s): s is string => s !== null);

    parts.push(
      `Setup: ${t.action}${levels.length > 0 ? ` — ${levels.join(', ')}` : ''}.\n\n${t.rationale.trim()}`,
    );
  } else if (v.tradeIdea?.rationale) {
    parts.push(`No actionable setup: ${v.tradeIdea.rationale.trim()}`);
  }

  return parts.filter((p) => p.length > 0).join('\n\n');
}

/**
 * Assemble the caveats a trader must see before acting on the read.
 *
 * The model's own `caveats` are only part of it. Readability and hint mismatches
 * are things the *server* knows and the model either cannot or will not
 * volunteer, and both change how much weight the numbers deserve.
 */
function buildWarnings(v: VisionResponse, hintedSymbol: string | null): string[] {
  const warnings: string[] = [];

  if (!v.isChart) {
    warnings.push('This image was not recognised as a price chart.');
  }

  if (v.readability === 'poor') {
    warnings.push(
      'The chart was hard to read — treat every price level as approximate and verify against a live chart before acting.',
    );
  } else if (v.readability === 'partial') {
    warnings.push('Parts of the chart were unclear; some levels may be imprecise.');
  }

  if (
    hintedSymbol !== null &&
    v.detectedSymbol !== null &&
    !sameSymbol(hintedSymbol, v.detectedSymbol)
  ) {
    warnings.push(
      `You said this is ${hintedSymbol}, but the chart appears to show ${v.detectedSymbol}. The analysis describes what is in the image.`,
    );
  }

  // A stop on the wrong side of entry is the single most dangerous thing a
  // vision read can get wrong, because it inverts the risk calculation for
  // anyone who copies the levels.
  const idea = v.tradeIdea;
  if (idea && idea.entry !== null && idea.stopLoss !== null) {
    const stopBelow = idea.stopLoss < idea.entry;
    if (idea.action === 'BUY' && !stopBelow) {
      warnings.push('The proposed stop is not below entry for a long — the levels are inconsistent.');
    }
    if (idea.action === 'SELL' && stopBelow) {
      warnings.push('The proposed stop is not above entry for a short — the levels are inconsistent.');
    }
  }

  warnings.push(...v.caveats.map((c) => c.trim()).filter((c) => c.length > 0));

  return warnings;
}

/** Loose symbol comparison — "BTCUSDT", "BTC/USDT" and "btcusd" are one instrument. */
function sameSymbol(a: string, b: string): boolean {
  const norm = (s: string): string => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/T$/, '');
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(y) || y.startsWith(x);
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

export interface UploadRequest {
  userId: string;
  role: UserRole;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
  symbolHint?: string | undefined;
  timeframeHint?: Timeframe | undefined;
  userNote?: string | undefined;
}

export interface UploadResult {
  analysis: ImageAnalysis;
  /** Remaining uploads today, or null when the role is unlimited. */
  remainingToday: number | null;
}

/**
 * Normalise, store and analyse an uploaded chart.
 *
 * Runs the vision call inline rather than queueing it. A user who has just
 * uploaded a screenshot is waiting on the answer, and a job queue would add
 * infrastructure and a polling round-trip to buy nothing they can perceive. The
 * `pending → processing → completed` states exist regardless, because they are
 * what makes a crashed call recoverable.
 */
export async function upload(req: UploadRequest): Promise<UploadResult> {
  const mime = parseMime(req.mimeType);

  if (req.buffer.length === 0) {
    throw new ValidationError('The uploaded file is empty');
  }
  if (req.buffer.length > config.uploads.maxBytes) {
    throw new PayloadTooLargeError(config.uploads.maxBytes);
  }

  const remainingToday = await enforceDailyCap(req.userId, req.role);

  const normalised = await normalise(req.buffer, mime);
  const storedPath = await persist(normalised.buffer, normalised.extension);

  let record: ImageAnalysis;
  try {
    record = await repository.insertUpload({
      userId: req.userId,
      fileName: safeFileName(req.fileName),
      storedPath,
      mimeType: normalised.mime,
      sizeBytes: normalised.buffer.length,
      width: normalised.width,
      height: normalised.height,
      symbolHint: req.symbolHint ?? null,
      timeframeHint: req.timeframeHint ?? null,
      notes: req.userNote ?? null,
    });
  } catch (error) {
    // The row is the only reference to the file. Without it the bytes are
    // unreachable and would sit on disk until the retention job noticed.
    await unlink(storedPath).catch(() => undefined);
    throw error;
  }

  const analysed = await analyse(record, normalised.buffer, normalised.mime, req);

  return { analysis: analysed, remainingToday };
}

/**
 * Run the vision call and attach the result.
 *
 * Never throws for an AI-layer failure. Missing credential, exhausted quota,
 * malformed JSON and a hard provider outage all resolve to a `failed` row whose
 * `error` explains itself — the client already has an upload id, and turning a
 * provider problem into a 500 would lose it.
 */
async function analyse(
  record: ImageAnalysis,
  buffer: Buffer,
  mime: SupportedImageMime,
  req: UploadRequest,
): Promise<ImageAnalysis> {
  const claimed = await repository.claimForProcessing(record.id);
  if (!claimed) {
    // Another worker owns it. Report current state rather than paying for a
    // second vision call on the same bytes.
    return (await repository.findImage(record.id)) ?? record;
  }

  try {
    const liveContext = await resolveLiveContext(req.symbolHint, req.timeframeHint);

    const prompt = buildImagePrompt({
      symbolHint: req.symbolHint ?? null,
      timeframeHint: req.timeframeHint ?? null,
      notes: req.userNote ?? null,
      liveContext,
    });

    const completion = await aiRegistry.complete({
      system: IMAGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      images: [{ base64: buffer.toString('base64'), mediaType: mime }],
      jsonSchema: IMAGE_JSON_SCHEMA,
      maxTokens: MAX_TOKENS,
      purpose: 'image_analysis',
      userId: req.userId,
    });

    const raw = extractJson<unknown>(completion.text);
    if (raw === null) {
      throw new Error('The vision model did not return parseable JSON');
    }

    const parsed = visionSchema.safeParse(raw);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new Error(
        `The vision model's response did not match the expected shape${
          first ? `: ${first.path.join('.')} — ${first.message}` : ''
        }`,
      );
    }

    const report = toReport(parsed.data, req.symbolHint ?? null);

    const completed = await repository.completeAnalysis(record.id, report, {
      provider: completion.provider,
      model: completion.model,
    });

    return completed ?? record;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Image analysis failed';
    log.warn({ err: error, imageId: record.id }, 'Chart image analysis failed');

    const failed = await repository.failAnalysis(record.id, message);
    return failed ?? { ...record, status: 'failed', error: message };
  }
}

/**
 * Fetch our own read on the hinted symbol, for cross-checking.
 *
 * Entirely best-effort. The image is the subject of the analysis; this is only
 * here so the model can say "the price on this screenshot is nowhere near the
 * current price". A failure to produce it must not fail the upload.
 */
async function resolveLiveContext(
  symbolHint: string | undefined,
  timeframeHint: Timeframe | undefined,
): Promise<
  { symbol: string; timeframe: Timeframe; price: number; pricePrecision: number; trend: string; confluenceScore: number } | null
> {
  if (!symbolHint) return null;

  try {
    const record = await markets.findSymbol(symbolHint);
    if (!record) return null;

    const timeframe: Timeframe = timeframeHint ?? '1h';
    const technical = await analysis.analyseSymbol({ symbol: record.symbol, timeframe });

    // A synthetic candle is not a cross-check — it would invite the model to
    // flag a mismatch against a number the platform made up.
    if (technical.synthetic) return null;

    return {
      symbol: technical.symbol,
      timeframe: technical.timeframe,
      price: technical.price,
      pricePrecision: record.pricePrecision,
      trend: technical.smc.structure.trend,
      confluenceScore: technical.confluenceScore,
    };
  } catch (error) {
    log.debug({ err: error, symbol: symbolHint }, 'Live cross-check unavailable for image analysis');
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* File handling                                                              */
/* -------------------------------------------------------------------------- */

function parseMime(value: string): SupportedImageMime {
  // Browsers append parameters ("image/jpeg; charset=binary") on some uploads.
  const bare = value.split(';')[0]?.trim().toLowerCase() ?? '';
  const parsed = imageMimeSchema.safeParse(bare);
  if (!parsed.success) {
    throw new UnsupportedMediaTypeError(imageMimeSchema.options);
  }
  return parsed.data;
}

interface Normalised {
  buffer: Buffer;
  mime: SupportedImageMime;
  extension: string;
  width: number | null;
  height: number | null;
}

/**
 * Re-encode the upload.
 *
 * Three things happen here, and all three matter:
 *
 *   1. **The declared MIME type is verified against the actual bytes.** A client
 *      can claim anything; `sharp` only reports a format it could genuinely
 *      decode. This is the check that stops a non-image being stored and later
 *      served back under an image content type.
 *   2. **Metadata is stripped.** Phone and desktop screenshots carry EXIF, which
 *      on a trading screenshot can include GPS coordinates. Storing that — and
 *      forwarding it to a third-party model — is a privacy leak the user did not
 *      consent to by uploading a chart.
 *   3. **Oversized images are downscaled.** Vision cost scales with area.
 *
 * Re-encoding also normalises animated or multi-frame WebP to a single frame,
 * which is what every vision provider expects.
 */
async function normalise(input: Buffer, declared: SupportedImageMime): Promise<Normalised> {
  let pipeline: sharp.Sharp;
  let metadata: sharp.Metadata;

  try {
    pipeline = sharp(input, { failOn: 'error' });
    metadata = await pipeline.metadata();
  } catch {
    throw new ValidationError('The uploaded file could not be read as an image');
  }

  const actual = formatToMime(metadata.format);
  if (actual === null) {
    throw new UnsupportedMediaTypeError(imageMimeSchema.options);
  }
  if (actual !== declared) {
    throw new ValidationError(
      `The file was uploaded as ${declared} but its contents are ${actual}`,
    );
  }

  const width = metadata.width ?? null;
  const height = metadata.height ?? null;
  const longestEdge = Math.max(width ?? 0, height ?? 0);

  let work = pipeline.rotate(); // Applies EXIF orientation before it is discarded.

  if (longestEdge > MAX_EDGE) {
    work = work.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  }

  // PNG throughout: charts are flat-colour line art with text, which PNG encodes
  // losslessly and compactly. JPEG artefacts land exactly on the thin lines and
  // small digits the model needs to read, and a screenshot re-encoded as JPEG can
  // lose the last digit of a price label outright.
  const buffer = await work.png({ compressionLevel: 9 }).toBuffer();
  const out = await sharp(buffer).metadata();

  return {
    buffer,
    mime: 'image/png',
    extension: 'png',
    width: out.width ?? width,
    height: out.height ?? height,
  };
}

function formatToMime(format: string | undefined): SupportedImageMime | null {
  switch (format) {
    case 'png':
      return 'image/png';
    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    default:
      return null;
  }
}

/**
 * Write the bytes under a generated name.
 *
 * The user's filename never reaches the filesystem — it is stored as a label in
 * the database and nothing more. A name from an upload is attacker-controlled
 * input, and the list of ways it can escape a directory is longer than the list
 * of ways to sanitise it.
 *
 * Files are sharded by UTC date so the retention job can reason about a day's
 * uploads, and no single directory accumulates every image the platform has ever
 * seen.
 */
async function persist(buffer: Buffer, extension: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const dir = join(config.uploads.dir, day);
  await mkdir(dir, { recursive: true });

  const target = join(dir, `${randomUUID()}.${extension}`);
  await sharp(buffer).toFile(target);
  return target;
}

/** Keep a display name that is safe to render and to send in a header. */
function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'chart';
  const cleaned = base.replace(/[^\w.\- ]/g, '_').trim();
  return (cleaned.length > 0 ? cleaned : 'chart').slice(0, 200);
}

/* -------------------------------------------------------------------------- */
/* Quota                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Enforce the per-day upload cap.
 *
 * Separate from the AI quota in the registry, and counted in Postgres rather than
 * Redis. Vision is the most expensive call the platform makes, and this cap is
 * what stops one free account spending an operator's model budget in an
 * afternoon — so unlike the rate limiter it must not fail open, and unlike the
 * Redis quota counter it must survive a cache restart.
 *
 * @returns Remaining uploads today, or null when the role is unlimited.
 */
async function enforceDailyCap(userId: string, role: UserRole): Promise<number | null> {
  const cap = DAILY_UPLOAD_CAP[role];
  if (cap <= 0) return null;

  const used = await repository.countTodayForUser(userId);
  if (used >= cap) {
    throw new QuotaExceededError(
      `You have used all ${cap} chart analyses available on your plan today. The limit resets at 00:00 UTC.`,
    );
  }

  // `used` already excludes the upload about to be recorded.
  return cap - used - 1;
}

/* -------------------------------------------------------------------------- */
/* Reads and maintenance                                                      */
/* -------------------------------------------------------------------------- */

export async function find(id: string): Promise<ImageAnalysis | null> {
  return repository.findImage(id);
}

export async function list(
  userId: string,
  page: number,
  pageSize: number,
): Promise<{ items: ImageAnalysis[]; total: number }> {
  return repository.listForUser(userId, page, pageSize);
}

/** The stored file, for the authenticated media route. */
export async function fileFor(
  id: string,
): Promise<{ path: string; mime: string; userId: string } | null> {
  return repository.storedPathOf(id);
}

/** Delete an analysis and its bytes. Returns false when nothing was owned. */
export async function remove(id: string, userId: string): Promise<boolean> {
  const path = await repository.deleteImage(id, userId);
  if (path === null) return false;

  // The row is already gone, so a failed unlink leaves only an orphaned file for
  // the retention job — not a broken record.
  await unlink(path).catch((error: unknown) => {
    log.warn({ err: error, path }, 'Deleted image row but could not remove its file');
  });

  return true;
}

/**
 * Fail analyses abandoned by a restart.
 *
 * Called on startup and periodically by the scheduler: a process killed mid-call
 * leaves `processing` rows that no worker will ever finish, and which the UI
 * renders as permanently in flight.
 */
export async function releaseStuck(olderThanMs = 5 * 60 * 1000): Promise<number> {
  const released = await repository.releaseStuck(olderThanMs);
  if (released > 0) {
    log.info({ released }, 'Released stuck image analyses');
  }
  return released;
}

/**
 * Delete uploads past the retention window, files included.
 *
 * Uploaded screenshots are the most sensitive data the platform stores — they can
 * show a real account's positions and size — so they are not kept indefinitely.
 * Files are unlinked first: an orphaned row would render as a broken image, while
 * an orphaned file is invisible and caught by the next sweep.
 */
export async function pruneOlderThan(days: number): Promise<number> {
  const expired = await repository.listExpired(days);
  if (expired.length === 0) return 0;

  await Promise.all(
    expired.map((item) =>
      unlink(item.path).catch(() => undefined),
    ),
  );

  const deleted = await repository.deleteByIds(expired.map((item) => item.id));
  log.info({ deleted, days }, 'Pruned expired image analyses');
  return deleted;
}
