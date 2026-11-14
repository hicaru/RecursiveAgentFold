import {
  isRetryableAssistantError,
  type Api,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type TextContent,
  type ThinkingLevel,
  type Usage,
} from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import {
  defaultRateLimitRegistry,
  isRateLimitError,
  parseRetryAfterMs,
  sleep,
  type ChatContentSegment,
  type ChatMessage,
  type LLMClient,
  type LLMRequest,
  type LLMResponse,
  type LLMUsage,
  type ModelProfile,
  type RateLimitCoordinator,
} from '@raf/engine/source';

export type ChatModel = Model<Api>;

const MAX_ANTHROPIC_CACHE_BLOCKS = 4;

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

/** Convert a native assistant message to an engine response. */
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

/** Return true when the model API uses explicit block-level cache_control markers. */
export function supportsExplicitCacheBlocks(model: ChatModel): boolean {
  if (model.api === 'anthropic-messages' || model.api === 'bedrock-converse-stream') return true;
  if (!('compat' in model) || model.compat === null || typeof model.compat !== 'object') return false;
  return 'cacheControlFormat' in model.compat && model.compat.cacheControlFormat === 'anthropic';
}

function effectiveUserSegments(message: ChatMessage): readonly ChatContentSegment[] {
  if (message.segments && message.segments.length > 0) {
    return message.segments.filter((seg) => seg.text.trim().length > 0);
  }
  if (message.content.trim().length === 0) return [];
  return [{ text: message.content, ...(message.cacheBreakpoint ? { cacheBreakpoint: true } : {}) }];
}

/** Convert engine chat messages to a pi transcript. */
export function toPiMessages(messages: readonly ChatMessage[], model: ChatModel): Message[] {
  const timestamp = Date.now();
  const explicitBlocks = supportsExplicitCacheBlocks(model);
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content, timestamp });
      continue;
    }
    if (m.role === 'user') {
      const supportsImages = Array.isArray(model.input) && model.input.includes('image');
      if (explicitBlocks) {
        const blocks: Array<TextContent | ImageContent> = [];
        let j = i;
        while (j < messages.length && messages[j]?.role === 'user') {
          const u = messages[j];
          if (u !== undefined) {
            const segs = effectiveUserSegments(u);
            for (let k = 0; k < segs.length; k++) {
              const seg = segs[k];
              if (seg) blocks.push({ type: 'text', text: seg.text });
            }
            if (supportsImages && u.attachments !== undefined) {
              for (const att of u.attachments) {
                if (att.kind === 'image' && att.data !== undefined) {
                  blocks.push({ type: 'image', data: att.data, mimeType: att.mimeType });
                }
              }
            }
          }
          j++;
        }
        i = j - 1;
        out.push({
          role: 'user',
          content: blocks.length > 0 ? blocks : [{ type: 'text', text: m.content }],
          timestamp,
        });
      } else {
        const imgBlocks: ImageContent[] = [];
        if (supportsImages && m.attachments !== undefined) {
          for (const att of m.attachments) {
            if (att.kind === 'image' && att.data !== undefined) {
              imgBlocks.push({ type: 'image', data: att.data, mimeType: att.mimeType });
            }
          }
        }
        out.push({
          role: 'user',
          content: imgBlocks.length > 0 ? [{ type: 'text', text: m.content }, ...imgBlocks] : m.content,
          timestamp,
        });
      }
      continue;
    }
    out.push({
      role: 'assistant',
      content: [{ type: 'text', text: m.content }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp,
    });
  }
  return out;
}

function countBlockBreakpoints(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  for (const item of value) {
    if (item !== null && typeof item === 'object' && 'cache_control' in item && item.cache_control !== undefined) {
      count += 1;
    }
  }
  return count;
}

function hasLongTtlMarker(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (item === null || typeof item !== 'object' || !('cache_control' in item)) continue;
    const cc: unknown = item.cache_control;
    if (cc !== null && typeof cc === 'object' && 'ttl' in cc && cc.ttl === '1h') {
      return true;
    }
  }
  return false;
}

/**
 * Align provider-level `cache_control` markers with RAF's 4-zone segments so
 * volatile tail blocks do not consume or bust prompt cache entries.
 */
