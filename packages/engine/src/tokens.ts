/**
 * Token estimation. Exact tokenizers are model specific; the engine only needs
 * a stable, slightly pessimistic estimate for budgeting (chunk sizes,
 * observation truncation). The ratio can be calibrated per document when the
 * true token count is known (e.g. OOLONG ships `context_len`).
 */
export interface TokenEstimator {
  count(text: string): number;
  /** Inverse: approximate number of characters for a token budget. */
  chars(tokens: number): number;
}

export class CharRatioEstimator implements TokenEstimator {
  constructor(readonly charsPerToken = 3.6) {
    if (!(charsPerToken > 0)) throw new Error('charsPerToken must be > 0');
  }
  count(text: string): number {
    return Math.ceil(text.length / this.charsPerToken);
  }
  chars(tokens: number): number {
    return Math.floor(tokens * this.charsPerToken);
  }
}

export const defaultEstimator: TokenEstimator = new CharRatioEstimator();

/** Truncate text to roughly `maxTokens`, keeping head and tail. */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  estimator: TokenEstimator = defaultEstimator,
): { text: string; truncated: boolean } {
  if (estimator.count(text) <= maxTokens) return { text, truncated: false };
  const budget = estimator.chars(maxTokens);
  const head = Math.floor(budget * 0.8);
  const tail = Math.max(0, budget - head);
  const omitted = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      `\n…[已截断 ${omitted} 个字符 — 请缩小请求范围（更小的行区间或更精确的查询）]…\n` +
      (tail > 0 ? text.slice(text.length - tail) : ''),
    truncated: true,
  };
}
