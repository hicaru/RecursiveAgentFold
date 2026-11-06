import type { ChatMessage, LLMClient, LLMRequest, LLMResponse, ModelProfile } from '../types.js';
import { defaultEstimator, type TokenEstimator } from '../tokens.js';

/**
 * Simulates provider-side automatic prefix caching: the cached portion of a
 * prompt is the longest common prefix with any previously seen prompt
 * (rounded down to `blockTokens`, like real KV-cache pages).
 * Lets us measure the cache-friendliness of prompt layouts offline.
 */
export class PrefixCacheSimulator {
  private readonly seen: string[] = [];
  constructor(
    private readonly estimator: TokenEstimator = defaultEstimator,
    private readonly blockTokens = 64,
    private readonly capacity = 512,
  ) {}

  static serialize(messages: ChatMessage[]): string {
    return messages.map((m) => `<|${m.role}|>${m.content}`).join('');
  }

  /** Returns cached tokens for this prompt and records it. */
  observe(prompt: string): number {
    let best = 0;
    for (const s of this.seen) {
      const n = Math.min(s.length, prompt.length);
      let i = 0;
      // fast path: compare in strides
      while (i < n && s.charCodeAt(i) === prompt.charCodeAt(i)) i++;
      if (i > best) best = i;
      if (best === prompt.length) break;
    }
    this.seen.push(prompt);
    if (this.seen.length > this.capacity) this.seen.shift();
    const tokens = this.estimator.count(prompt.slice(0, best));
    return Math.floor(tokens / this.blockTokens) * this.blockTokens;
  }
}

export type ScriptOut = string | (Partial<LLMResponse> & { readonly text: string });
export type ScriptFn = (req: LLMRequest, callIndex: number) => ScriptOut | Promise<ScriptOut>;

/**
 * Deterministic LLM for tests and offline dry-runs. The script receives the
 * request and returns the raw completion text.
 */
export class ScriptedLLM implements LLMClient {
  readonly profile: ModelProfile;
  readonly calls: LLMRequest[] = [];
  private readonly cache: PrefixCacheSimulator;

  constructor(
    private readonly script: ScriptFn,
    profile: Partial<ModelProfile> = {},
    private readonly estimator: TokenEstimator = defaultEstimator,
  ) {
    this.profile = {
      name: profile.name ?? 'scripted',
      contextWindow: profile.contextWindow ?? 128_000,
      maxOutputTokens: profile.maxOutputTokens ?? 2048,
    };
    this.cache = new PrefixCacheSimulator(estimator);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const idx = this.calls.length;
    this.calls.push(req);
    const prompt = PrefixCacheSimulator.serialize(req.messages);
    const promptTokens = this.estimator.count(prompt);
    if (promptTokens > this.profile.contextWindow) {
      throw new Error(`ScriptedLLM: prompt (${promptTokens}) exceeds context window (${this.profile.contextWindow})`);
    }
    const cachedTokens = Math.min(this.cache.observe(prompt), promptTokens);
    const raw = await this.script(req, idx);
    const obj = typeof raw === 'string' ? { text: raw } : raw;
    return {
      text: obj.text,
      ...(obj.reasoning !== undefined ? { reasoning: obj.reasoning } : {}),
      ...(obj.finishReason !== undefined ? { finishReason: obj.finishReason } : {}),
      model: obj.model ?? this.profile.name,
      latencyMs: obj.latencyMs ?? 0,
      usage: obj.usage ?? { promptTokens, completionTokens: this.estimator.count(obj.text), cachedTokens },
    };
  }
}
