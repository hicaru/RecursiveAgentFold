import type { ChatMessage, LLMClient, LLMRequest, LLMResponse, ModelProfile } from '../types.js';
import { sleep } from '../util/concurrency.js';
import {
  defaultRateLimitRegistry,
  isRateLimitError,
  parseRetryAfterMs,
  type RateLimitCoordinator,
} from './rate-limit-gate.js';

export interface OpenAICompatibleConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /**
   * Z.ai / GLM style `thinking` switch. `undefined` = do not send the param.
   * Some models (e.g. glm-5.3*) refuse `disabled`; use `extraBody` for effort.
   */
  readonly thinking?: 'enabled' | 'disabled';
  /** Extra fields merged into the request body (e.g. reasoning_effort). */
  readonly extraBody?: Record<string, unknown>;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
  /** Stream tokens via SSE to keep long reasoning connections alive. Default true. */
  readonly stream?: boolean;
  /** Emit Anthropic-style cache_control blocks when ChatMessage.segments are present. */
  readonly cacheControl?: 'ephemeral';
  /** Forward LLMRequest.cacheKey as OpenAI prompt_cache_key. */
  readonly sendPromptCacheKey?: boolean;
  readonly maxRetries?: number;
  readonly retryBaseMs?: number;
  /** Upper bound for a single retry delay. Default 60s. */
  readonly retryMaxMs?: number;
  /** Attempts for HTTP 429 rate limits. */
  readonly rateLimitRetries?: number;
  /** Fixed wait between rate-limit retries. */
  readonly rateLimitDelayMs?: number;
  /** Attempts for provider content-filter refusals (code 1301). Default 1. */
  readonly filterRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly rateLimitGate?: RateLimitCoordinator;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
    readonly retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/** Provider error codes that never succeed on retry (Z.ai). */
const NON_RETRYABLE_CODES: Readonly<Record<string, true>> = Object.freeze({
  '1113': true, // insufficient balance / no resource package
  '1210': true, // invalid parameter
  '1211': true, // unknown model
  '1000': true,
  '1001': true,
  '1002': true,
  '1003': true,
  '1004': true, // auth
});

interface ChatCompletionUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly cache_read_input_tokens?: number;
  readonly completion_tokens_details?: { readonly reasoning_tokens?: number };
}

interface ChatCompletionResponse {
  readonly model?: string;
  readonly choices?: ReadonlyArray<{
    readonly message?: { readonly content?: string | null; readonly reasoning_content?: string | null };
    readonly delta?: { readonly content?: string | null; readonly reasoning_content?: string | null };
    readonly finish_reason?: string | null;
  }>;
  readonly usage?: ChatCompletionUsage;
  readonly error?: { readonly code?: string | number; readonly message?: string };
}

function serializeMessage(m: ChatMessage, useCacheControl: boolean): Record<string, unknown> {
  if (useCacheControl && m.segments && m.segments.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < m.segments.length; i++) {
      const seg = m.segments[i];
      if (!seg || seg.text.length === 0) continue;
      blocks.push({
        type: 'text',
        text: seg.text,
        ...(seg.cacheBreakpoint ? { cache_control: { type: 'ephemeral' } } : {}),
      });
    }
    if (blocks.length > 0) {
      return { role: m.role, content: blocks };
    }
  }
  return { role: m.role, content: m.content };
}

/**
 * Fetch-based client for OpenAI-compatible chat completion APIs
 * (Z.ai coding plan, OpenAI, vLLM, OpenRouter, ...). No SDK dependency.
 */
