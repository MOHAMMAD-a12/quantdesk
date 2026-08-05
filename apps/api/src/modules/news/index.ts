/**
 * News, sentiment and the economic calendar.
 *
 * The public surface is deliberately small. Other modules — chiefly analysis and
 * signals — need exactly three things from here: a sentiment snapshot for a
 * symbol, the Fear & Greed reading, and the list of high-impact releases about to
 * print. Everything else (ingest, classification, persistence) is internal
 * machinery that no other module should reach into.
 *
 * All three read paths can return null or an empty array, and callers must treat
 * that as absence rather than substituting a neutral value. That is the whole
 * contract: an unavailable news feed must never be indistinguishable from a
 * genuinely undecided market.
 */

export { newsRouter } from './routes.js';

export {
  calendar,
  classifyPending,
  fearGreed,
  findArticle,
  ingestLatest,
  list,
  prune,
  sentiment,
  sourceStatus,
  upcomingHighImpact,
} from './service.js';

export type { IngestResult, NewsSourceStatus } from './service.js';

export { upsertEvent } from './repository.js';
export type { CalendarFilter, EventIngest, NewsFilter } from './repository.js';
