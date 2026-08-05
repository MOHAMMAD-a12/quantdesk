/**
 * News ingestion and classification.
 *
 * Two upstreams, both optional: CryptoPanic (crypto headlines, token-gated) and
 * Finnhub (general market news, reuses the market-data key). With neither
 * configured this module returns empty results and says so — it never
 * manufactures headlines, which would be the news equivalent of a synthetic
 * price.
 *
 * Classification is a separate step from ingestion, and deliberately so:
 * fetching is cheap and frequent, classification costs a model call. Articles
 * land unclassified and a backfill pass scores them in batches, so a news feed
 * outage degrades to "no sentiment" rather than "no news".
 */

import type {
  FearGreedIndex,
  NewsAnalysis,
  NewsArticle,
  NewsArticleWithAnalysis,
  NewsImpact,
  NewsSentiment,
  SentimentSnapshot,
} from '@quantdesk/shared';
import { z } from 'zod';
import { config } from '../../core/config.js';
import { moduleLogger } from '../../core/logger.js';
import { CacheKeys, CacheTtl, cacheWrap } from '../../db/redis.js';
import { getJson } from '../../providers/http.js';
import { aiRegistry } from '../../providers/ai/registry.js';
import { extractJson } from '../../providers/ai/types.js';
import { NEWS_JSON_SCHEMA, NEWS_SYSTEM_PROMPT, buildNewsPrompt } from '../../providers/ai/prompts.js';
import { listSymbols } from '../markets/repository.js';
import * as repo from './repository.js';

const log = moduleLogger('news');

/** How many articles go into one classification call. */
const CLASSIFY_BATCH = 10;

/** Sentiment aggregation window. Long enough to be stable, short enough to move. */
const SENTIMENT_WINDOW_HOURS = 24;

/* -------------------------------------------------------------------------- */
/* Provider availability                                                      */
/* -------------------------------------------------------------------------- */

export interface NewsSourceStatus {
  cryptoPanic: boolean;
  finnhub: boolean;
  fearGreed: boolean;
  /** False when no upstream is configured — the UI shows an honest empty state. */
  anyConfigured: boolean;
}

export function sourceStatus(): NewsSourceStatus {
  const cryptoPanic = Boolean(config.news.cryptoPanicToken);
  const finnhub = config.news.finnhubEnabled && Boolean(config.market.finnhub.apiKey);

  return {
    cryptoPanic,
    finnhub,
    fearGreed: config.news.fearGreedEnabled,
    anyConfigured: cryptoPanic || finnhub,
  };
}

/* -------------------------------------------------------------------------- */
/* Upstream shapes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Upstream payloads are validated, not trusted.
 *
 * A news API changing a field from string to object should produce a logged
 * skip, not a `TypeError` thrown from inside a scheduled job at 3am. `passthrough`
 * keeps unknown fields from failing the parse — the shape only needs to cover
 * what is read.
 */
const cryptoPanicSchema = z.object({
  results: z
    .array(
      z
        .object({
          id: z.union([z.number(), z.string()]),
          title: z.string(),
          url: z.string().url().optional(),
          published_at: z.string(),
          source: z.object({ title: z.string().optional(), domain: z.string().optional() }).optional(),
          currencies: z.array(z.object({ code: z.string() })).optional(),
          kind: z.string().optional(),
        })
        .passthrough(),
    )
    .default([]),
});

const finnhubSchema = z.array(
  z
    .object({
      id: z.union([z.number(), z.string()]),
      headline: z.string(),
      summary: z.string().optional(),
      url: z.string().optional(),
      source: z.string().optional(),
      image: z.string().optional(),
      datetime: z.number(),
      category: z.string().optional(),
      related: z.string().optional(),
    })
    .passthrough(),
);

const fearGreedSchema = z.object({
  data: z
    .array(
      z.object({
        value: z.string(),
        value_classification: z.string(),
        timestamp: z.string(),
      }),
    )
    .min(1),
});

/* -------------------------------------------------------------------------- */
/* Ingestion                                                                  */
/* -------------------------------------------------------------------------- */

