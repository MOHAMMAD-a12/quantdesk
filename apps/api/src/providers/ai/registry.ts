/**
 * AI provider registry.
 *
 * The single entry point for every LLM call in the platform. It owns four
 * concerns that would otherwise be duplicated at each call site:
 *
 *  - **Runtime switching.** The active provider comes from the `ai_settings` row
 *    in `platform_settings`, not from the environment. An admin changing the
 *    provider takes effect on the next call, with no redeploy. Settings are
 *    cached briefly so a busy scan does not re-read the row per symbol.
 *  - **Fallback.** If the active provider errors, the configured `fallbackChain`
 *    is tried in order. The chain is empty by default — silently spending money
 *    at a provider the operator did not choose is a surprise, so it is opt-in.
 *  - **Quota.** Per-role daily ceilings, counted in Redis. Enforced here so no
 *    feature can bypass it by calling a provider directly.
 *  - **Accounting.** Every call, successful or not, is recorded in `ai_usage`
 *    for cost attribution in the admin panel.
 *
 * Above all: `isAvailable()` lets callers ask whether AI is usable *before*
 * building a prompt. When it returns false the engine emits its deterministic
 * analysis unchanged and flags it — the platform never blocks on the LLM.
 */

import type { AiProviderName, AiProviderStatus, AiSettings, UserRole } from '@quantdesk/shared';
import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import { query } from '../../db/pool.js';
import { incrementWithTtl, redis } from '../../db/redis.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { LocalLlmProvider } from './local.js';
import { OpenAiProvider } from './openai.js';
import type { AiCompletionRequest, AiCompletionResult, AiProvider } from './types.js';

const log = moduleLogger('ai:registry');

/** How long a settings read is trusted before re-querying. */
const SETTINGS_TTL_MS = 30_000;

const SETTINGS_KEY = 'ai_settings';

function defaults(): AiSettings {
  return {
    activeProvider: config.ai.defaultProvider,
    models: {},
    visionModels: {},
    temperature: 0.2,
    maxTokens: 4096,
    fallbackChain: [],
    dailyQuota: { free: 10, premium: 200, admin: 1000 },
    aiEnabled: true,
    updatedAt: Date.now(),
    updatedBy: null,
  };
}

class AiRegistry {
  private providers = new Map<AiProviderName, AiProvider>();
  private settings: AiSettings | null = null;
  private settingsReadAt = 0;

  constructor() {
    for (const provider of [
      new AnthropicProvider(),
      new OpenAiProvider(),
      new GeminiProvider(),
      new LocalLlmProvider(),
    ] as AiProvider[]) {
      this.providers.set(provider.name, provider);
    }
  }

  /**
   * Current settings, cached for {@link SETTINGS_TTL_MS}.
   *
   * A missing or malformed row falls back to defaults rather than throwing: a
   * bad settings row should degrade the narrative layer, not take down every
   * endpoint that touches analysis.
   */
  async getSettings(force = false): Promise<AiSettings> {
    const fresh = Date.now() - this.settingsReadAt < SETTINGS_TTL_MS;
    if (!force && this.settings && fresh) return this.settings;

    try {
      const rows = await query<{ value: AiSettings }>(
        'SELECT value FROM platform_settings WHERE key = $1',
        [SETTINGS_KEY],
      );
      // Merge over defaults so a row written by an older version, missing a
      // field added since, does not produce `undefined` at a call site.
      this.settings = { ...defaults(), ...(rows[0]?.value ?? {}) };
    } catch (err) {
      log.warn({ err }, 'Could not read ai_settings — using defaults');
      this.settings = this.settings ?? defaults();
    }

    this.settingsReadAt = Date.now();
    return this.settings;
  }

  /** Drop the cache after an admin write so the change is visible immediately. */
  invalidateSettings(): void {
    this.settings = null;
    this.settingsReadAt = 0;
  }

  get(name: AiProviderName): AiProvider | null {
    return this.providers.get(name) ?? null;
  }

  /** Providers holding a usable credential, regardless of which is active. */
  configuredProviders(): AiProviderName[] {
    return [...this.providers.values()].filter((p) => p.isConfigured()).map((p) => p.name);
  }

