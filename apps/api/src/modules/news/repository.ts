/**
 * News, sentiment and the economic calendar — persistence.
 *
 * Articles are stored rather than proxied. Three reasons: the AI classification
 * costs a real API call and must not be repeated on every page load; the
 * confluence layer needs a *window* of sentiment, not the latest headline; and
 * upstream news APIs have the tightest rate limits of any provider here.
 *
 * `ON CONFLICT (provider, external_id) DO UPDATE` on ingest means re-fetching an
 * overlapping window is free — the same article arriving twice updates in place
 * instead of producing a duplicate the sentiment aggregate would double-count.
 */

import type {
  EconomicEvent,
  EconomicEventCategory,
  NewsAnalysis,
  NewsArticle,
  NewsArticleWithAnalysis,
  NewsImpact,
  NewsSentiment,
  SentimentSnapshot,
} from '@quantdesk/shared';
import { query, queryOne } from '../../db/pool.js';
import { toEpochRequired, toJsonObject, toNumRequired, toStrArray } from '../../db/rows.js';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

interface ArticleRow {
  id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  image_url: string | null;
  categories: string[] | null;
  symbols: string[] | null;
  sentiment: NewsSentiment | null;
  sentiment_score: string | null;
  impact: NewsImpact | null;
  analysis: unknown;
  published_at: Date;
}

interface EventRow {
  id: string;
  title: string;
  country: string;
  currency: string | null;
  category: string;
  impact: NewsImpact;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
  scheduled_at: Date;
}

const ARTICLE_COLUMNS = `
  id, title, summary, url, source, image_url, categories, symbols,
  sentiment, sentiment_score, impact, analysis, published_at
`;

const EVENT_COLUMNS = `
  id, title, country, currency, category, impact, actual, forecast, previous, scheduled_at
`;

function mapArticle(row: ArticleRow): NewsArticleWithAnalysis {
  const stored = toJsonObject(row.analysis);

  return {
    id: row.id,
    title: row.title,
    summary: row.summary,
    url: row.url,
    source: row.source,
    imageUrl: row.image_url,
    publishedAt: toEpochRequired(row.published_at),
    symbols: toStrArray(row.symbols),
    categories: toStrArray(row.categories),
    // The denormalised columns are authoritative for the sentiment fields — they
    // are what the aggregate query reads, so the object must agree with them.
    // The JSONB blob supplies only the narrative fields it alone carries.
    analysis: row.sentiment
      ? {
          articleId: row.id,
          sentiment: row.sentiment,
          sentimentScore: toNumRequired(row.sentiment_score, 0),
          impact: row.impact ?? 'low',
          confidence: numberFrom(stored['confidence'], 0),
          reasoning: stringFrom(stored['reasoning'], ''),
          affectedSymbols: stringArrayFrom(stored['affectedSymbols']),
          expectedDuration: durationFrom(stored['expectedDuration']),
          analysedAt: numberFrom(stored['analysedAt'], toEpochRequired(row.published_at)),
          aiProvider: stringFrom(stored['aiProvider'], 'unknown'),
        }
      : null,
  };
}

