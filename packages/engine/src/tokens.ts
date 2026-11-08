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

function isCjkCode(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

export class CharRatioEstimator implements TokenEstimator {
  readonly cjkCharsPerToken: number;
  constructor(
    readonly charsPerToken = 3.6,
    cjkCharsPerToken?: number,
  ) {
    if (!(charsPerToken > 0)) throw new Error('charsPerToken must be > 0');
    this.cjkCharsPerToken = cjkCharsPerToken ?? Math.min(charsPerToken, 1.4);
    if (!(this.cjkCharsPerToken > 0)) throw new Error('cjkCharsPerToken must be > 0');
  }
  count(text: string): number {
    const len = text.length;
    if (len === 0) return 0;
    let cjkCount = 0;
    for (let i = 0; i < len; i++) {
      if (isCjkCode(text.charCodeAt(i))) cjkCount++;
    }
    const otherCount = len - cjkCount;
    return Math.ceil(cjkCount / this.cjkCharsPerToken + otherCount / this.charsPerToken);
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
  const totalTokens = estimator.count(text);
  if (totalTokens <= maxTokens) return { text, truncated: false };
  const effectiveCharsPerToken = text.length / Math.max(1, totalTokens);
  const budget = Math.min(estimator.chars(maxTokens), Math.floor(maxTokens * effectiveCharsPerToken));
  const head = Math.floor(budget * 0.8);
  const tail = Math.max(0, budget - head);
  const omitted = text.length - head - tail;
  return {
    text:
      text.slice(0, head) +
      `\n…[truncated ${omitted} characters — narrow the request (smaller line range or a more precise query)]…\n` +
      (tail > 0 ? text.slice(text.length - tail) : ''),
    truncated: true,
  };
}