export interface IngestResult {
  fetched: number;
  inserted: number;
  sources: string[];
  /** Set when nothing could be fetched and why. */
  note: string | null;
}

/**
 * Pull the latest headlines from every configured source.
 *
 * Sources are fetched concurrently and failures are isolated: one dead upstream
 * must not cost the articles the other one returned. Called by the scheduler and
 * exposed to admins for a manual refresh.
 */
export async function ingestLatest(): Promise<IngestResult> {
  const status = sourceStatus();

  if (!status.anyConfigured) {
    return {
      fetched: 0,
      inserted: 0,
      sources: [],
      note: 'No news provider configured. Set NEWS_CRYPTOPANIC_TOKEN or enable Finnhub news.',
    };
  }

  const tasks: Array<Promise<{ source: string; articles: repo.ArticleIngest[] }>> = [];
  if (status.cryptoPanic) tasks.push(fetchCryptoPanic());
  if (status.finnhub) tasks.push(fetchFinnhub());

  const settled = await Promise.allSettled(tasks);

  const collected: repo.ArticleIngest[] = [];
  const sources: string[] = [];

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      collected.push(...result.value.articles);
      sources.push(result.value.source);
    } else {
      log.warn({ err: result.reason }, 'News source failed');
    }
  }

  let inserted = 0;
  for (const article of collected) {
    try {
      const { inserted: isNew } = await repo.upsertArticle(article);
      if (isNew) inserted += 1;
    } catch (err) {
      // One malformed article must not abort the batch — the rest are still
      // worth storing, and the dedupe key makes a retry harmless.
      log.warn({ err, url: article.url }, 'Could not store article');
    }
  }

  log.info({ fetched: collected.length, inserted, sources }, 'News ingest complete');

  return {
    fetched: collected.length,
    inserted,
    sources,
    note: sources.length === 0 ? 'Every configured news source failed this cycle.' : null,
  };
}

async function fetchCryptoPanic(): Promise<{ source: string; articles: repo.ArticleIngest[] }> {
  const payload = await getJson<unknown>({
    provider: 'cryptopanic',
    url: 'https://cryptopanic.com/api/v1/posts/',
    query: {
      auth_token: config.news.cryptoPanicToken ?? '',
      public: 'true',
      kind: 'news',
    },
  });

  const parsed = cryptoPanicSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.length }, 'CryptoPanic response shape changed — skipping');
    return { source: 'cryptopanic', articles: [] };
  }

  const articles = parsed.data.results.flatMap((item): repo.ArticleIngest[] => {
    const publishedAt = Date.parse(item.published_at);
    if (Number.isNaN(publishedAt) || !item.url) return [];

    return [
      {
        externalId: String(item.id),
        provider: 'cryptopanic',
        title: item.title,
        summary: null,
        url: item.url,
        source: item.source?.title ?? item.source?.domain ?? 'CryptoPanic',
        imageUrl: null,
        publishedAt,
        symbols: (item.currencies ?? []).map((c) => c.code.toUpperCase()),
        categories: ['crypto', ...(item.kind ? [item.kind] : [])],
      },
    ];
  });

  return { source: 'cryptopanic', articles };
}

async function fetchFinnhub(): Promise<{ source: string; articles: repo.ArticleIngest[] }> {
  const payload = await getJson<unknown>({
    provider: 'finnhub-news',
    url: 'https://finnhub.io/api/v1/news',
    query: { category: 'general', token: config.market.finnhub.apiKey ?? '' },
  });

  const parsed = finnhubSchema.safeParse(payload);
  if (!parsed.success) {
    log.warn({ issues: parsed.error.issues.length }, 'Finnhub news response shape changed — skipping');
    return { source: 'finnhub', articles: [] };
  }

  const articles = parsed.data.flatMap((item): repo.ArticleIngest[] => {
    if (!item.url) return [];

    return [
      {
        externalId: String(item.id),
        provider: 'finnhub',
        title: item.headline,
        summary: item.summary ?? null,
        url: item.url,
        source: item.source ?? 'Finnhub',
        imageUrl: item.image && item.image !== '' ? item.image : null,
        // Finnhub reports seconds; storing it as milliseconds would date every
        // article to 1970 and silently empty every time-windowed query.
        publishedAt: item.datetime * 1000,
        symbols: (item.related ?? '')
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter((s) => s !== ''),
        categories: item.category ? [item.category] : ['general'],
      },
    ];
  });

  return { source: 'finnhub', articles };
}