export function applyCacheBreakpointsToPayload(
  payload: unknown,
  messages: readonly ChatMessage[],
  model: ChatModel,
): unknown {
  if (!supportsExplicitCacheBlocks(model) || payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const rec = payload as Record<string, unknown>;
  const wireMessages = rec.messages;
  if (!Array.isArray(wireMessages)) return undefined;

  const userSegmentFlags: boolean[] = [];
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const seg of effectiveUserSegments(m)) {
      userSegmentFlags.push(seg.cacheBreakpoint === true);
    }
  }
  if (userSegmentFlags.length === 0) return undefined;

  const wireUserBlocks: Array<Record<string, unknown>> = [];
  for (const wm of wireMessages) {
    if (wm === null || typeof wm !== 'object') continue;
    const msgRec = wm as Record<string, unknown>;
    if (msgRec.role !== 'user' || !Array.isArray(msgRec.content)) continue;
    for (const block of msgRec.content) {
      if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        wireUserBlocks.push(block as Record<string, unknown>);
      }
    }
  }
  if (wireUserBlocks.length !== userSegmentFlags.length) return undefined;

  let reserved = countBlockBreakpoints(rec.system) + countBlockBreakpoints(rec.tools);
  for (const wm of wireMessages) {
    if (wm === null || typeof wm !== 'object') continue;
    const msgRec = wm as Record<string, unknown>;
    if (msgRec.role === 'user') continue;
    reserved += countBlockBreakpoints(msgRec.content);
  }

  for (const block of wireUserBlocks) {
    delete block.cache_control;
  }

  const budget = Math.max(0, MAX_ANTHROPIC_CACHE_BLOCKS - reserved);
  if (budget === 0) return payload;

  const desired: number[] = [];
  for (let i = 0; i < userSegmentFlags.length; i++) {
    if (userSegmentFlags[i]) desired.push(i);
  }
  if (desired.length === 0) return payload;

  const chosen =
    desired.length <= budget
      ? desired
      : budget === 1
        ? [desired[desired.length - 1] ?? 0]
        : [desired[0] ?? 0, ...desired.slice(desired.length - (budget - 1))];

  const cacheMarker =
    hasLongTtlMarker(rec.system) || hasLongTtlMarker(rec.tools)
      ? { type: 'ephemeral', ttl: '1h' }
      : { type: 'ephemeral' };

  for (const idx of chosen) {
    const target = wireUserBlocks[idx];
    if (target !== undefined) {
      target.cache_control = { ...cacheMarker };
    }
  }
  return payload;
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
  readonly disableContinuation?: boolean;
  readonly rateLimitGate?: RateLimitCoordinator;
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

function abortReason(signal: AbortSignal | undefined, fallback: string): string {
  if (signal?.aborted === true) {
    const raw: unknown = signal.reason;
    const fromSignal = raw instanceof Error ? raw.message.trim() : typeof raw === 'string' ? raw.trim() : '';
    if (fromSignal !== '' && GENERIC_ABORT_MESSAGES.has(fallback.trim().toLowerCase())) {
      return fromSignal;
    }
  }
  return fallback;
}

/**
 * Engine LLM client over pi's model registry.
 */
export class ModelClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly opts: ModelClientOptions;
  private readonly gate: RateLimitCoordinator;

  constructor(opts: ModelClientOptions) {
    this.opts = opts;
    this.gate = opts.rateLimitGate ?? defaultRateLimitRegistry.get(opts.model.provider);
    this.profile = {
      name: modelSpec(opts.model),
      contextWindow: opts.model.contextWindow,
      maxOutputTokens: Math.min(
        opts.maxOutputTokens,
        opts.model.maxTokens > 0 ? opts.model.maxTokens : opts.maxOutputTokens,
      ),
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
    const gate = this.gate;
    const priority = req.priority ?? 1;
    let transient = 0;
    let soloStreak = 0;
    let totalRateLimits = 0;
    for (;;) {
      const lease = await gate.acquire(req.signal, priority);
      let message: AssistantMessage;
      let retryAfterMs: number | undefined;
      let solo = true;
      try {
        const res = await this.once(req);
        message = res.message;
        retryAfterMs = res.retryAfterMs;
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
        totalRateLimits += 1;
        gate.noteRateLimit(retryAfterMs);
        if (solo) {
          soloStreak += 1;
          if (gate.shouldTerminateSolo(soloStreak)) throw gate.createSoloExhaustedError(soloStreak, reason);
        } else {
          soloStreak = 0;
        }
        if (gate.shouldTerminateTotal(totalRateLimits)) {
          throw gate.createExhaustedError(totalRateLimits, reason);
        }
        continue;
      }
      transient += 1;
      if (!isRetryableAssistantError(message) || transient > MAX_TRANSIENT_RETRIES) throw new Error(reason);
      const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (transient - 1));
      await sleep(backoff * (0.75 + Math.random() * 0.5), req.signal);
    }
  }

  private async once(req: LLMRequest): Promise<{ message: AssistantMessage; retryAfterMs?: number }> {
    const { registry, model, reasoning, sessionId, disableContinuation } = this.opts;
    const scopedSession =
      sessionId === undefined
        ? undefined
        : req.cacheKey
          ? `${sessionId}:${req.cacheKey}`
          : req.purpose
            ? `${sessionId}:${req.purpose}`
            : sessionId;
    let retryAfterMs: number | undefined;
    const message = await registry
      .streamSimple(
        model,
        { messages: toPiMessages(req.messages, model) },
        {
          maxTokens: req.maxTokens ?? this.profile.maxOutputTokens,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(reasoning !== undefined ? { reasoning } : {}),
          ...(req.signal !== undefined ? { signal: req.signal } : {}),
          ...(scopedSession !== undefined ? { sessionId: scopedSession } : {}),
          ...(disableContinuation === true ? { disableContinuation: true } : {}),
          onPayload: (payload) => applyCacheBreakpointsToPayload(payload, req.messages, model),
          onResponse: (response) => {
            const parsed = parseRetryAfterMs(response.headers["retry-after"]);
            if (parsed !== undefined) retryAfterMs = parsed;
          },
        },
      )
      .result();
    return { message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
}

/**
 * Root client for native steps.
 */
export class PrefetchedRootClient implements LLMClient {
  readonly profile: ModelProfile;
  private readonly live: ModelClient;
  private prefetched?: { readonly messages: readonly ChatMessage[]; readonly response: LLMResponse };

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
