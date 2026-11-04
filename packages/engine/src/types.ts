/**
 * Core shared types of the Recursive AgentFold engine.
 */

export type Role = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: Role;
  content: string;
  /**
   * Hint for providers with explicit cache breakpoints (Anthropic-style
   * `cache_control`). Providers with automatic prefix caching ignore it.
   */
  cacheBreakpoint?: boolean;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider prefix cache. */
  cachedTokens: number;
  reasoningTokens?: number;
}

export interface LLMRequest {
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
  signal?: AbortSignal;
  /** Free-form tag used for tracing (e.g. "root", "llm_query"). */
  purpose?: string;
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
