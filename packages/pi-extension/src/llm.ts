import {
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  defaultRateLimitGate,
  isRateLimitError,
  sleep,
  type ChatMessage,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelProfile,
} from '@raf/engine/source';

export type ChatModel = Model<Api>;

/** Format a model as `provider/id`. */
export function modelSpec(model: ChatModel): string {
  return `${model.provider}/${model.id}`;
}

/** Find a model by its `provider/id` spec. An empty spec gives undefined. */
export function findModel(registry: ModelRegistry, spec: string): ChatModel | undefined {
  const slash = spec.indexOf('/');
  if (slash <= 0) return undefined;
  return registry.find(spec.slice(0, slash), spec.slice(slash + 1));
}

/** Convert a pi thinking level to a request reasoning option. "off" sends none. */
export function reasoningOf(level: ModelThinkingLevel | undefined): ThinkingLevel | undefined {
  return level === undefined || level === 'off' ? undefined : level;
}

/** Map pi usage to engine usage. Engine prompt counts include cache reads and writes. */
export function toEngineUsage(usage: Usage): LLMUsage {
  return {
    promptTokens: usage.input + usage.cacheRead + usage.cacheWrite,
    completionTokens: usage.output,
    cachedTokens: usage.cacheRead,
    ...(usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : {}),
  };
}

/** Add usage b to usage a. Returns a new object. */
export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

/**
 * Convert a native assistant message to an engine response. The engine reads
 * the protocol from text. A native tool call (not expected: RAF requests declare
 * no tools) is re-encoded as a protocol tool call, so no output is lost.
 */
export function toEngineResponse(message: AssistantMessage): LLMResponse {
  const text: string[] = [];
  const reasoning: string[] = [];
  for (const block of message.content) {
    if (block.type === 'text') text.push(block.text);
    else if (block.type === 'thinking') {
      if (block.redacted !== true) reasoning.push(block.thinking);
    } else {
      text.push(`<tool_call>${JSON.stringify({ name: block.name, arguments: block.arguments })}</tool_call>`);
    }
  }
  const joinedReasoning = reasoning.join('');
  return {
    text: text.join(''),
    ...(joinedReasoning !== '' ? { reasoning: joinedReasoning } : {}),
    usage: toEngineUsage(message.usage),
    model: message.responseModel ?? message.model,
    latencyMs: message.durationMs ?? Math.max(0, Date.now() - message.timestamp),
    finishReason: message.stopReason === 'length' ? 'length' : message.stopReason,
  };
}

/** Convert engine chat messages to a pi transcript. */
export function toPiMessages(messages: readonly ChatMessage[], model: ChatModel): Message[] {
  const timestamp = Date.now();
  const out: Message[] = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'system') out[i] = { role: 'system', content: m.content, timestamp };
    else if (m.role === 'user') out[i] = { role: 'user', content: m.content, timestamp };
    else {
      out[i] = {
        role: 'assistant',
        content: [{ type: 'text', text: m.content }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: 'stop',
        timestamp,
      };
    }
  }
  return out;
}

/** A zero usage record. */
export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export interface ModelClientOptions {
  readonly registry: ModelRegistry;
  readonly model: ChatModel;
  readonly reasoning?: ThinkingLevel;
  readonly maxOutputTokens: number;
  readonly sessionId?: string;
  /** Receives the native usage (with cost) of every completed call. */
  readonly onUsage?: (usage: Usage, request: LLMRequest) => void;
  /** Called when a logical call starts and ends (retries included). */
  readonly onStart?: () => void;
  readonly onEnd?: () => void;
}

const MAX_TRANSIENT_RETRIES = 4;
const RETRY_BASE_MS = 2000;
const RETRY_MAX_MS = 60_000;

const GENERIC_ABORT_MESSAGES: ReadonlySet<string> = new Set(
  Object.freeze([
    '',
    'aborted',
    'request aborted',
    'operation aborted',
    'this operation was aborted',
    'the operation was aborted',
    'the operation was aborted.',
  ]),
);

