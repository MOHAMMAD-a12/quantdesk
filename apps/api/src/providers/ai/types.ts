/**
 * The AI provider contract.
 *
 * Claude, OpenAI, Gemini and a local LLM are reduced to this interface so the
 * active provider can be switched from the admin panel at runtime, with no
 * redeploy and no code change.
 *
 * The critical design rule, and the reason this interface is so narrow:
 *
 *   **The model never computes anything.**
 *
 * Every number a signal contains — entry, stop, targets, RR, confidence
 * components, indicator values, structural levels — is produced by the
 * deterministic engine in `analysis/`. The model receives those numbers already
 * computed and is asked only to *synthesise*: explain the structure, weigh the
 * confluence, state a conviction. An LLM asked to calculate an ATR will produce
 * a plausible wrong number, and a stop loss derived from it would be wrong in a
 * way no test catches. So it is never asked.
 *
 * This also means the platform degrades cleanly: with no AI provider configured
 * the engine still emits complete signals, flagged `deterministicOnly: true`,
 * missing only the narrative.
 */

import type { AiProviderName } from '@quantdesk/shared';

/** A chat turn. The engine always sends a single user turn plus a system prompt. */
export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** An image for the chart-analysis path. */
export interface AiImageInput {
  /** Raw image bytes, base64-encoded without a data-URL prefix. */
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface AiCompletionRequest {
  system: string;
  messages: AiMessage[];
  /** Attached to the final user turn when the provider supports vision. */
  images?: AiImageInput[];
  maxTokens?: number;
  temperature?: number;
  /**
   * When set, the provider must return JSON matching this schema. Providers that
   * support structured output enforce it; others fall back to prompt
   * instruction plus parsing, so callers must still validate.
   */
  jsonSchema?: Record<string, unknown>;
  /** Labels the call in `ai_usage` for per-feature cost attribution. */
  purpose: string;
  /** Attributed for quota accounting. Null for system-initiated scans. */
  userId?: string | null;
}

export interface AiCompletionResult {
  text: string;
  provider: AiProviderName;
  model: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  /** True when the response was truncated by the token ceiling. */
  truncated: boolean;
}

export interface AiProviderCapabilities {
  /** Can read images — required for the chart-screenshot feature. */
  vision: boolean;
  /** Can guarantee schema-valid JSON rather than merely being asked for it. */
  structuredOutput: boolean;
  /** Extended reasoning, used for the harder multi-timeframe syntheses. */
  reasoning: boolean;
  maxContextTokens: number;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly capabilities: AiProviderCapabilities;

  /** Configured with a usable credential (or reachable, for a local model). */
  isConfigured(): boolean;

  /** The model id this provider will use, for display and usage records. */
  activeModel(): string;
  activeVisionModel(): string;

  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;

  healthCheck(): Promise<boolean>;
}

/**
 * Extract a JSON object from a model response.
 *
 * Models wrap JSON in prose or fenced code blocks even when told not to. Rather
 * than failing the whole analysis on a stray "Here is the JSON:", locate the
 * outermost object and parse that.
 *
 * @returns The parsed value, or null when nothing parseable is present.
 */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim();

  // Fast path: the whole response is JSON.
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through to extraction */
  }

  // Fenced block, with or without a language tag.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }

  // Outermost braces. Scanning for balance rather than regex-matching, because
  // nested objects defeat a non-greedy match and strings may contain braces.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}
