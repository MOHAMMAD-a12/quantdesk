/**
 * AI provider layer.
 *
 * Import from here rather than reaching into individual adapters — the registry
 * is the only supported entry point, because it owns quota, fallback and usage
 * accounting.
 */

export { aiRegistry } from './registry.js';
export { extractJson } from './types.js';
export type {
  AiCompletionRequest,
  AiCompletionResult,
  AiImageInput,
  AiMessage,
  AiProvider,
  AiProviderCapabilities,
} from './types.js';

/**
 * Prompts are exported alongside the registry because the two are one contract:
 * a `*_JSON_SCHEMA` is what the provider is told to return, and the matching
 * `build*Prompt` is what fills it. Splitting the import across two paths invites
 * a caller to pair a prompt with the wrong schema.
 */
export {
  buildImagePrompt,
  buildNewsPrompt,
  buildSignalPrompt,
  IMAGE_JSON_SCHEMA,
  IMAGE_SYSTEM_PROMPT,
  NEWS_JSON_SCHEMA,
  NEWS_SYSTEM_PROMPT,
  PORTFOLIO_JSON_SCHEMA,
  PORTFOLIO_SYSTEM_PROMPT,
  SIGNAL_JSON_SCHEMA,
  SIGNAL_SYSTEM_PROMPT,
} from './prompts.js';
export type { ImagePromptInput, SignalPromptInput } from './prompts.js';
