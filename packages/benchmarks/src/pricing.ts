/** USD per 1M tokens. */
export interface TokenPrice {
  input: number;
  cached: number;
  output: number;
}

/** Z.ai list prices. Models not listed here get no cost estimate. */
const PRICES: Record<string, TokenPrice> = {
  'glm-5.3': { input: 1.4, cached: 0.26, output: 4.4 },
  'glm-5.3-flash': { input: 0.15, cached: 0.03, output: 0.5 },
};

/** Env override for any model: RAF_PRICE_INPUT / RAF_PRICE_CACHED / RAF_PRICE_OUTPUT. */
function envPrice(): TokenPrice | undefined {
  const input = process.env.RAF_PRICE_INPUT;
  const cached = process.env.RAF_PRICE_CACHED;
  const output = process.env.RAF_PRICE_OUTPUT;
  if (input === undefined || cached === undefined || output === undefined) return undefined;
  return { input: Number(input), cached: Number(cached), output: Number(output) };
}

export function priceFor(model: string): TokenPrice | undefined {
  return envPrice() ?? PRICES[model];
}

export interface TokenCounts {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export function costOf(price: TokenPrice, t: TokenCounts): number {
  const fresh = Math.max(0, t.promptTokens - t.cachedTokens);
  return (fresh * price.input + t.cachedTokens * price.cached + t.completionTokens * price.output) / 1_000_000;
}

/** Money the provider cache saved: cached tokens billed at input rate minus at cached rate. */
export function cacheSaved(price: TokenPrice, t: TokenCounts): number {
  return (t.cachedTokens * (price.input - price.cached)) / 1_000_000;
}
