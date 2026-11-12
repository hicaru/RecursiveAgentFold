/**
 * Core shared types of the Recursive AgentFold engine.
 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatContentSegment {
  readonly text: string;
  readonly cacheBreakpoint?: boolean;
}

export interface ChatMessage {
  readonly role: Role;
  readonly content: string;
  /**
   * Optional multi-segment content layout for providers that support block-level
   * cache breakpoints (Anthropic / Bedrock / OpenRouter Claude). `content`
   * always equals the concatenated segment text.
   */
  readonly segments?: readonly ChatContentSegment[];
  /**
   * Hint for providers with explicit cache breakpoints (Anthropic-style
   * `cache_control`). Providers with automatic prefix caching ignore it.
   */
  readonly cacheBreakpoint?: boolean;
}

export interface LLMUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Prompt tokens served from the provider prefix cache. */
  readonly cachedTokens: number;
  readonly reasoningTokens?: number;
}

export interface LLMRequest {
  readonly messages: ChatMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stop?: string[];
  readonly signal?: AbortSignal;
  /** Free-form tag used for tracing (e.g. "root", "llm_query"). */
  readonly purpose?: string;
  /** Stable cache routing key (`prompt_cache_key` / `sessionId`). */
  readonly cacheKey?: string;
  /** Scheduler priority lane: 0 = root (highest), 1 = branch, 2 = llm_query. */
  readonly priority?: number;
}

export interface LLMResponse {
  text: string;
  /** Provider-side reasoning (e.g. `reasoning_content`), if any. */
  reasoning?: string;
  usage: LLMUsage;
  model: string;
  latencyMs: number;
  finishReason?: string;
}

export interface ModelProfile {
  /** Provider model id. */
  name: string;
  /** Total context window in tokens. */
  contextWindow: number;
  /** Max output tokens requested per call. */
  maxOutputTokens: number;
}

export interface LLMClient {
  readonly profile: ModelProfile;
  complete(req: LLMRequest): Promise<LLMResponse>;
}

export type JSONSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JSONSchema>;
  items?: JSONSchema;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  [k: string]: unknown;
};
