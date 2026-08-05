/**
 * The preferences module — per-user risk limits, watchlist and alert routing.
 *
 * The repository is exported wholesale because the notification fan-out reads it
 * on every generated signal: `notifiableFor` is the query that decides who gets
 * told about what, and it belongs to this module rather than to notifications.
 */

export { preferencesRouter } from './routes.js';
export {
  defaultChannels,
  ensure,
  get,
  notifiableFor,
  update,
  watchersOf,
  type PreferencesPatch,
} from './repository.js';
