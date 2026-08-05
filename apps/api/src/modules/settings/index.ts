/**
 * Runtime platform settings.
 *
 * This module has no router of its own. Its HTTP surface is entirely admin-only
 * and lives in the admin module, next to the other operator controls — a
 * `/settings` route tree separate from `/admin` would be two doors to one room,
 * with two chances to get the authorisation wrong.
 *
 * Read through `getSignalEngineConfig` / `getAiSettings` rather than reading
 * `platform_settings` directly: those functions validate, cache, and fall back to
 * documented defaults, and a direct query gets none of that.
 */

export {
  SETTINGS_KEYS,
  defaultAiSettings,
  defaultSignalEngineConfig,
  getAiSettings,
  getSignalEngineConfig,
  invalidateSettingsCache,
  updateAiSettings,
  updateSignalEngineConfig,
} from './service.js';
