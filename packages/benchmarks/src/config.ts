import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OpenAICompatibleClient, type LLMClient, type LLMQueryOptions } from '@raf/engine';

/** Repository root (folder containing pnpm-workspace.yaml). */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
}

export function loadEnv(): void {
  const p = join(repoRoot(), '.env');
  if (existsSync(p)) process.loadEnvFile(p);
}

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const envNum = (k: string, d: number) => {
  const v = env(k);
  return v === undefined ? d : Number(v);
};
const envJSON = (k: string): Record<string, unknown> | undefined => {
  const v = env(k);
  return v ? (JSON.parse(v) as Record<string, unknown>) : undefined;
};
const envThinking = (k: string, d?: 'enabled' | 'disabled'): 'enabled' | 'disabled' | undefined => {
  const v = process.env[k];
  if (v === undefined) return d;
  if (v === '') return undefined;
  if (v !== 'enabled' && v !== 'disabled') throw new Error(`${k} must be enabled|disabled|empty`);
  return v;
};

export interface ModelOverrides {
  rootModel?: string;
  queryModel?: string;
  reserveRatio?: number;
  maxChunkTokens?: number;
  queryConcurrency?: number;
}

export interface BenchModels {
  root: LLMClient;
  query: LLMClient;
  llmQuery: LLMQueryOptions;
  describe(): Record<string, unknown>;
}

export function createModels(o: ModelOverrides = {}): BenchModels {
  loadEnv();
  const apiKey = env('ZAI_API_KEY');
  if (!apiKey) throw new Error('ZAI_API_KEY is not set (copy .env.example to .env)');
  const baseUrl = env('ZAI_BASE_URL', 'https://api.z.ai/api/coding/paas/v4')!;
  const rootCfg = {
    baseUrl,
    apiKey,
    model: o.rootModel ?? env('RAF_ROOT_MODEL', 'glm-5.1')!,
    contextWindow: envNum('RAF_ROOT_CONTEXT', 200_000),
    maxOutputTokens: envNum('RAF_ROOT_MAX_OUTPUT', 16_000),
    thinking: envThinking('RAF_ROOT_THINKING', 'enabled'),
    extraBody: envJSON('RAF_ROOT_EXTRA_BODY'),
    temperature: envNum('RAF_ROOT_TEMPERATURE', 0),
    maxRetries: envNum('RAF_MAX_RETRIES', 8),
    retryBaseMs: envNum('RAF_RETRY_BASE_MS', 5000),
    retryMaxMs: 30_000,
    timeoutMs: envNum('RAF_TIMEOUT_MS', 900_000),
  };
  const queryThinking = envThinking('RAF_QUERY_THINKING', 'disabled');
  const queryExtraBody = envJSON('RAF_QUERY_EXTRA_BODY');
  const rawQueryMax = envNum('RAF_QUERY_MAX_OUTPUT', 16384);
  const queryMaxOutput =
    queryThinking === 'enabled' || queryExtraBody !== undefined ? Math.max(16384, rawQueryMax) : rawQueryMax;
  const queryCfg = {
    baseUrl,
    apiKey,
    model: o.queryModel ?? env('RAF_QUERY_MODEL', 'glm-4.5-air')!,
    contextWindow: envNum('RAF_QUERY_CONTEXT', 128_000),
    maxOutputTokens: queryMaxOutput,
    thinking: queryThinking,
    extraBody: queryExtraBody,
    temperature: 0,
    maxRetries: envNum('RAF_MAX_RETRIES', 8),
    retryBaseMs: envNum('RAF_RETRY_BASE_MS', 5000),
    retryMaxMs: 30_000,
    timeoutMs: envNum('RAF_TIMEOUT_MS', 900_000),
  };
  const maxChunk = o.maxChunkTokens ?? (env('RAF_MAX_CHUNK_TOKENS') ? Number(env('RAF_MAX_CHUNK_TOKENS')) : undefined);
  const llmQuery: LLMQueryOptions = {
    reserveRatio: o.reserveRatio ?? envNum('RAF_RESERVE_RATIO', 0.3),
    maxChunkTokens: maxChunk,
    concurrency: o.queryConcurrency ?? envNum('RAF_QUERY_CONCURRENCY', 8),
  };
  return {
    root: new OpenAICompatibleClient(rootCfg),
    query: new OpenAICompatibleClient(queryCfg),
    llmQuery,
    describe: () => ({
      baseUrl,
      root: { ...rootCfg, apiKey: undefined },
      query: { ...queryCfg, apiKey: undefined },
      llmQuery,
    }),
  };
}
