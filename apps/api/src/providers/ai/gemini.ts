/**
 * Google Gemini adapter.
 *
 * The API shape differs from the other two in ways that matter:
 *  - the system prompt is a separate `systemInstruction`, not a message role;
 *  - the assistant role is called `model`, not `assistant`;
 *  - images are `inlineData` parts with a bare base64 string (no data-URL prefix);
 *  - the key goes in a query parameter, not a header.
 *
 * A response can also come back with *no* candidate at all when the safety
 * filter trips. That is a legitimate refusal, not a transport failure, so it is
 * surfaced as a ProviderError with the block reason rather than retried.
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

const log = moduleLogger('ai:gemini');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

type Part = { text: string } | { inlineData: { mimeType: string; data: string } };

interface GenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string };
}

export class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;

  readonly capabilities: AiProviderCapabilities = {
    vision: true,
    structuredOutput: true,
    reasoning: false,
    maxContextTokens: 1_000_000,
  };

  isConfigured(): boolean {
    return Boolean(config.ai.gemini.apiKey);
  }

  activeModel(): string {
    return config.ai.gemini.model;
  }

  activeVisionModel(): string {
    return config.ai.gemini.visionModel;
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const apiKey = config.ai.gemini.apiKey;
    if (!apiKey) throw new ProviderError(this.name, 'GEMINI_API_KEY is not configured');

    const started = Date.now();
    const model = req.images?.length ? this.activeVisionModel() : this.activeModel();

    const contents = req.messages.map((m, i) => {
      const parts: Part[] = [];
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';

      if (isLastUser) {
        for (const img of req.images ?? []) {
          parts.push({ inlineData: { mimeType: img.mediaType, data: img.base64 } });
        }
      }
      parts.push({ text: m.content });

      // Gemini names the assistant role 'model'.
      return { role: m.role === 'assistant' ? 'model' : 'user', parts };
    });

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: req.maxTokens ?? 4096,
    };
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (req.jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = req.jsonSchema;
    }

    try {
      const res = await postJson<GenerateResponse>({
        provider: this.name,
        // The key is a query parameter here, which is why the URL is built inline.
        url: `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
        body: {
          contents,
          systemInstruction: { parts: [{ text: req.system }] },
          generationConfig,
        },
        timeoutMs: 120_000,
      });

      if (res.error?.message) throw new ProviderError(this.name, res.error.message);

      const blocked = res.promptFeedback?.blockReason;
      if (blocked) {
        throw new ProviderError(this.name, `Request blocked by safety filter: ${blocked}`);
      }

      const candidate = res.candidates?.[0];
      const text = (candidate?.content?.parts ?? [])
        .map((p) => p.text ?? '')
        .join('')
        .trim();

      return {
        text,
        provider: this.name,
        model,
        promptTokens: res.usageMetadata?.promptTokenCount ?? 0,
        completionTokens: res.usageMetadata?.candidatesTokenCount ?? 0,
        latencyMs: Date.now() - started,
        truncated: candidate?.finishReason === 'MAX_TOKENS',
      };
    } catch (err) {
      log.error({ err, model, purpose: req.purpose }, 'Gemini completion failed');
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, err instanceof Error ? err.message : 'request failed', err);
    }
  }

  async healthCheck(): Promise<boolean> {
    const apiKey = config.ai.gemini.apiKey;
    if (!apiKey) return false;
    try {
      await postJson<GenerateResponse>({
        provider: this.name,
        url: `${BASE_URL}/models/${encodeURIComponent(this.activeModel())}:generateContent?key=${encodeURIComponent(apiKey)}`,
        body: {
          contents: [{ role: 'user', parts: [{ text: 'ok' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
        timeoutMs: 15_000,
        attempts: 1,
      });
      return true;
    } catch (err) {
      log.warn({ err }, 'Gemini health check failed');
      return false;
    }
  }
}