/* -------------------------------------------------------------------------- */
/* AI classification                                                          */
/* -------------------------------------------------------------------------- */

const classificationSchema = z.object({
  index: z.number().int().nonnegative(),
  sentiment: z.enum(['bullish', 'bearish', 'neutral']),
  sentimentScore: z.number().min(-100).max(100),
  impact: z.enum(['low', 'medium', 'high', 'critical']),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().max(600),
  affectedSymbols: z.array(z.string()).max(8).default([]),
  expectedDuration: z.enum(['intraday', 'days', 'weeks', 'structural']),
});

const classificationBatchSchema = z.object({
  results: z.array(classificationSchema).default([]),
});

/**
 * Classify stored-but-unscored articles.
 *
 * @param limit Maximum articles to process this pass. Bounded because this is
 *   called from a scheduler and an unbounded backlog after an AI outage would
 *   otherwise spend the day's entire quota in one cycle.
 * @returns How many were classified. Zero is a normal outcome, not an error —
 *   it means either nothing new or no AI provider.
 */
export async function classifyPending(limit = CLASSIFY_BATCH * 3): Promise<number> {
  if (!(await aiRegistry.isAvailable())) {
    log.debug('No AI provider available — skipping news classification');
    return 0;
  }

  const pending = await repo.findUnanalysed(limit);
  if (pending.length === 0) return 0;

  const universe = (await listSymbols()).map((s) => s.symbol);
  let classified = 0;

  for (let i = 0; i < pending.length; i += CLASSIFY_BATCH) {
    const batch = pending.slice(i, i + CLASSIFY_BATCH);
    try {
      classified += await classifyBatch(batch, universe);
    } catch (err) {
      // A failed batch leaves its articles unclassified, which is exactly the
      // state that makes the next pass retry them. Nothing to repair.
      log.warn({ err, size: batch.length }, 'News classification batch failed');
    }
  }

  if (classified > 0) log.info({ classified }, 'News classified');
  return classified;
}

async function classifyBatch(batch: NewsArticleWithAnalysis[], universe: string[]): Promise<number> {
  const result = await aiRegistry.complete({
    system: NEWS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildNewsPrompt(batch as NewsArticle[], universe) }],
    jsonSchema: {
      type: 'object',
      required: ['results'],
      properties: {
        results: {
          type: 'array',
          items: {
            type: 'object',
            required: ['index', ...(NEWS_JSON_SCHEMA['required'] as string[])],
            properties: {
              index: { type: 'integer', minimum: 0 },
              ...(NEWS_JSON_SCHEMA['properties'] as Record<string, unknown>),
            },
          },
        },
      },
    },
    purpose: 'news.classify',
    userId: null,
  });

  const extracted = extractJson<unknown>(result.text);
  const parsed = classificationBatchSchema.safeParse(extracted);

  if (!parsed.success) {
    log.warn({ provider: result.provider }, 'Unparseable news classification response');
    return 0;
  }

  const universeSet = new Set(universe);
  let saved = 0;

  for (const entry of parsed.data.results) {
    const article = batch[entry.index];
    // A model that returns an index outside the batch has lost track of the
    // input; attaching that classification to whatever article happens to sit at
    // a clamped index would be worse than dropping it.
    if (!article) continue;

    const analysis: NewsAnalysis = {
      articleId: article.id,
      sentiment: entry.sentiment,
      // Sign and label must agree. A "bullish" verdict carrying -40 is a model
      // slip, and the aggregate reads the score, so the label loses.
      sentimentScore: reconcileScore(entry.sentiment, entry.sentimentScore),
      impact: entry.impact,
      confidence: Math.round(entry.confidence),
      reasoning: entry.reasoning,
      // Tickers outside the tradable universe are dropped: an article tagged
      // with a symbol we do not price cannot inform any signal, and storing it
      // would let a hallucinated ticker into the symbol filter.
      affectedSymbols: entry.affectedSymbols
        .map((s) => s.toUpperCase())
        .filter((s) => universeSet.has(s)),
      expectedDuration: entry.expectedDuration,
      analysedAt: Date.now(),
      aiProvider: result.provider,
    };

    await repo.saveAnalysis(article.id, analysis);
    saved += 1;
  }

  return saved;
}

