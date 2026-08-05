/**
 * Local LLM adapter.
 *
 * Targets any server exposing an OpenAI-compatible `/chat/completions` route —
 * Ollama, LM Studio, vLLM, llama.cpp, LocalAI. That compatibility is the whole
 * reason this adapter is thin: the wire format is the same one `openai.ts`
 * speaks, only the base URL and the key handling differ.
 *
 * It exists for two real cases: an operator who cannot send market positions to
 * a third party, and a developer who wants the narrative layer working offline.
 *
 * `isConfigured()` checks only that a base URL is set. Whether the model is
 * actually loaded is a `healthCheck()` question — a local server that is merely
 * down should not permanently deregister the provider, because it will come back.
 */

import { config } from '../../core/config.js';
import { ProviderError } from '../../core/errors.js';
import { moduleLogger } from '../../core/logger.js';
import { getJson, postJson } from '../http.js';
import type {
  AiCompletionRequest,
  AiCompletionResult,
  AiProvider,
  AiProviderCapabilities,
} from './types.js';

const log = moduleLogger('ai:local');

interface ChatResponse {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string } | string;
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export class LocalLlmProvider implements AiProvider {
  readonly name = 'local' as const;

  readonly capabilities: AiProviderCapabilities = {
    // Conservative defaults. Whether the *loaded* model can see images depends
    // on which model the operator pulled, and the platform cannot know that; the
    // registry therefore never routes chart images here unless it is the only
    // provider left.
    vision: false,
    structuredOutput: false,
    reasoning: false,
    maxContextTokens: 32_768,
  };

  isConfigured(): boolean {
    return Boolean(config.ai.local.baseUrl);
  }

  activeModel(): string {
    return config.ai.local.model;
  }

  activeVisionModel(): string {
    return config.ai.local.model;
  }

  private baseUrl(): string {
    const url = config.ai.local.baseUrl;
    if (!url) throw new ProviderError(this.name, 'LOCAL_LLM_BASE_URL is not configured');
    return url.replace(/\/+$/, '');
  }

  async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
    const started = Date.now();
    const model = this.activeModel();

    const messages: Array<{ role: string; content: string | ContentPart[] }> = [
      { role: 'system', content: req.system },
    ];

    req.messages.forEach((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (!isLastUser || !req.images?.length) {
        messages.push({ role: m.role, content: m.content });
        return;
      }
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
      stream: false,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    // Most compatible servers honour the simple json_object mode even when they
    // cannot enforce a full schema.
    if (req.jsonSchema) body.response_format = { type: 'json_object' };

    try {
      const res = await postJson<ChatResponse>({
        provider: this.name,
        url: `${this.baseUrl()}/chat/completions`,
        headers: { authorization: `Bearer ${config.ai.local.apiKey}` },
        body,
        // Local inference on CPU is slow; a 2-minute ceiling is not generous.
        timeoutMs: 300_000,
        attempts: 1,
      });

      if (res.error) {
        const message = typeof res.error === 'string' ? res.error : (res.error.message ?? 'error');
        throw new ProviderError(this.name, message);
      }

      const choice = res.choices?.[0];
      const text = (choice?.message?.content ?? '').trim();

      if (!text) throw new ProviderError(this.name, 'Local model returned an empty response');

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
      log.error({ err, model, purpose: req.purpose }, 'Local LLM completion failed');
      if (err instanceof ProviderError) throw err;
      throw new ProviderError(this.name, err instanceof Error ? err.message : 'request failed', err);
    }
  }

  /**
   * Listing models is enough: it proves the server is up and answering without
   * paying for an inference pass that may take a minute on CPU.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.isConfigured()) return false;
    try {
      await getJson<unknown>({
        provider: this.name,
        url: `${this.baseUrl()}/models`,
        headers: { authorization: `Bearer ${config.ai.local.apiKey}` },
        timeoutMs: 5_000,
        attempts: 1,
      });
      return true;
    } catch (err) {
      log.warn({ err }, 'Local LLM health check failed');
      return false;
    }
  }
}