export class OpenAICompatibleClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly fetchImpl: typeof fetch;
  private readonly gate: RateLimitCoordinator;
  private _streamOptionsUnsupported = false;
  private _streamUnsupported = false;

  constructor(private readonly cfg: OpenAICompatibleConfig) {
    this.profile = Object.freeze({
      name: cfg.model,
      contextWindow: cfg.contextWindow,
      maxOutputTokens: cfg.maxOutputTokens,
    });
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.gate = cfg.rateLimitGate ?? defaultRateLimitRegistry.get(cfg.baseUrl);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const base = this.cfg.retryBaseMs ?? 2000;
    const budgets = {
      filter: this.cfg.filterRetries ?? 1,
      other: this.cfg.maxRetries ?? 4,
    };
    const used = { rateLimit: 0, filter: 0, other: 0 };
    let soloStreak = 0;
    for (;;) {
      const lease = await this.gate.acquire(req.signal, req.priority ?? 1);
      let soloAtAttempt = false;
      try {
        const res = await this.once(req);
        this.gate.noteSuccess();
        return res;
      } catch (e) {
        soloAtAttempt = lease.isSolo();
        const err = e instanceof LLMError ? e : undefined;
        const msg = err?.message ?? (e instanceof Error ? e.message : String(e));
        const rateLimited =
          !(req.signal?.aborted ?? false) && isRateLimitError(err?.code, err?.status, msg);
        if (rateLimited) {
          used.rateLimit += 1;
          this.gate.noteRateLimit(err?.retryAfterMs ?? this.cfg.rateLimitDelayMs);
          if (this.cfg.rateLimitRetries !== undefined) {
            if (used.rateLimit > this.cfg.rateLimitRetries) throw e;
          } else {
            if (soloAtAttempt) {
              soloStreak += 1;
              if (this.gate.shouldTerminateSolo(soloStreak)) {
                throw this.gate.createSoloExhaustedError(soloStreak, msg);
              }
            } else {
              soloStreak = 0;
            }
            if (this.gate.shouldTerminateTotal(used.rateLimit)) {
              throw this.gate.createExhaustedError(used.rateLimit, msg);
            }
          }
          continue;
        }
        const retryable = err?.retryable ?? !(req.signal?.aborted ?? false);
        if (!retryable) throw e;
        const kind = err?.code === '1301' ? 'filter' : 'other';
        used[kind] += 1;
        if (used[kind] > budgets[kind]) throw e;
        const cap = this.cfg.retryMaxMs ?? 60_000;
        const backoff = Math.min(cap, base * 2 ** (used[kind] - 1));
        const delay = Math.min(Math.max(err?.retryAfterMs ?? 0, backoff), cap) * (0.75 + Math.random() * 0.5);
        await sleep(delay, req.signal);
      } finally {
        lease.release();
      }
    }
  }

  private async once(req: LLMRequest): Promise<LLMResponse> {
    const useCacheControl =
      this.cfg.cacheControl === 'ephemeral' ||
      (/openrouter\.ai/i.test(this.cfg.baseUrl) && /claude|anthropic/i.test(this.cfg.model));
    const useStream = (this.cfg.stream ?? true) && !this._streamUnsupported;
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages.map((m) => serializeMessage(m, useCacheControl)),
      max_tokens: req.maxTokens ?? this.cfg.maxOutputTokens,
      stream: useStream,
    };
    if (useStream && !this._streamOptionsUnsupported) {
      body.stream_options = { include_usage: true };
    }
    if (req.cacheKey && (this.cfg.sendPromptCacheKey === true || /api\.openai\.com/i.test(this.cfg.baseUrl))) {
      body.prompt_cache_key = req.cacheKey;
    }
    const temperature = req.temperature ?? this.cfg.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (req.stop?.length) body.stop = req.stop;
    if (this.cfg.thinking) body.thinking = { type: this.cfg.thinking };
    if (this.cfg.extraBody) Object.assign(body, this.cfg.extraBody);

    const timeoutMs = this.cfg.timeoutMs;
    const hasTimeout = timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0;
    const timeout = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = timeout ? (req.signal ? AbortSignal.any([req.signal, timeout]) : timeout) : req.signal;
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
      const errMsg = e instanceof Error ? e.message : String(e);
      throw new LLMError(`network error: ${errMsg}`, undefined, undefined, !(req.signal?.aborted ?? false));
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (res.ok && contentType.includes('text/event-stream') && res.body !== null) {
      return this.consumeEventStream(res, started, signal, req);
    }

    const raw = await res.text();
    let json: ChatCompletionResponse | undefined;
    try {
      json = JSON.parse(raw) as ChatCompletionResponse;
    } catch {
      if (res.ok && raw.includes('data:')) {
        return this.parseRawSseBody(raw, started);
      }
    }
    if (!res.ok || json?.error) {
      const code = json?.error?.code !== undefined ? String(json.error.code) : undefined;
      const msg = json?.error?.message ?? raw.slice(0, 500);
      if (useStream && (res.status === 400 || code === '1210') && /stream_options|include_usage/i.test(msg)) {
        this._streamOptionsUnsupported = true;
        return this.once(req);
      }
      if (useStream && (res.status === 400 || code === '1210') && /\bstream\b/i.test(msg)) {
        this._streamUnsupported = true;
        return this.once(req);
      }
      const isRateLimited = isRateLimitError(code, res.status, msg);
      const retryable =
        !(code && NON_RETRYABLE_CODES[code] === true) &&
        (isRateLimited || res.status === 429 || res.status >= 500 || res.status === 408 || code === '1301');
      throw new LLMError(
        `[${res.status}${code ? `/${code}` : ''}] ${msg}`,
        res.status,
        code,
        retryable,
        parseRetryAfterMs(res.headers.get('retry-after')),
      );
    }
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new LLMError(`malformed response: ${raw.slice(0, 300)}`, res.status, undefined, true);
    const usage = json?.usage ?? {};
    return {
      text: choice.message.content ?? '',
      reasoning: choice.message.reasoning_content ?? undefined,
      model: json?.model ?? this.cfg.model,
      finishReason: choice.finish_reason ?? undefined,
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      },
    };
  }

  private async consumeEventStream(
    res: Response,
    started: number,
    signal: AbortSignal | undefined,
    req: LLMRequest,
  ): Promise<LLMResponse> {
    if (!res.body) {
      throw new LLMError('empty event stream body', res.status, undefined, true);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    let buffer = '';
    let model = this.cfg.model;
    let finishReason: string | undefined;
    let usage: ChatCompletionUsage = {};

    const processLine = (rawLine: string) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let chunk: ChatCompletionResponse;
      try {
        chunk = JSON.parse(payload) as ChatCompletionResponse;
      } catch {
        return;
      }
      if (chunk.error) {
        const code = chunk.error.code !== undefined ? String(chunk.error.code) : undefined;
        const msg = chunk.error.message ?? 'stream error';
        const isRateLimited = isRateLimitError(code, res.status, msg);
        const retryable = !(code && NON_RETRYABLE_CODES[code] === true) && (isRateLimited || code === '1301' || !code);
        throw new LLMError(`[stream${code ? `/${code}` : ''}] ${msg}`, res.status, code, retryable);
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? choice.message;
        if (delta?.content) contentParts.push(delta.content);
        if (delta?.reasoning_content) reasoningParts.push(delta.reasoning_content);
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    };

    try {
      for (;;) {
        if (signal?.aborted) {
          throw new LLMError('stream aborted', undefined, undefined, !(req.signal?.aborted ?? false));
        }
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          processLine(line);
          nl = buffer.indexOf('\n');
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        const trailing = buffer.split('\n');
        for (let i = 0; i < trailing.length; i++) {
          processLine(trailing[i] ?? '');
        }
      }
    } catch (e) {
      if (e instanceof LLMError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new LLMError(`stream read error: ${msg}`, undefined, undefined, !(req.signal?.aborted ?? false));
    } finally {
      reader.releaseLock();
    }

    const text = contentParts.join('');
    const reasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;
    return {
      text,
      ...(reasoning !== undefined ? { reasoning } : {}),
      model,
      ...(finishReason !== undefined ? { finishReason } : {}),
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      },
    };
  }

  private parseRawSseBody(raw: string, started: number): LLMResponse {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    let model = this.cfg.model;
    let finishReason: string | undefined;
    let usage: ChatCompletionUsage = {};
    const lines = raw.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] ?? '').trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const chunk = JSON.parse(payload) as ChatCompletionResponse;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice) {
          const delta = choice.delta ?? choice.message;
          if (delta?.content) contentParts.push(delta.content);
          if (delta?.reasoning_content) reasoningParts.push(delta.reasoning_content);
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      } catch {
        // Ignore non-JSON SSE comments or heartbeats.
      }
    }
    const reasoning = reasoningParts.length > 0 ? reasoningParts.join('') : undefined;
    return {
      text: contentParts.join(''),
      ...(reasoning !== undefined ? { reasoning } : {}),
      model,
      ...(finishReason !== undefined ? { finishReason } : {}),
      latencyMs: Date.now() - started,
      usage: {
        promptTokens: usage.prompt_tokens ?? 0,
        completionTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      },
    };
  }
}