function mapEvent(row: EventRow): EconomicEvent {
  const actual = row.actual;
  const forecast = row.forecast;

  return {
    id: row.id,
    title: row.title,
    country: row.country,
    currency: row.currency ?? '',
    category: categoryFrom(row.category),
    impact: row.impact,
    scheduledAt: toEpochRequired(row.scheduled_at),
    actual,
    forecast,
    previous: row.previous,
    surprise: surpriseOf(actual, forecast),
    sentiment: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                          */
/* -------------------------------------------------------------------------- */

function numberFrom(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringFrom(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

const DURATIONS: ReadonlyArray<NewsAnalysis['expectedDuration']> = [
  'intraday',
  'days',
  'weeks',
  'structural',
];

function durationFrom(value: unknown): NewsAnalysis['expectedDuration'] {
  return DURATIONS.find((d) => d === value) ?? 'intraday';
}

const CATEGORIES: ReadonlyArray<EconomicEventCategory> = [
  'interest_rate',
  'cpi',
  'nfp',
  'fomc',
  'gdp',
  'pmi',
  'employment',
  'retail_sales',
  'crypto',
  'other',
];

function categoryFrom(value: string): EconomicEventCategory {
  return CATEGORIES.find((c) => c === value) ?? 'other';
}

/**
 * Beat / miss / inline.
 *
 * Numeric comparison after stripping the units economic feeds attach (`%`, `K`,
 * `M`, `B`, currency prefixes). When either side is non-numeric — "Hawkish",
 * "As expected" — the answer is null rather than a guess, because a wrong
 * surprise reading flips the directional interpretation of the release.
 */
function surpriseOf(actual: string | null, forecast: string | null): EconomicEvent['surprise'] {
  if (actual === null || forecast === null) return null;

  const a = parseNumeric(actual);
  const f = parseNumeric(forecast);
  if (a === null || f === null) return null;

  // Releases are reported to a fixed precision; an exact float comparison would
  // call 2.0999999 a miss against a 2.1 forecast.
  const epsilon = Math.max(Math.abs(f) * 1e-6, 1e-9);
  if (Math.abs(a - f) <= epsilon) return 'inline';
  return a > f ? 'beat' : 'miss';
}

function parseNumeric(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.+-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '+' || cleaned === '.') return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  const multiplier = /k$/i.test(raw.trim())
    ? 1e3
    : /m$/i.test(raw.trim())
      ? 1e6
      : /b$/i.test(raw.trim())
        ? 1e9
        : 1;

  return value * multiplier;
}

/* -------------------------------------------------------------------------- */
/* Ingest                                                                     */
/* -------------------------------------------------------------------------- */

export interface ArticleIngest extends Omit<NewsArticle, 'id'> {
  /** The upstream's own identifier — half of the dedupe key. */
  externalId: string;
  provider: string;
}

/**
 * Insert or refresh one article.
 *
 * @returns The stored id, and whether this insert created a new row. Callers use
 *   `inserted` to decide what needs AI classification — re-classifying an
 *   article seen an hour ago would spend a model call to reproduce a stored
 *   answer.
 */
export async function upsertArticle(
  article: ArticleIngest,
): Promise<{ id: string; inserted: boolean }> {
  const row = await queryOne<{ id: string; inserted: boolean }>(
    `INSERT INTO news_articles
       (external_id, provider, title, summary, url, source, image_url,
        categories, symbols, published_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))
     ON CONFLICT (provider, external_id) DO UPDATE SET
       title      = EXCLUDED.title,
       summary    = EXCLUDED.summary,
       image_url  = EXCLUDED.image_url,
       categories = EXCLUDED.categories,
       symbols    = EXCLUDED.symbols
     RETURNING id, (xmax = 0) AS inserted`,
    [
      article.externalId,
      article.provider,
      article.title,
      article.summary,
      article.url,
      article.source,
      article.imageUrl,
      article.categories,
      article.symbols,
      article.publishedAt,
    ],
  );

  // The RETURNING clause guarantees a row: this statement either inserts or
  // updates, and both paths return.
  return row ?? { id: '', inserted: false };
}

/** Attach an AI classification to a stored article. */
export async function saveAnalysis(articleId: string, analysis: NewsAnalysis): Promise<void> {
  await query(
    `UPDATE news_articles SET
       sentiment       = $2,
       sentiment_score = $3,
       impact          = $4,
       analysis        = $5::jsonb
     WHERE id = $1`,
    [
      articleId,
      analysis.sentiment,
      analysis.sentimentScore,
      analysis.impact,
      JSON.stringify(analysis),
    ],
  );
}

/** Articles stored but never classified, oldest first. Drives the AI backfill. */
export async function findUnanalysed(limit: number): Promise<NewsArticleWithAnalysis[]> {
  const rows = await query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM news_articles
     WHERE sentiment IS NULL
     ORDER BY published_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows.map(mapArticle);
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

export interface NewsFilter {
  symbol?: string | undefined;
  sentiment?: NewsSentiment | undefined;
  impact?: NewsImpact | undefined;
  /** Window in hours, counted back from now. */
  hours: number;
  page: number;
  pageSize: number;
}

/**
 * A filtered page of news, newest first.
 *
 * Symbol matching uses the GIN-indexed array containment operator rather than a
 * `LIKE` over a joined string, so "ETH" cannot match an article tagged only
 * "ETHW".
 */
export async function listNews(
  filter: NewsFilter,
): Promise<{ items: NewsArticleWithAnalysis[]; total: number }> {
  const conditions: string[] = ['published_at > now() - ($1 || \' hours\')::interval'];
  const params: unknown[] = [String(filter.hours)];

  if (filter.symbol) {
    params.push([filter.symbol.toUpperCase()]);
    conditions.push(`symbols && $${params.length}`);
  }
  if (filter.sentiment) {
    params.push(filter.sentiment);
    conditions.push(`sentiment = $${params.length}`);
  }
  if (filter.impact) {
    params.push(filter.impact);
    conditions.push(`impact = $${params.length}`);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM news_articles ${where}`,
    params,
  );

  const offset = (filter.page - 1) * filter.pageSize;
  const rows = await query<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM news_articles ${where}
     ORDER BY published_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, filter.pageSize, offset],
  );

  return { items: rows.map(mapArticle), total: Number(countRow?.count ?? 0) };
}

export async function findArticle(id: string): Promise<NewsArticleWithAnalysis | null> {
  const row = await queryOne<ArticleRow>(
    `SELECT ${ARTICLE_COLUMNS} FROM news_articles WHERE id = $1`,
    [id],
  );
  return row ? mapArticle(row) : null;
}

/**
 * Aggregate sentiment over a window.
 *
 * Weighted by impact, not a flat count: one critical FOMC story should not be
 * outvoted by five routine market-recap pieces. Unclassified articles are
 * excluded entirely — counting them as neutral would let an AI outage silently
 * drag every reading toward zero and look like genuine market indecision.
 *
 * Returns null when the window holds nothing classified, so callers can omit the
 * sentiment factor rather than feed the confluence layer a fabricated neutral.
 */
export async function sentimentSnapshot(
  scope: string,
  symbol: string | null,
  windowHours: number,
): Promise<SentimentSnapshot | null> {
  const params: unknown[] = [String(windowHours)];
  let symbolClause = '';

  if (symbol) {
    params.push([symbol.toUpperCase()]);
    symbolClause = ` AND symbols && $${params.length}`;
  }

  const row = await queryOne<{
    weighted: string | null;
    total: string;
    bullish: string;
    bearish: string;
    neutral: string;
  }>(
    `SELECT
       SUM(sentiment_score * ${IMPACT_WEIGHT_SQL}) / NULLIF(SUM(${IMPACT_WEIGHT_SQL}), 0) AS weighted,
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE sentiment = 'bullish')::text AS bullish,
       COUNT(*) FILTER (WHERE sentiment = 'bearish')::text AS bearish,
       COUNT(*) FILTER (WHERE sentiment = 'neutral')::text AS neutral
     FROM news_articles
     WHERE sentiment IS NOT NULL
       AND published_at > now() - ($1 || ' hours')::interval
       ${symbolClause}`,
    params,
  );

  const articleCount = Number(row?.total ?? 0);
  if (!row || articleCount === 0) return null;

  const score = clampScore(toNumRequired(row.weighted, 0));

  // Momentum: this window against the one before it. A market that was
  // strongly bearish and is now mildly bearish is improving, and a static score
  // cannot express that.
  const previous = await previousWindowScore(symbol, windowHours);

  return {
    scope,
    score,
    sentiment: score > 15 ? 'bullish' : score < -15 ? 'bearish' : 'neutral',
    articleCount,
    bullishCount: Number(row.bullish),
    bearishCount: Number(row.bearish),
    neutralCount: Number(row.neutral),
    momentum: previous === null ? 0 : Math.round((score - previous) * 100) / 100,
    windowHours,
    computedAt: Date.now(),
  };
}

/** Impact → weight, inline so the aggregate stays a single round trip. */
const IMPACT_WEIGHT_SQL = `CASE impact
  WHEN 'critical' THEN 3.0
  WHEN 'high'     THEN 2.0
  WHEN 'medium'   THEN 1.0
  ELSE 0.5
END`;

async function previousWindowScore(symbol: string | null, windowHours: number): Promise<number | null> {
  const params: unknown[] = [String(windowHours), String(windowHours * 2)];
  let symbolClause = '';

  if (symbol) {
    params.push([symbol.toUpperCase()]);
    symbolClause = ` AND symbols && $${params.length}`;
  }

  const row = await queryOne<{ weighted: string | null; total: string }>(
    `SELECT
       SUM(sentiment_score * ${IMPACT_WEIGHT_SQL}) / NULLIF(SUM(${IMPACT_WEIGHT_SQL}), 0) AS weighted,
       COUNT(*)::text AS total
     FROM news_articles
     WHERE sentiment IS NOT NULL
       AND published_at <= now() - ($1 || ' hours')::interval
       AND published_at >  now() - ($2 || ' hours')::interval
       ${symbolClause}`,
    params,
  );

  if (!row || Number(row.total) === 0) return null;
  return clampScore(toNumRequired(row.weighted, 0));
}

function clampScore(value: number): number {
  return Math.round(Math.max(-100, Math.min(100, value)) * 100) / 100;
}

/* -------------------------------------------------------------------------- */
/* Economic calendar                                                          */
/* -------------------------------------------------------------------------- */

export interface CalendarFilter {
  from: number;
  to: number;
  impact?: NewsImpact | undefined;
  currency?: string | undefined;
}

export async function listEvents(filter: CalendarFilter): Promise<EconomicEvent[]> {
  const params: unknown[] = [filter.from, filter.to];
  const conditions = ['scheduled_at >= to_timestamp($1 / 1000.0)', 'scheduled_at <= to_timestamp($2 / 1000.0)'];

  if (filter.impact) {
    params.push(filter.impact);
    conditions.push(`impact = $${params.length}`);
  }
  if (filter.currency) {
    params.push(filter.currency.toUpperCase());
    conditions.push(`currency = $${params.length}`);
  }

  const rows = await query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM economic_events
     WHERE ${conditions.join(' AND ')}
     ORDER BY scheduled_at ASC`,
    params,
  );
  return rows.map(mapEvent);
}

/**
 * High-impact events inside a forward window.
 *
 * Consumed by the signal engine: an entry taken twenty minutes before CPI is a
 * different proposition from the same entry on a quiet Tuesday, and the risk
 * layer needs to say so.
 */
export async function upcomingHighImpact(withinMs: number): Promise<EconomicEvent[]> {
  const rows = await query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM economic_events
     WHERE scheduled_at BETWEEN now() AND now() + ($1 || ' milliseconds')::interval
       AND impact IN ('high', 'critical')
     ORDER BY scheduled_at ASC
     LIMIT 20`,
    [String(Math.round(withinMs))],
  );
  return rows.map(mapEvent);
}

export interface EventIngest {
  externalId: string | null;
  title: string;
  country: string;
  currency: string | null;
  category: EconomicEventCategory;
  impact: NewsImpact;
  scheduledAt: number;
  actual: string | null;
  forecast: string | null;
  previous: string | null;
}

/**
 * Insert or refresh a calendar entry.
 *
 * Deduped on `(title, scheduled_at, country)` rather than `external_id`, because
 * calendar providers reissue ids between revisions of the same release — and the
 * point of re-fetching is precisely to pick up the `actual` once it prints.
 */
export async function upsertEvent(event: EventIngest): Promise<void> {
  await query(
    `INSERT INTO economic_events
       (external_id, title, country, currency, category, impact,
        actual, forecast, previous, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10 / 1000.0))
     ON CONFLICT (title, scheduled_at, country) DO UPDATE SET
       actual     = EXCLUDED.actual,
       forecast   = EXCLUDED.forecast,
       previous   = EXCLUDED.previous,
       impact     = EXCLUDED.impact,
       updated_at = now()`,
    [
      event.externalId,
      event.title,
      event.country,
      event.currency,
      event.category,
      event.impact,
      event.actual,
      event.forecast,
      event.previous,
      event.scheduledAt,
    ],
  );
}

/** Drop articles past the retention horizon. Called by the maintenance job. */
export async function pruneArticles(olderThanDays: number): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM news_articles
     WHERE published_at < now() - ($1 || ' days')::interval
     RETURNING id`,
    [String(olderThanDays)],
  );
  return rows.length;
}
