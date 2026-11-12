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
  /** Return the longest prefix of `text` within `maxTokens`. */
  prefixChars?(text: string, maxTokens: number): number;
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
    if (!(tokens > 0)) return 0;
    return Math.floor(tokens * this.charsPerToken);
  }
  prefixChars(text: string, maxTokens: number): number {
    if (!(maxTokens > 0) || text.length === 0) return 0;
    const invCjk = 1 / this.cjkCharsPerToken;
    const invOther = 1 / this.charsPerToken;
    let used = 0;
    const len = text.length;
    for (let i = 0; i < len; i++) {
      const cost = isCjkCode(text.charCodeAt(i)) ? invCjk : invOther;
      if (used + cost > maxTokens) return i;
      used += cost;
    }
    return len;
  }
}

export const defaultEstimator: CharRatioEstimator = new CharRatioEstimator();

function suffixCharsWithinTokens(text: string, maxTokens: number, estimator: TokenEstimator): number {
  if (!(maxTokens > 0) || text.length === 0) return 0;
  if (estimator instanceof CharRatioEstimator) {
    const invCjk = 1 / estimator.cjkCharsPerToken;
    const invOther = 1 / estimator.charsPerToken;
    let used = 0;
    for (let i = text.length - 1; i >= 0; i--) {
      const cost = isCjkCode(text.charCodeAt(i)) ? invCjk : invOther;
      if (used + cost > maxTokens) return text.length - 1 - i;
      used += cost;
    }
    return text.length;
  }
  const totalTokens = Math.max(1, estimator.count(text));
  return Math.min(text.length, Math.floor((maxTokens / totalTokens) * text.length));
}

/** Truncate text to roughly `maxTokens`, keeping head and tail. */
export function truncateToTokens(
  text: string,
  maxTokens: number,
  estimator: TokenEstimator = defaultEstimator,
): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  const totalTokens = estimator.count(text);
  if (totalTokens <= maxTokens) return { text, truncated: false };
  const headBudget = Math.max(1, Math.floor(maxTokens * 0.8));
  const tailBudget = Math.max(0, maxTokens - headBudget);
  const head = estimator.prefixChars
    ? estimator.prefixChars(text, headBudget)
    : Math.min(text.length, Math.floor((headBudget / totalTokens) * text.length));
  const maxTail = Math.max(0, text.length - head);
  const tail = Math.min(maxTail, suffixCharsWithinTokens(text, tailBudget, estimator));
  const omitted = Math.max(0, text.length - head - tail);
  return {
    text:
      text.slice(0, head) +
      `\n…[truncated ${omitted} characters — narrow the request (smaller line range or a more precise query)]…\n` +
      (tail > 0 ? text.slice(text.length - tail) : ''),
    truncated: true,
  };
}
