/**
 * Anthropic (Claude) adapter.
 *
 * The default provider, and the one used for chart-image analysis.
 *
 * Three API details are load-bearing and easy to get wrong, so they are
 * documented here rather than left implicit:
 *
 *  1. **Model ids carry no date suffix.** `claude-opus-5` is the complete
 *     identifier. Appending a date produces a 404 on a model that exists.
 *  2. **Extended thinking is `{ type: 'adaptive' }`.** The older
 *     `{ type: 'enabled', budget_tokens: N }` shape is *rejected with a 400* on
 *     Opus 5, so `budget_tokens` is never sent.
 *  3. **`temperature`, `top_p` and `top_k` are also rejected** on these models.
 *     `AiCompletionRequest.temperature` is therefore ignored here — deliberately,
 *     not accidentally. Determinism in this platform comes from the quant engine
 *     computing every number, not from a sampling parameter.
 *
 * Requests stream, because a full multi-timeframe synthesis can run long enough
 * to hit a non-streaming request timeout.
 */

import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderCapabilities,
} from './types.js';

const log = moduleLogger('ai:anthropic');

/**
 * Models that reject sampling parameters and `thinking.budget_tokens`.
 * Kept as a prefix list so a future point release inherits the behaviour.
 */
const NO_SAMPLING_PARAMS = ['claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-fable-5'];

function rejectsSamplingParams(model: string): boolean {
  return NO_SAMPLING_PARAMS.some((m) => model.startsWith(m));
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic' as const;

  readonly capabilities: AiProviderCapabilities = {
    vision: true,
    structuredOutput: false, // Enforced by prompt + validation, not by the API.
    reasoning: true,
    maxContextTokens: 1_000_000,
  };

  private client: Anthropic | null = null;

  isConfigured(): boolean {
    return Boolean(config.ai.anthropic.apiKey);
  }

  activeModel(): string {
    return config.ai.anthropic.model;
  }

  activeVisionModel(): string {
    return config.ai.anthropic.visionModel;
  }

  private sdk(): Anthropic {
    if (!this.client) {
      const apiKey = config.ai.anthropic.apiKey;
      if (!apiKey) throw new ProviderError(this.name, 'ANTHROPIC_API_KEY is not configured');
      this.client = new Anthropic({ apiKey, maxRetries: 2 });
    }
    return this.client;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const started = Date.now();
    const model = req.images?.length ? this.activeVisionModel() : this.activeModel();
    const maxTokens = req.maxTokens ?? 4096;

    // Images ride on the final user turn — that is where the model expects the
    // thing it is being asked about.
    const blocks: Anthropic.ContentBlockParam[] = [];
    for (const image of req.images ?? []) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
      });
    }

    const messages: Anthropic.MessageParam[] = req.messages.map((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (!isLastUser || blocks.length === 0) {
        return { role: m.role, content: m.content };
      }
      return { role: 'user', content: [...blocks, { type: 'text', text: m.content }] };
    });

    const params: Anthropic.MessageCreateParamsStreaming = {
      model,
      max_tokens: maxTokens,
      system: req.system,
      messages,
      // Adaptive thinking: the model decides how much reasoning the task needs.
      // No `budget_tokens` — it 400s on these models.
      thinking: { type: 'adaptive' },
      stream: true,
    };

    // Only legacy models accept a temperature. Newer ones reject it outright.
    if (req.temperature !== undefined && !rejectsSamplingParams(model)) {
      params.temperature = req.temperature;
    }

    try {
      const stream = this.sdk().messages.stream(params);
      const message = await stream.finalMessage();

      // Skip thinking blocks: the narrative the platform stores is the text.
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      return {
        text,
        provider: this.name,
        model,
        promptTokens: message.usage.input_tokens,
        completionTokens: message.usage.output_tokens,
        latencyMs: Date.now() - started,
        truncated: message.stop_reason === 'max_tokens',
      };
    } catch (err) {
      log.error({ err, model, purpose: req.purpose }, 'Anthropic completion failed');
      throw new ProviderError(
        this.name,
        err instanceof Error ? err.message : 'Anthropic request failed',
        err,
      );
    }
  }

  /**
   * Cheapest possible round trip that proves the credential works.
   * One token out is enough; this runs on the admin health panel.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      const res = await this.sdk().messages.create({
        model: this.activeModel(),
        max_tokens: 4,
        messages: [{ role: 'user', content: 'ok' }],
      });
      return res.content.length >= 0;
    } catch (err) {
      log.warn({ err }, 'Anthropic health check failed');
      return false;
    }
  }
}
