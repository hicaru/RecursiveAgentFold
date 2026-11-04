import type { LLMUsage } from '../types.js';

export interface UsageBucket {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  latencyMs: number;
  errors: number;
}

const empty = (): UsageBucket => ({
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  latencyMs: 0,
  errors: 0,
});

/**
 * Aggregates token usage per role ("root", "branch", "llm_query", ...).
 * The cache hit rate (cachedTokens / promptTokens) is the key metric for the
 * "do not lose the cache" requirement.
 */
export class UsageTracker {
  private readonly buckets = new Map<string, UsageBucket>();

  record(role: string, usage: LLMUsage, latencyMs: number): void {
    const b = this.buckets.get(role) ?? empty();
    b.calls++;
    b.promptTokens += usage.promptTokens;
    b.completionTokens += usage.completionTokens;
    b.cachedTokens += usage.cachedTokens;
    b.reasoningTokens += usage.reasoningTokens ?? 0;
    b.latencyMs += latencyMs;
    this.buckets.set(role, b);
  }

  recordError(role: string): void {
    const b = this.buckets.get(role) ?? empty();
    b.errors++;
    this.buckets.set(role, b);
  }

  byRole(): Record<string, UsageBucket & { cacheHitRate: number }> {
    const out: Record<string, UsageBucket & { cacheHitRate: number }> = {};
    for (const [k, v] of this.buckets) {
      out[k] = { ...v, cacheHitRate: v.promptTokens ? v.cachedTokens / v.promptTokens : 0 };
    }
    return out;
  }

  total(): UsageBucket & { cacheHitRate: number } {
    const t = empty();
    for (const v of this.buckets.values()) {
      t.calls += v.calls;
      t.promptTokens += v.promptTokens;
      t.completionTokens += v.completionTokens;
      t.cachedTokens += v.cachedTokens;
      t.reasoningTokens += v.reasoningTokens;
      t.latencyMs += v.latencyMs;
      t.errors += v.errors;
    }
    return { ...t, cacheHitRate: t.promptTokens ? t.cachedTokens / t.promptTokens : 0 };
  }

  merge(other: UsageTracker): void {
    for (const [k, v] of other.buckets) {
      const b = this.buckets.get(k) ?? empty();
      for (const key of Object.keys(b) as Array<keyof UsageBucket>) b[key] += v[key];
      this.buckets.set(k, b);
    }
  }
}
