/**
 * OpenAI adapter.
 *
 * Uses the Chat Completions endpoint over raw HTTP rather than the OpenAI SDK:
 * this is a secondary provider, one endpoint is all the platform needs, and
 * adding a second large SDK to the image for that is not worth it.
 *
 * Unlike Claude, these models do accept `temperature` and can enforce a JSON
 * schema server-side via `response_format: { type: 'json_schema' }`, so
 * `structuredOutput` is true here.
 */

import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import { postJson } from '../http.js';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderCapabilities,
} from './types.js';

const log = moduleLogger('ai:openai');

const BASE_URL = 'https://api.openai.com/v1';

interface ChatResponse {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export class OpenAiProvider implements AiProvider {
  readonly name = 'openai' as const;

  readonly capabilities: AiProviderCapabilities = {
    vision: true,
    structuredOutput: true,
    reasoning: false,
    maxContextTokens: 128_000,
  };

  isConfigured(): boolean {
    return Boolean(config.ai.openai.apiKey);
  }

  activeModel(): string {
    return config.ai.openai.model;
  }

  activeVisionModel(): string {
    return config.ai.openai.visionModel;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const apiKey = config.ai.openai.apiKey;
    if (!apiKey) throw new ProviderError(this.name, 'OPENAI_API_KEY is not configured');

    const started = Date.now();
    const model = req.images?.length ? this.activeVisionModel() : this.activeModel();

    const messages: Array<{ role: string; content: string | ContentPart[] }> = [
      { role: 'system', content: req.system },
    ];

    req.messages.forEach((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (!isLastUser || !req.images?.length) {
        messages.push({ role: m.role, content: m.content });
        return;
      }
      // Images travel as data URLs on the final user turn.
      const parts: ContentPart[] = req.images.map((img) => ({
        type: 'image_url' as const,
        image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
      }));
      parts.push({ type: 'text', text: m.content });
      messages.push({ role: 'user', content: parts });
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxTokens ?? 4096,
    };

    if (req.temperature !== undefined) body.temperature = req.temperature;

    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'analysis', strict: true, schema: req.jsonSchema },
      };
    }

    try {
      const res = await postJson<ChatResponse>({
        provider: this.name,
        url: `${BASE_URL}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}` },
        body,
        timeoutMs: 120_000,
      });

      if (res.error?.message) throw new ProviderError(this.name, res.error.message);

      const choice = res.choices?.[0];
      const text = (choice?.message?.content ?? '').trim();

      return {
        text,
        provider: this.name,
        model,
        promptTokens: res.usage?.prompt_tokens ?? 0,
        completionTokens: res.usage?.completion_tokens ?? 0,
        latencyMs: Date.now() - started,
        truncated: choice?.finish_reason === 'length',
      };
    } catch (err) {
      log.error({ err, model, purpose: req.purpose }, 'OpenAI completion failed');
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, err instanceof Error ? err.message : 'request failed', err);
    }
  }

  async healthCheck(): Promise<boolean> {
    const apiKey = config.ai.openai.apiKey;
    if (!apiKey) return false;
    try {
      await postJson<ChatResponse>({
        provider: this.name,
        url: `${BASE_URL}/chat/completions`,
        headers: { authorization: `Bearer ${apiKey}` },
        body: { model: this.activeModel(), messages: [{ role: 'user', content: 'ok' }], max_tokens: 1 },
        timeoutMs: 15_000,
        attempts: 1,
      });
      return true;
    } catch (err) {
      log.warn({ err }, 'OpenAI health check failed');
      return false;
    }
  }
}