/** Prefer the specific AbortSignal reason over generic fetch abort strings. */
function abortReason(signal: AbortSignal | undefined, fallback: string): string {
  if (signal?.aborted === true) {
    const raw: unknown = signal.reason;
    const fromSignal =
      raw instanceof Error ? raw.message.trim() : typeof raw === 'string' ? raw.trim() : '';
    if (fromSignal !== '' && GENERIC_ABORT_MESSAGES.has(fallback.trim().toLowerCase())) {
      return fromSignal;
    }
  }
  return fallback;
}

/**
 * Engine LLM client over pi's model registry. pi resolves auth and provider
 * transport. The engine rate-limit gate coordinates parallel branch and
 * reader calls; other transient failures retry with exponential backoff.
 */
export class ModelClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly opts: ModelClientOptions;

  constructor(opts: ModelClientOptions) {
    this.opts = opts;
    this.profile = {
      name: modelSpec(opts.model),
      contextWindow: opts.model.contextWindow,
      maxOutputTokens: Math.min(opts.maxOutputTokens, opts.model.maxTokens > 0 ? opts.model.maxTokens : opts.maxOutputTokens),
    };
  }

  get model(): ChatModel {
    return this.opts.model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.opts.onStart?.();
    try {
      return await this.completeWithRetry(req);
    } finally {
      this.opts.onEnd?.();
    }
  }

  private async completeWithRetry(req: LLMRequest): Promise<LLMResponse> {
    const gate = defaultRateLimitGate;
    let transient = 0;
    let soloStreak = 0;
    for (;;) {
      const lease = await gate.acquire(req.signal);
      let message: AssistantMessage;
      let solo = true;
      try {
        message = await this.once(req);
        solo = lease.isSolo();
      } finally {
        lease.release();
      }
      if (message.stopReason !== 'error' && message.stopReason !== 'aborted') {
        gate.noteSuccess();
        this.opts.onUsage?.(message.usage, req);
        return toEngineResponse(message);
      }
      const reason = message.errorMessage ?? `request ${message.stopReason}`;
      if (message.stopReason === 'aborted' || req.signal?.aborted === true) {
        throw new Error(abortReason(req.signal, reason));
      }
      if (isRateLimitError(undefined, undefined, reason)) {
        gate.noteRateLimit();
        if (solo) {
          soloStreak += 1;
          if (gate.shouldTerminateSolo(soloStreak)) throw gate.createSoloExhaustedError(soloStreak, reason);
        } else {
          soloStreak = 0;
        }
        continue;
      }
      transient += 1;
      if (!isRetryableAssistantError(message) || transient > MAX_TRANSIENT_RETRIES) throw new Error(reason);
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (transient - 1));
      await sleep(backoff * (0.75 + Math.random() * 0.5), req.signal);
    }
  }

  private once(req: LLMRequest): Promise<AssistantMessage> {
    const { registry, model, reasoning, sessionId } = this.opts;
    return registry
      .streamSimple(
        model,
        { messages: toPiMessages(req.messages, model) },
        {
          maxTokens: req.maxTokens ?? this.profile.maxOutputTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
        },
      )
      .result();
  }
}

/**
 * Root client for native steps. pi already sent the first attempt of a step
 * as a native request; `next()` receives that response here. Any other call
 * (format repair, forced answer) goes to the live model.
 */
export class PrefetchedRootClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly live: ModelClient;
  private prefetched: { readonly messages: readonly ChatMessage[]; readonly response: LLMResponse } | undefined;

  constructor(live: ModelClient) {
    this.live = live;
    this.profile = live.profile;
  }

  /** Queue the native response for the request built from `messages`. */
  prefetch(messages: readonly ChatMessage[], response: LLMResponse): void {
    this.prefetched = { messages, response };
  }

  /** Drop a queued response that no call consumed. */
  clear(): void {
    this.prefetched = undefined;
  }

  complete(req: LLMRequest): Promise<LLMResponse> {
    const queued = this.prefetched;
    this.prefetched = undefined;
    if (queued !== undefined && queued.messages === req.messages) return Promise.resolve(queued.response);
    return this.live.complete(req);
  }
}
