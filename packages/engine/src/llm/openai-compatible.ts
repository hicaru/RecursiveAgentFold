import type { LLMClient, LLMRequest, LLMResponse, ModelProfile } from '../types.js';
import { sleep } from '../util/concurrency.js';

export interface OpenAICompatibleConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  temperature?: number;
  /**
   * Z.ai / GLM style `thinking` switch. `undefined` = do not send the param.
   * Some models (e.g. glm-5.3*) refuse `disabled`; use `extraBody` for effort.
   */
  thinking?: 'enabled' | 'disabled';
  /** Extra fields merged into the request body (e.g. reasoning_effort). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /** Upper bound for a single retry delay. Default 60s. */
  retryMaxMs?: number;
  fetchImpl?: typeof fetch;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Provider error codes that never succeed on retry (Z.ai). */
const NON_RETRYABLE_CODES = new Set([
  '1113', // insufficient balance / no resource package
  '1210', // invalid parameter
  '1211', // unknown model
  '1000', '1001', '1002', '1003', '1004', // auth
  '1301', // content filter
]);

interface ChatCompletionResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string | null; reasoning_content?: string | null };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: string | number; message?: string };
}

/**
 * Fetch-based client for OpenAI-compatible chat completion APIs
 * (Z.ai coding plan, OpenAI, vLLM, OpenRouter, ...). No SDK dependency.
 */
export class OpenAICompatibleClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.profile = {
      name: cfg.model,
      contextWindow: cfg.contextWindow,
      maxOutputTokens: cfg.maxOutputTokens,
    };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const maxRetries = this.cfg.maxRetries ?? 4;
    const base = this.cfg.retryBaseMs ?? 2000;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.once(req);
      } catch (e) {
        lastErr = e;
        const retryable = e instanceof LLMError ? e.retryable : !(req.signal?.aborted ?? false);
        if (!retryable || attempt === maxRetries) throw e;
        const delay = Math.min(this.cfg.retryMaxMs ?? 60_000, base * 2 ** attempt) * (0.75 + Math.random() * 0.5);
        await sleep(delay, req.signal);
      }
    }
    throw lastErr;
  }

  private async once(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      max_tokens: req.maxTokens ?? this.cfg.maxOutputTokens,
      stream: false,
    };
    const temperature = req.temperature ?? this.cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (req.stop?.length) body.stop = req.stop;
    if (this.cfg.thinking) body.thinking = { type: this.cfg.thinking };
    if (this.cfg.extraBody) Object.assign(body, this.cfg.extraBody);

    const timeout = AbortSignal.timeout(this.cfg.timeoutMs ?? 600_000);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...this.cfg.headers,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new LLMError(`network error: ${(e as Error).message}`, undefined, undefined, !req.signal?.aborted);
    }
    const raw = await res.text();
    let json: ChatCompletionResponse | undefined;
    try {
      json = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      /* non-JSON body */
    }
    if (!res.ok || json?.error) {
      const code = json?.error?.code !== undefined ? String(json.error.code) : undefined;
      const msg = json?.error?.message ?? raw.slice(0, 500);
      const retryable =
        !(code && NON_RETRYABLE_CODES.has(code)) &&
        (res.status === 429 || res.status >= 500 || res.status === 408);
      throw new LLMError(`[${res.status}${code ? `/${code}` : ''}] ${msg}`, res.status, code, retryable);
    }
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new LLMError(`malformed response: ${raw.slice(0, 300)}`, res.status, undefined, true);
    const usage = json?.usage ?? {};
    return {
      text: choice.message.content ?? '',
      reasoning: choice.message.reasoning_content ?? undefined,
      model: json?.model ?? this.cfg.model,
      finishReason: choice.finish_reason,
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      },
    };
  }
}