function reconcileScore(sentiment: NewsSentiment, score: number): number {
  const rounded = Math.round(score);
  if (sentiment === 'neutral') return Math.abs(rounded) <= 20 ? rounded : 0;
  if (sentiment === 'bullish') return rounded > 0 ? rounded : Math.abs(rounded);
  return rounded < 0 ? rounded : -Math.abs(rounded);
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function list(filter: repo.NewsFilter) {
  return repo.listNews(filter);
}

export async function findArticle(id: string) {
  return repo.findArticle(id);
}

export async function calendar(filter: repo.CalendarFilter) {
  return repo.listEvents(filter);
}

export async function upcomingHighImpact(withinMs: number) {
  return repo.upcomingHighImpact(withinMs);
}

/**
 * Sentiment for one symbol, or market-wide when `symbol` is null.
 *
 * Returns null when nothing in the window is classified. Callers must treat that
 * as "no reading" rather than substituting neutral — the confluence layer omits
 * the sentiment factor entirely instead of scoring it at zero, so an unavailable
 * news feed cannot masquerade as genuine market indecision.
 */
export async function sentiment(symbol: string | null): Promise<SentimentSnapshot | null> {
  return repo.sentimentSnapshot(symbol ?? 'market', symbol, SENTIMENT_WINDOW_HOURS);
}

/* -------------------------------------------------------------------------- */
/* Fear & Greed                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The alternative.me Fear & Greed index.
 *
 * Public, unauthenticated, and cached for 15 minutes — it updates once a day, so
 * anything shorter spends requests to re-read the same number. Returns null when
 * disabled or unreachable; the confluence layer treats absence as "no factor".
 *
 * Two readings are requested so the previous value is available: the delta is
 * what makes the index actionable, since 25 after 60 means something different
 * from 25 after 20.
 */
export async function fearGreed(): Promise<FearGreedIndex | null> {
  if (!config.news.fearGreedEnabled) return null;

  try {
    return await cacheWrap(CacheKeys.fearGreed(), CacheTtl.fearGreed, async () => {
      const payload = await getJson<unknown>({
        provider: 'alternative.me',
        url: 'https://api.alternative.me/fng/',
        query: { limit: 2 },
        attempts: 2,
      });

      const parsed = fearGreedSchema.safeParse(payload);
      if (!parsed.success) throw new Error('Unexpected Fear & Greed response shape');

      const [current, previous] = parsed.data.data;
      if (!current) throw new Error('Empty Fear & Greed response');

      const value = Number(current.value);
      if (!Number.isFinite(value)) throw new Error('Non-numeric Fear & Greed value');

      const previousValue = previous ? Number(previous.value) : Number.NaN;

      return {
        value,
        classification: current.value_classification,
        timestamp: Number(current.timestamp) * 1000,
        ...(Number.isFinite(previousValue) ? { previousValue } : {}),
      } satisfies FearGreedIndex;
    });
  } catch (err) {
    log.warn({ err }, 'Fear & Greed unavailable');
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                */
/* -------------------------------------------------------------------------- */

/** Retention. Articles older than this inform nothing and cost index space. */
const RETENTION_DAYS = 60;

export async function prune(): Promise<number> {
  const removed = await repo.pruneArticles(RETENTION_DAYS);
  if (removed > 0) log.info({ removed }, 'Pruned old news articles');
  return removed;
}

/** Re-exported so routes need only one import. */
export type { NewsArticleWithAnalysis, NewsImpact, NewsSentiment };