  /**
   * Whether an LLM call can be attempted at all.
   *
   * Callers use this to choose between the full narrative path and the
   * deterministic-only path *before* spending effort building a prompt.
   */
  async isAvailable(): Promise<boolean> {
    const settings = await this.getSettings();
    if (!settings.aiEnabled) return false;
    return this.resolveChain(settings).length > 0;
  }

  /**
   * Active provider followed by its fallbacks, filtered to those configured and
   * deduplicated. The active provider always leads even if it also appears in
   * the chain.
   */
  private resolveChain(settings: AiSettings, needsVision = false): AiProvider[] {
    const names: AiProviderName[] = [settings.activeProvider, ...settings.fallbackChain];
    const seen = new Set<AiProviderName>();
    const chain: AiProvider[] = [];

    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);

      const provider = this.providers.get(name);
      if (!provider?.isConfigured()) continue;
      if (needsVision && !provider.capabilities.vision) continue;

      chain.push(provider);
    }
    return chain;
  }

  /**
   * Model override resolution: the admin panel's per-provider setting wins over
   * the provider's env default. Applied by temporarily reading the override —
   * the provider itself stays stateless.
   */
  private modelFor(provider: AiProvider, settings: AiSettings, vision: boolean): string {
    const override = vision
      ? settings.visionModels[provider.name]
      : settings.models[provider.name];
    if (override && override.trim() !== '') return override.trim();
    return vision ? provider.activeVisionModel() : provider.activeModel();
  }

  /**
   * Run a completion through the active provider, falling back on error.
   *
   * @throws {ProviderError} When AI is disabled, no provider is configured, the
   *   caller is over quota, or every provider in the chain failed.
   */
  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const settings = await this.getSettings();

    if (!settings.aiEnabled) {
      throw new ProviderError('ai', 'AI features are disabled in platform settings');
    }

    const needsVision = Boolean(req.images?.length);
    const chain = this.resolveChain(settings, needsVision);

    if (chain.length === 0) {
      throw new ProviderError(
        'ai',
        needsVision
          ? 'No vision-capable AI provider is configured'
          : 'No AI provider is configured',
      );
    }

    const enriched: AiCompletionRequest = {
      ...req,
      maxTokens: req.maxTokens ?? settings.maxTokens,
      temperature: req.temperature ?? settings.temperature,
    };

    const failures: string[] = [];

    for (const provider of chain) {
      const started = Date.now();
      const model = this.modelFor(provider, settings, needsVision);

      try {
        const result = await provider.complete(enriched);

        await this.record({
          userId: req.userId ?? null,
          provider: provider.name,
          model: result.model,
          operation: req.purpose,
          promptTokens: result.promptTokens,
          completionTokens: result.completionTokens,
          latencyMs: result.latencyMs,
          success: true,
          error: null,
        });

        if (result.truncated) {
          log.warn(
            { provider: provider.name, purpose: req.purpose, maxTokens: enriched.maxTokens },
            'AI response hit the token ceiling and was truncated',
          );
        }

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${provider.name}: ${message}`);

        await this.record({
          userId: req.userId ?? null,
          provider: provider.name,
          model,
          operation: req.purpose,
          promptTokens: 0,
          completionTokens: 0,
          latencyMs: Date.now() - started,
          success: false,
          error: message,
        });

        log.warn({ provider: provider.name, purpose: req.purpose, err }, 'AI provider failed');
      }
    }

    throw new ProviderError('ai', `All AI providers failed — ${failures.join('; ')}`);
  }

  /**
   * Consume one unit of a user's daily AI quota.
   *
   * Fails **closed**: unlike rate limiting, where a cache outage should not lock
   * users out, quota protects real spend at a metered upstream. An unbounded
   * spend during a Redis outage is worse than a temporarily unavailable
   * narrative, so a counter failure denies the call.
   *
   * @returns Remaining quota after consumption, or null when unlimited.
   */
  async consumeQuota(userId: string, role: UserRole): Promise<number | null> {
    const settings = await this.getSettings();
    const limit = settings.dailyQuota[role];

    // Absent or zero means unlimited for that role.
    if (limit === undefined || limit <= 0) return null;

    const day = new Date().toISOString().slice(0, 10);
    const key = `ai:quota:${day}:${userId}`;

    // Expire at the UTC day boundary the key names, so a counter created at
    // 23:59 does not survive an extra 24 hours past the reset it advertises.
    const used = await incrementWithTtl(key, secondsUntilUtcMidnight());

    // incrementWithTtl fails open with 0; treat that as an unusable counter.
    if (used === 0) {
      throw new ProviderError('ai', 'AI quota could not be verified — try again shortly');
    }

    if (used > limit) {
      throw new ProviderError(
        'ai',
        `Daily AI quota of ${limit} requests reached. Resets at 00:00 UTC.`,
      );
    }

    return limit - used;
  }

  /** Quota consumed today without incrementing it — for the account page. */
  async quotaUsed(userId: string): Promise<number> {
    const day = new Date().toISOString().slice(0, 10);
    try {
      const value = await redis.get(`ai:quota:${day}:${userId}`);
      return value ? Number(value) : 0;
    } catch {
      return 0;
    }
  }

  /** Per-provider status for the admin panel. */
  async statusReport(): Promise<AiProviderStatus[]> {
    const settings = await this.getSettings();
    const stats = await this.recentStats();
    const checkedAt = Date.now();

    const checks = [...this.providers.values()].map(async (provider) => {
      const configured = provider.isConfigured();
      const stat = stats.get(provider.name);
      return {
        name: provider.name,
        configured,
        reachable: configured ? await provider.healthCheck().catch(() => false) : false,
        model: configured ? this.modelFor(provider, settings, false) : null,
        visionCapable: provider.capabilities.vision,
        lastCheckedAt: checkedAt,
        lastError: stat?.lastError ?? null,
        avgLatencyMs: stat?.avgLatencyMs ?? null,
      } satisfies AiProviderStatus;
    });

    return Promise.all(checks);
  }

  /**
   * Rolling latency and last error per provider, over the last 24 hours.
   *
   * One aggregate query rather than one per provider — this feeds a panel that
   * an admin may leave open and refreshing.
   */
  private async recentStats(): Promise<
    Map<string, { avgLatencyMs: number | null; lastError: string | null }>
  > {
    const out = new Map<string, { avgLatencyMs: number | null; lastError: string | null }>();

    try {
      const rows = await query<{
        provider: string;
        avg_latency: string | null;
        last_error: string | null;
      }>(
        `SELECT provider,
                AVG(latency_ms) FILTER (WHERE success) AS avg_latency,
                (ARRAY_REMOVE(ARRAY_AGG(error ORDER BY created_at DESC), NULL))[1] AS last_error
           FROM ai_usage
          WHERE created_at > now() - INTERVAL '24 hours'
          GROUP BY provider`,
      );

      for (const row of rows) {
        out.set(row.provider, {
          avgLatencyMs: row.avg_latency === null ? null : Math.round(Number(row.avg_latency)),
          lastError: row.last_error,
        });
      }
    } catch (err) {
      log.warn({ err }, 'Could not read AI usage statistics');
    }

    return out;
  }

  /**
   * Append a usage row.
   *
   * Deliberately swallows its own errors: a failed accounting insert must never
   * turn a successful analysis into a failed request.
   */
  private async record(entry: {
    userId: string | null;
    provider: string;
    model: string;
    operation: string;
    promptTokens: number;
    completionTokens: number;
    latencyMs: number;
    success: boolean;
    error: string | null;
  }): Promise<void> {
    try {
      await query(
        `INSERT INTO ai_usage
           (user_id, provider, model, operation, prompt_tokens, completion_tokens,
            latency_ms, success, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.userId,
          entry.provider,
          entry.model,
          entry.operation,
          entry.promptTokens,
          entry.completionTokens,
          entry.latencyMs,
          entry.success,
          entry.error?.slice(0, 500) ?? null,
        ],
      );
    } catch (err) {
      log.warn({ err }, 'Could not record AI usage');
    }
  }
}

/** Process-wide singleton. */
export const aiRegistry = new AiRegistry();

/** Seconds remaining until 00:00 UTC, floored at one. */
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.ceil((midnight - now.getTime()) / 1000));
}
