import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

let dshIsAgentLoopRequest;
const dshLlmProbe = import('@deepseek-ai/dsh-llm')
  .then((mod) => {
    if (typeof mod?.isAgentLoopRequest === 'function') {
      dshIsAgentLoopRequest = mod.isAgentLoopRequest;
    }
  })
  .catch(() => {});
const ENGINE_STANDARD = 'standard';
const ENGINE_RAF = 'raf';
const ENGINE_ROUTE = '/plugins/@raf/dsh-plugin/engine';
const RUNS_ROUTE = '/plugins/@raf/dsh-plugin/runs';
const MODELS_ROUTE = '/plugins/@raf/dsh-plugin/models';
const DEFAULT_SETTINGS = Object.freeze({
  depth: 2,
  reserve: 0.3,
  concurrency: 4,
  branchProvider: '',
  branchModel: '',
  branchReasoningEffort: '',
  queryProvider: '',
  queryModel: '',
  deepStudy: false,
});
const DEPTH_MIN = 1;
const DEPTH_MAX = 3;
const RESERVE_MIN = 0.1;
const RESERVE_MAX = 0.5;
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const MAX_BODY_BYTES = 8192;
const MAX_ENGINE_ENTRIES = 2000;
const MAX_RUNS = 30;
const MAX_RUN_EVENTS = 5000;
const RAF_ROOT_MAX_STEPS = 100;
const RAF_BRANCH_MAX_STEPS = 20;
const RAF_ROOT_MAX_OUTPUT = 16000;
const RAF_QUERY_MAX_OUTPUT = 16384;
const RAF_VISIBLE_REASONING_CHARS = 12_000;
const RAF_PROMPT_BUDGET_RATIO = 0.6;
const RAF_STATE_MAX_DOC_CHARS = 16_000_000;
const RAF_STATE_MAX_DOCS = 500;
const RAF_MAX_INVALID_STEPS = 3;
const RAF_MAX_INVALID_TOTAL = 6;
const RAF_MAX_REASONING_TOKENS = 32_000;
const BRANCH_REPORT_ID_PREFIX = 'branch_report_';
/** Provider failures that a repeated identical request can resolve. */
const RAF_LLM_RETRY_CODES = Object.freeze(['TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'SERVER', 'EMPTY_RESPONSE']);
const RAF_LLM_RETRY_MAX_ATTEMPTS = 6;
const RAF_LLM_RETRY_BASE_DELAY_MS = 500;
const RAF_LLM_RATE_LIMIT_BASE_DELAY_MS = 5_000;
const RAF_LLM_RETRY_MAX_DELAY_MS = 10_000;
export const inject = ['agents', 'llm', 'tools'];

const rafInternal = new AsyncLocalStorage();

let rafPromise;

function loadRaf() {
  if (rafPromise === undefined) {
    const loader = process.env.VITEST
      ? import(new URL('../engine/src/index.ts', import.meta.url)).catch(() =>
          import(new URL('../engine/dist/index.js', import.meta.url)),
        )
      : import(new URL('../engine/dist/index.js', import.meta.url));
    rafPromise = loader.then((mod) => {
      if (mod?.defaultRateLimitGate) {
        bindRateLimitGate(mod.defaultRateLimitGate);
      }
      return mod;
    });
  }
  return rafPromise;
}

function toInteger(value, fallback, min, max) {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function toReserve(value) {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SETTINGS.reserve;
  const clamped = Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, number));
  return Number((Math.round(clamped / 0.05) * 0.05).toFixed(2));
}

function toModelString(value) {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function splitModelSpec(provider, model) {
  let nextProvider = toModelString(provider);
  let nextModel = toModelString(model);
  if (nextProvider === '' && nextModel.includes('/')) {
    const slash = nextModel.indexOf('/');
    nextProvider = nextModel.slice(0, slash).trim();
    nextModel = nextModel.slice(slash + 1).trim();
  }
  return { provider: nextProvider, model: nextModel };
}

function toEffort(value) {
  return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function sanitizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const branch = splitModelSpec(source.branchProvider, source.branchModel);
  const query = splitModelSpec(source.queryProvider, source.queryModel);
  return Object.freeze({
    depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
    reserve: toReserve(source.reserve),
    concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
    branchProvider: branch.provider,
    branchModel: branch.model,
    branchReasoningEffort: toEffort(source.branchReasoningEffort),
    queryProvider: query.provider,
    queryModel: query.model,
    deepStudy: source.deepStudy === true,
  });
}

function sanitizeEngine(value) {
  return value === ENGINE_RAF ? ENGINE_RAF : ENGINE_STANDARD;
}

function statePath() {
  const base = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh');
  return join(base, 'raf-engine', 'state.json');
}

function loadState() {
  const fallback = { defaultEngine: ENGINE_STANDARD, engines: Object.create(null), settings: DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const engines = Object.create(null);
    if (parsed.engines !== null && typeof parsed.engines === 'object') {
      for (const [sessionId, value] of Object.entries(parsed.engines)) {
        engines[sessionId] = sanitizeEngine(value);
      }
    }
    const stored = parsed.defaultEngine;
    const defaultEngine =
      stored === undefined
        ? Object.values(engines).includes(ENGINE_RAF)
          ? ENGINE_RAF
          : ENGINE_STANDARD
        : sanitizeEngine(stored);
    return { defaultEngine, engines, settings: sanitizeSettings(parsed.settings) };
  } catch {
    return fallback;
  }
}

function stateJson(state) {
  return JSON.stringify(
    { version: 1, defaultEngine: state.defaultEngine, engines: state.engines, settings: state.settings },
    null,
    2,
  );
}

function engineOf(state, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return state.defaultEngine;
  return state.engines[sessionId] ?? state.defaultEngine;
}

function setEngine(state, sessionId, engine) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const next = sanitizeEngine(engine);
  state.engines[sessionId] = next;
  state.defaultEngine = next;
  const keys = Object.keys(state.engines);
  while (keys.length > MAX_ENGINE_ENTRIES) {
    const oldest = keys.shift();
    if (oldest !== undefined) delete state.engines[oldest];
  }
}

function renderContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    if (block.type === 'tool-call') {
      const args = typeof block.arguments === 'string' ? block.arguments : JSON.stringify(block.arguments ?? {});
      parts.push(`[tool call ${block.name ?? 'tool'}] ${args}`);
      continue;
    }
    if (block.type === 'image') {
      parts.push('[image]');
      continue;
    }
    if (block.type === 'file') {
      const name = block.attachment !== null && typeof block.attachment === 'object' ? block.attachment.name : '';
      parts.push(`[file ${typeof name === 'string' ? name : ''}]`);
    }
  }
  return parts.join('\n').trim();
}

function isHumanUserMessage(message) {
  return (
    message !== null &&
    typeof message === 'object' &&
    message.role === 'user' &&
    message.source !== null &&
    typeof message.source === 'object' &&
    message.source.kind === 'user'
  );
}

function isInstructionMessage(message) {
  const kind = message?.source?.kind;
  return kind === 'agent-instructions' || kind === 'skill-catalog';
}

function isSyntheticContextMessage(message) {
  if (message === null || typeof message !== 'object' || message.role !== 'user') return false;
  if (isHumanUserMessage(message)) return false;
  if (isInstructionMessage(message)) return true;
  const text = renderContent(message.content).trim();
  return (
    text.startsWith('<system-reminder') ||
    text.startsWith('Current runtime context.') ||
    text.startsWith('Time sampled while preparing turn')
  );
}

function latestUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(messages[index])) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== null && typeof message === 'object' && message.role === 'user' && !isSyntheticContextMessage(message)) {
      return index;
    }
  }
  return -1;
}

function hasHumanUserMessage(messages) {
  return messages.some(isHumanUserMessage);
}

function extractMessageAttachments(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return [];
  const out = [];
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'image') {
      out.push({
        kind: 'image',
        mimeType: typeof block.mimeType === 'string' ? block.mimeType : 'image/png',
        ...(typeof block.data === 'string' ? { data: block.data } : {}),
        hostRef: block,
      });
    } else if (block.type === 'file') {
      const att = block.attachment !== null && typeof block.attachment === 'object' ? block.attachment : undefined;
      out.push({
        kind: 'file',
        name: typeof att?.name === 'string' ? att.name : 'file',
        ...(typeof att?.mimeType === 'string' ? { mimeType: att.mimeType } : {}),
        hostRef: block,
      });
    }
  }
  return out;
}

function extractHostAddendum(outer, messages) {
  const parts = [];
  if (typeof outer?.system === 'string' && outer.system.trim() !== '') {
    parts.push(outer.system.trim());
  } else if (Array.isArray(outer?.system)) {
    const sysText = renderContent(outer.system);
    if (sysText !== '') parts.push(sysText);
  }
  for (const msg of messages) {
    if (!isInstructionMessage(msg)) continue;
    const text = renderContent(msg.content).trim();
    if (text !== '') parts.push(text);
  }
  return parts.join('\n\n');
}
const PTC_LOCKOUT_RE = /only\s+`?run_code`?\s+is\s+callable\s+directly/i;

function renderTranscript(messages) {
  const parts = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
    if (isSyntheticContextMessage(message)) continue;
    const text = renderContent(message.content);
    if (text === '') continue;
    if (message.role === 'tool' && PTC_LOCKOUT_RE.test(text)) continue;
    const label = message.role === 'tool' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`## ${label}\n${text}`);
  }
  return parts.join('\n\n');
}

function extractPriorTurnBlocks(messages, raf) {
  if (!Array.isArray(messages) || typeof raf?.FoldState !== 'function') return undefined;
  const pairs = [];
  let pendingQuestion;
  let lastAssistantText = '';
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'user') {
      if (isSyntheticContextMessage(message)) continue;
      const text = renderContent(message.content).trim();
      if (text === '') continue;
      if (pendingQuestion !== undefined && lastAssistantText !== '') {
        pairs.push({ question: pendingQuestion, answer: lastAssistantText });
      }
      pendingQuestion = text;
      lastAssistantText = '';
    } else if (message.role === 'assistant') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const textParts = [];
      for (const block of blocks) {
        if (
          block !== null &&
          typeof block === 'object' &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          block.text.trim() !== ''
        ) {
          textParts.push(block.text.trim());
        }
      }
      if (textParts.length > 0) {
        lastAssistantText = textParts.join('\n').trim();
      }
    }
  }
  if (pendingQuestion !== undefined && lastAssistantText !== '') {
    pairs.push({ question: pendingQuestion, answer: lastAssistantText });
  }
  if (pairs.length === 0) return undefined;
  const seeded = new raf.FoldState();
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const step = seeded.currentStep;
    const shortQuestion = pair.question.replace(/\s+/g, ' ').trim().slice(0, 120);
    const shortAnswer = pair.answer.replace(/\s+/g, ' ').trim().slice(0, 600);
    seeded.setLatest({
      step,
      motivation: `Turn ${i + 1}: ${shortQuestion}`,
      action: { name: 'answer', arguments: {} },
      observation: shortAnswer,
    });
    seeded.applyFold({
      range: [step, step],
      summary: `Turn ${i + 1} (${shortQuestion}): ${shortAnswer}`,
    });
  }
  return {
    initialQuestion: pairs[0].question,
    rootState: seeded.snapshot(),
  };
}
function questionOf(messages, index) {
  if (index < 0) return '';
  return renderContent(messages[index].content);
}

function contextWindowOf(ctx, sessionId, outer) {
  try {
    const llm = ctx.get('llm');
    if (llm !== undefined && typeof llm.resolveModelInfo === 'function' && outer?.provider && outer?.model) {
      const info = llm.resolveModelInfo({ provider: outer.provider, model: outer.model });
      if (info !== null && typeof info === 'object' && Number.isFinite(info.contextWindow) && info.contextWindow > 0) {
        return info.contextWindow;
      }
    }
    const agents = ctx.get('agents');
    const meter = ctx.get('tokenMeter');
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    if (agent !== undefined && meter !== undefined && typeof meter.contextPressure === 'function') {
      const pressure = meter.contextPressure(agent.session);
      if (pressure !== null && typeof pressure === 'object' && Number.isFinite(pressure.contextWindow)) {
        return pressure.contextWindow;
      }
    }
  } catch {
    // Fall through to the conservative default.
  }
  return 128000;
}

function dshMessage(message, outer) {
  const role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
  let content;
  if (Array.isArray(message.segments) && message.segments.length > 0) {
    content = message.segments
      .filter((seg) => seg && typeof seg.text === 'string' && seg.text !== '')
      .map((seg) => ({
        type: 'text',
        text: seg.text,
        ...(seg.cacheBreakpoint === true ? { cacheControl: { type: 'ephemeral' } } : {}),
      }));
  } else {
    content = [{ type: 'text', text: message.content }];
  }
  if (content.length === 0) content = [{ type: 'text', text: message.content }];
  if (role === 'user' && Array.isArray(message.attachments) && message.attachments.length > 0) {
    for (const att of message.attachments) {
      if (att?.hostRef !== undefined && att.hostRef !== null && typeof att.hostRef === 'object') {
        content.push(att.hostRef);
      } else if (att?.kind === 'image' && typeof att.data === 'string') {
        content.push({ type: 'image', mimeType: att.mimeType ?? 'image/png', data: att.data });
      }
    }
  }
  if (role === 'system') {
    return { id: randomUUID(), role, content, source: { kind: 'system-prompt' } };
  }
  if (role === 'assistant') {
    return {
      id: randomUUID(),
      role,
      content,
      source: { kind: 'model', provider: outer.provider, model: outer.model },
    };
  }
  return { id: randomUUID(), role, content, source: { kind: 'user' } };
}
function mapUsage(usage) {
  const source = usage !== null && typeof usage === 'object' ? usage : {};
  const inputTokens = typeof source.inputTokens === 'number' ? source.inputTokens : 0;
  const outputTokens = typeof source.outputTokens === 'number' ? source.outputTokens : 0;
  const cachedTokens = typeof source.cacheReadTokens === 'number' ? source.cacheReadTokens : 0;
  const cacheWriteTokens = typeof source.cacheWriteTokens === 'number' ? source.cacheWriteTokens : 0;
  const reasoningTokens = typeof source.reasoningTokens === 'number' ? source.reasoningTokens : undefined;
  return {
    // DSH reports uncached input, cache reads, and cache writes separately; engine prompt counts are totals.
    promptTokens: inputTokens + cachedTokens + cacheWriteTokens,
    completionTokens: outputTokens,
    cachedTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

function parseModelSpec(spec, fallback) {
  const trimmed = typeof spec === 'string' ? spec.trim() : '';
  if (trimmed === '') return undefined;
  if (trimmed.includes('/')) {
    const slash = trimmed.indexOf('/');
    return {
      provider: trimmed.slice(0, slash).trim() || fallback.provider,
      model: trimmed.slice(slash + 1).trim() || fallback.model,
    };
  }
  return { provider: fallback.provider, model: trimmed };
}

function resolveTierTarget(outer, settings, tier, fallback = { provider: outer.provider, model: outer.model }) {
  if (tier === 'ROOT') return fallback;
  const settingProvider = tier === 'BRANCH' ? settings?.branchProvider : tier === 'QUERY' ? settings?.queryProvider : '';
  const settingModel = tier === 'BRANCH' ? settings?.branchModel : tier === 'QUERY' ? settings?.queryModel : '';
  if ((settingProvider ?? '') !== '' || (settingModel ?? '') !== '') {
    return {
      provider: (settingProvider ?? '') || fallback.provider,
      model: (settingModel ?? '') || fallback.model,
    };
  }
  const rawProvider = (process.env[`RAF_${tier}_PROVIDER`] ?? '').trim();
  const rawModel = (process.env[`RAF_${tier}_MODEL`] ?? '').trim();
  if (rawProvider === '' && rawModel === '') return fallback;
  if (rawProvider === '' && rawModel.includes('/')) {
    return parseModelSpec(rawModel, fallback) ?? fallback;
  }
  return {
    provider: rawProvider || fallback.provider,
    model: rawModel || fallback.model,
  };
}

async function catalogModels(ctx) {
  const llm = ctx.llm;
  if (llm === undefined || typeof llm.listProviders !== 'function') return [];
  const providers = [];
  const rawProviders = llm.listProviders();
  for (const provider of Array.isArray(rawProviders) ? rawProviders : []) {
    const id = typeof provider?.id === 'string' ? provider.id : '';
    if (id === '') continue;
    const name = typeof provider.name === 'string' && provider.name !== '' ? provider.name : id;
    let rawModels = [];
    try {
      rawModels = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
    } catch {
      rawModels = [];
    }
    const models = [];
    for (const model of Array.isArray(rawModels) ? rawModels : []) {
      const modelId = typeof model?.id === 'string' ? model.id : '';
      if (modelId === '') continue;
      let reasoning;
      try {
        const info = await llm.resolveModelInfo(id, modelId);
        reasoning = info?.reasoning;
      } catch {
        reasoning = undefined;
      }
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts
            .filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
            .map((effort) => ({
              id: effort.id,
              name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
            }))
        : [];
      models.push({
        id: modelId,
        name: typeof model.name === 'string' && model.name !== '' ? model.name : modelId,
        ...(efforts.length > 0
          ? {
              efforts,
              ...(typeof reasoning.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
            }
          : {}),
      });
    }
    providers.push({ id, name, models });
  }
  return providers;
}

/**
 * Wait before a retry without ignoring an abort. The delay is exponential and capped.
 */
function rafRetryDelay(attempt, signal, baseDelayMs = RAF_LLM_RETRY_BASE_DELAY_MS) {
  const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), RAF_LLM_RETRY_MAX_DELAY_MS);
  return new Promise((resolve, reject) => {
    let timer = null;
    const abort = () => {
      if (timer !== null) clearTimeout(timer);
      const reason = signal?.reason;
      reject(reason instanceof Error ? reason : new Error('aborted'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const RAF_RATE_LIMIT_MAX_DELAY_MS = 300_000;
const RAF_RATE_LIMIT_STAGGER_MS = 350;
const RAF_RATE_LIMIT_MAX_SOLO_RETRIES = 8;
const RATE_LIMIT_MESSAGE_RE =
  /(?:\b429\b|rate.?limit|too many requests|\b1302\b|overloaded|temporarily unavailable|速率限制|请求频率|限流)/i;

class PluginRateLimitCoordinator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseDelayMs = options.baseDelayMs ?? RAF_LLM_RATE_LIMIT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? RAF_RATE_LIMIT_MAX_DELAY_MS;
    this.staggerMs = options.staggerMs ?? RAF_RATE_LIMIT_STAGGER_MS;
    this.maxSoloRetries = options.maxSoloRetries ?? RAF_RATE_LIMIT_MAX_SOLO_RETRIES;
    this._activeWorkers = 0;
    this._inFlight = 0;
    this._allowedConcurrency = Number.POSITIVE_INFINITY;
    this._rateLimitUntil = 0;
    this._streak = 0;
    this._nextWakeAt = 0;
    this._drainTimer = undefined;
    this._drainTargetAt = 0;
    this.waitQueue = [];
  }
  get activeWorkers() {
    return this._activeWorkers;
  }
  get inFlight() {
    return this._inFlight;
  }
  get allowedConcurrency() {
    return this._allowedConcurrency;
  }
  get rateLimitUntil() {
    return this._rateLimitUntil;
  }
  get streak() {
    return this._streak;
  }
  enterWorker() {
    this._activeWorkers += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this._activeWorkers = Math.max(0, this._activeWorkers - 1);
    };
  }
  isSolo() {
    return this._activeWorkers <= 1 && this._inFlight <= 1 && this.waitQueue.length === 0;
  }
  shouldTerminateSolo(soloStreak) {
    return this.isSolo() && soloStreak >= this.maxSoloRetries;
  }
  createSoloExhaustedError(soloStreak, lastErrorMessage) {
    const err = new Error(
      `RATE_LIMIT_EXHAUSTED: Provider rate limit persisted after ${soloStreak} solo retries with no parallel contention (${lastErrorMessage})`,
    );
    err.code = 'RATE_LIMIT_EXHAUSTED';
    return err;
  }
  noteRateLimit(retryAfterMs) {
    this._streak += 1;
    this._allowedConcurrency = 1;
    const exponent = Math.min(this._streak - 1, 6);
    const backoff = Math.min(this.baseDelayMs * 2 ** exponent, this.maxDelayMs);
    const baseWait = retryAfterMs !== undefined && retryAfterMs > 0 ? Math.max(backoff, retryAfterMs) : backoff;
    const jitter = Math.floor(Math.random() * Math.min(250, Math.max(1, this.baseDelayMs)));
    const waitMs = Math.min(baseWait + jitter, this.maxDelayMs);
    const now = Date.now();
    this._rateLimitUntil = Math.max(this._rateLimitUntil, now + waitMs);
    this._nextWakeAt = Math.max(this._nextWakeAt, this._rateLimitUntil);
    this.emit('rate:limited', {
      waitMs: this._rateLimitUntil - now,
      streak: this._streak,
      rateLimitUntil: this._rateLimitUntil,
    });
    this.scheduleDrain();
    return { waitMs: this._rateLimitUntil - now, streak: this._streak };
  }
  noteSuccess() {
    const now = Date.now();
    if (now >= this._rateLimitUntil) {
      const wasLimited = this._streak > 0 || this._rateLimitUntil > 0;
      this._streak = 0;
      this._rateLimitUntil = 0;
      if (Number.isFinite(this._allowedConcurrency)) {
        this._allowedConcurrency += 1;
        if (this._allowedConcurrency >= 16 && this.waitQueue.length === 0) {
          this._allowedConcurrency = Number.POSITIVE_INFINITY;
        }
      }
      if (wasLimited) this.emit('rate:resumed', { allowedConcurrency: this._allowedConcurrency });
    }
    this.scheduleDrain();
  }
  reset() {
    this._streak = 0;
    this._rateLimitUntil = 0;
    this._nextWakeAt = 0;
    this._allowedConcurrency = Number.POSITIVE_INFINITY;
    clearTimeout(this._drainTimer);
    this._drainTimer = undefined;
    this._drainTargetAt = 0;
    this.scheduleDrain();
  }
  acquire(signal) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }
    const now = Date.now();
    if (
      this.waitQueue.length === 0 &&
      now >= this._rateLimitUntil &&
      now >= this._nextWakeAt &&
      this._inFlight < this._allowedConcurrency
    ) {
      return Promise.resolve(this.createLease(now));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const idx = this.waitQueue.indexOf(waiter);
        if (idx !== -1) this.waitQueue.splice(idx, 1);
        reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };
      const waiter = { resolve, reject, cleanup };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waitQueue.push(waiter);
      this.scheduleDrain();
    });
  }
  createLease(now) {
    this._inFlight += 1;
    if (this._rateLimitUntil > 0 || Number.isFinite(this._allowedConcurrency) || this.waitQueue.length > 0) {
      this._nextWakeAt = Math.max(this._nextWakeAt, now) + this.staggerMs;
    }
    let released = false;
    return {
      isSolo: () => this.isSolo(),
      release: () => {
        if (released) return;
        released = true;
        this._inFlight = Math.max(0, this._inFlight - 1);
        this.scheduleDrain();
      },
    };
  }
  scheduleDrain() {
    while (this.waitQueue.length > 0 && this._inFlight < this._allowedConcurrency) {
      const now = Date.now();
      const targetAt = Math.max(this._rateLimitUntil, this._nextWakeAt);
      const waitMs = targetAt - now;
      if (waitMs > 0) {
        if (this._drainTimer === undefined || targetAt < this._drainTargetAt) {
          clearTimeout(this._drainTimer);
          this._drainTargetAt = targetAt;
          this._drainTimer = setTimeout(() => {
            this._drainTimer = undefined;
            this._drainTargetAt = 0;
            this.scheduleDrain();
          }, waitMs);
        }
        return;
      }
      const next = this.waitQueue.shift();
      if (!next) break;
      next.cleanup();
      next.resolve(this.createLease(now));
    }
    if (this.waitQueue.length === 0) {
      clearTimeout(this._drainTimer);
      this._drainTimer = undefined;
      this._drainTargetAt = 0;
    }
  }
}

let rateLimitGate = new PluginRateLimitCoordinator();
let rafRateLimitUntil = 0;
let rafRateLimitStreak = 0;

function bindRateLimitGate(nextGate) {
  if (!nextGate || nextGate === rateLimitGate) return;
  rateLimitGate = nextGate;
  rateLimitGate.on('rate:limited', () => {
    rafRateLimitUntil = rateLimitGate.rateLimitUntil;
    rafRateLimitStreak = rateLimitGate.streak;
  });
  rateLimitGate.on('rate:resumed', () => {
    rafRateLimitUntil = rateLimitGate.rateLimitUntil;
    rafRateLimitStreak = rateLimitGate.streak;
  });
}

/** Record one provider rate-limit event and extend the shared wait window. */
function noteRateLimit(retryAfterMs) {
  rateLimitGate.noteRateLimit(retryAfterMs);
  rafRateLimitUntil = rateLimitGate.rateLimitUntil;
  rafRateLimitStreak = rateLimitGate.streak;
}

function resetRateLimit() {
  rateLimitGate.reset();
  rafRateLimitStreak = 0;
  rafRateLimitUntil = 0;
}

class DshLlmClient {
  constructor(ctx, outer, profile, reasoningEffort, target, gate, onRetry) {
    this.ctx = ctx;
    this.outer = outer;
    this.profile = profile;
    this.reasoningEffort = reasoningEffort;
    this.provider = target?.provider ?? outer.provider;
    this.model = target?.model ?? outer.model;
    this.rateLimitGate = gate ?? rateLimitGate;
    this.onRetry = onRetry;
    this.onDelta = undefined;
    /** True when the last completed call needed at least one retry. */
    this.retried = false;
  }

  async complete(request) {
    const signal = request.signal ?? this.outer.signal;
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const started = Date.now();
    const targetOuter = { ...this.outer, provider: this.provider, model: this.model };
    const options = {
      provider: this.provider,
      model: this.model,
      messages: request.messages.map((message) => dshMessage(message, targetOuter)),
      sessionId: this.outer.sessionId,
      // Tag RAF calls so the listener skips them even outside the ALS guard.
      purpose: `raf-${request.purpose ?? 'root'}`,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.maxTokens !== undefined
        ? { maxTokens: request.maxTokens }
        : this.profile.maxOutputTokens !== undefined
          ? { maxTokens: this.profile.maxOutputTokens }
          : {}),
      ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
      ...(signal !== undefined ? { signal } : {}),
    };
    this.retried = false;
    const gate = this.rateLimitGate ?? rateLimitGate;
    let textParts = [];
    let reasoningParts = [];
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let finishKind;
    let failure;
    let soloRateLimitStreak = 0;
    for (let attempt = 0; ; attempt += 1) {
      const lease = await gate.acquire(signal);
      let soloAtAttempt = true;
      try {
        if (attempt > 0) this.retried = true;
        // A retried attempt must not publish reasoning again: the failed attempt already streamed its prefix.
        const publishReasoning = attempt === 0;
        textParts = [];
        reasoningParts = [];
        usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
        finishKind = undefined;
        failure = undefined;
        try {
          await rafInternal.run(true, async () => {
            for await (const chunk of this.ctx.llm.stream(options)) {
              if (chunk === null || typeof chunk !== 'object') continue;
              if (chunk.type === 'text-delta') textParts.push(chunk.text);
              else if (chunk.type === 'reasoning-delta') {
                reasoningParts.push(chunk.text);
                if (publishReasoning && typeof this.onDelta === 'function') this.onDelta(chunk.text);
              } else if (chunk.type === 'usage') usage = chunk.usage;
              else if (chunk.type === 'finish') {
                finishKind = chunk.reason?.kind;
                failure = chunk.reason?.failure;
              }
            }
          });
        } catch (error) {
          finishKind = 'error';
          failure = { message: error instanceof Error ? error.message : String(error) };
        }
        soloAtAttempt = lease.isSolo();
        if (finishKind !== 'error' && finishKind !== 'aborted') {
          gate.noteSuccess();
          rafRateLimitUntil = gate.rateLimitUntil;
          rafRateLimitStreak = gate.streak;
          break;
        }
      } finally {
        lease.release();
      }
      const rawCode = failure?.code;
      const code =
        typeof rawCode === 'string' ? rawCode : typeof rawCode === 'number' ? String(rawCode) : undefined;
      const failureMessage = typeof failure?.message === 'string' ? failure.message : '';
      const rateLimit =
        finishKind !== 'aborted' &&
        signal?.aborted !== true &&
        (code === 'RATE_LIMIT' ||
          code === 'RATE_LIMITED' ||
          code === 'RATE_LIMIT_EXCEEDED' ||
          code === '429' ||
          code === '1302' ||
          RATE_LIMIT_MESSAGE_RE.test(failureMessage));
      if (rateLimit) {
        noteRateLimit();
        if (!soloAtAttempt) {
          soloRateLimitStreak = 0;
          continue;
        }
        soloRateLimitStreak += 1;
        if (gate.shouldTerminateSolo(soloRateLimitStreak)) {
          throw gate.createSoloExhaustedError(
            soloRateLimitStreak,
            failureMessage !== '' ? failureMessage : 'Provider rate limit',
          );
        }
        continue;
      }
      const policyMax = this.ctx.get?.('llm')?.retryPolicy?.maxAttempts;
      const maxRetryAttempts =
        typeof policyMax === 'number' && Number.isFinite(policyMax) && policyMax >= 1
          ? Math.floor(policyMax)
          : RAF_LLM_RETRY_MAX_ATTEMPTS;
      const retryable =
        attempt < maxRetryAttempts - 1 &&
        finishKind !== 'aborted' &&
        signal?.aborted !== true &&
        code !== undefined &&
        RAF_LLM_RETRY_CODES.includes(code);
      if (!retryable) {
        const error = new Error(failureMessage !== '' ? failureMessage : 'LLM request failed');
        if (code !== undefined) error.code = code;
        throw error;
      }
      const delayMs = Math.min(RAF_LLM_RETRY_BASE_DELAY_MS * 2 ** attempt, RAF_LLM_RETRY_MAX_DELAY_MS);
      this.onRetry?.({ attempt: attempt + 1, code, delayMs });
      await rafRetryDelay(attempt + 1, signal);
    }
    return {
      text: textParts.join(''),
      reasoning: reasoningParts.join(''),
      usage: mapUsage(usage),
      model: this.model,
      latencyMs: Date.now() - started,
      ...(finishKind === 'max-tokens' ? { finishReason: 'length' } : {}),
    };
  }
}


function shortText(value, limit) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  if (typeof text !== 'string') return '';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function sanitizeRunEvent(event) {
  switch (event.type) {
    case 'llm_response':
      return {
        ...event,
        text: shortText(event.text, 8000),
        ...(event.reasoning === undefined ? {} : { reasoning: shortText(event.reasoning, 8000) }),
      };
    case 'tool_result':
      return { ...event, observation: shortText(event.observation, 8000) };
    case 'answer':
      return { ...event, answer: shortText(event.answer, 8000) };
    case 'format_error':
      return { ...event, raw: shortText(event.raw, 8000) };
    default:
      return event;
  }
}


const RAF_BUILTIN_TOOL_NAMES = Object.freeze(
  new Set([
    'llm_query',
    'add_document',
    'search',
    'outline',
    'grep',
    'tally',
    'read',
    'list_documents',
    'calculator',
    'branch',
  ]),
);

// Native DSH tools superseded by RAF's ContextStore tools and scoped branch specialists.
const RAF_REPLACED_DSH_TOOLS = Object.freeze(
  new Set([
    'read',
    'grep',
    'subagent',
    'list_subagent_models',
    'list_agents',
    'send_message',
    'interrupt_agent',
    'workflow',
    'ralph',
    'spawn_teammate',
    'wait_agent',
    'team_task_create',
    'team_task_list',
    'team_task_get',
    'team_task_update',
  ]),
);
const PROTOCOL_TAG_TEXT = /<\s*\/?\s*(?:tool_call\|answer|tool_call|answer|folding|folded_output|fold|motivation|explanation|think)\b[^>]*>/gi;
function cleanReasoningText(text, trim = true) {
  const cleaned = text
    .replace(PROTOCOL_TAG_TEXT, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return trim ? cleaned.trim() : cleaned;
}

/** Keep DSH history bounded while the full reasoning stays in the RAF run registry. */
export function capVisibleReasoning(text) {
  if (text.length <= RAF_VISIBLE_REASONING_CHARS) return text;
  const head = Math.floor(RAF_VISIBLE_REASONING_CHARS * 0.65);
  const tail = Math.max(0, RAF_VISIBLE_REASONING_CHARS - head);
  return `${text.slice(0, head)}\n\n…[reasoning shortened for display; full text is in the RAF run details]…\n\n${tail > 0 ? text.slice(-tail) : ''}`;
}

function contentText(blocks) {


  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'image') parts.push('[image]');
    else if (block.type === 'file') {
      const name = block.attachment !== null && typeof block.attachment === 'object' ? block.attachment.name : '';
      parts.push(`[file ${typeof name === 'string' ? name : ''}]`);
    }
  }
  return parts.join('\n').trim();
}

function toolResultText(result) {
  const value = result === null || typeof result !== 'object' ? undefined : result.result;
  if (value === null || typeof value !== 'object') return '';
  let text = contentText(value.content);
  if (value.isError === true) {
    const reason = value.error !== null && typeof value.error === 'object' && typeof value.error.message === 'string' ? value.error.message : 'tool failed';
    return text === '' ? `Tool error: ${reason}` : `Tool error: ${text}`;
  }
  if (text === '' && value.value !== undefined) {
    try {
      text = typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
    } catch {
      text = String(value.value);
    }
  }
  if (value.meta !== null && typeof value.meta === 'object') {
    try {
      const metaStr = JSON.stringify(value.meta);
      if (metaStr !== '{}' && metaStr !== '') text = text === '' ? metaStr : `${text}\n[meta: ${metaStr}]`;
    } catch {
      // Ignore unserializable meta.
    }
  }
  return text;
}

function formatBatchResult(batch) {
  const results = Array.isArray(batch?.results) ? batch.results : [];
  const parts = [];
  for (let i = 0; i < results.length; i++) {
    const res = results[i];
    const text = toolResultText(res);
    if (results.length > 1) {
      parts.push(`[Result ${i + 1}/${results.length}${res?.name ? `: ${res.name}` : ''}]\n${text}`);
    } else if (text !== '') {
      parts.push(text);
    }
  }
  if (Array.isArray(batch?.additionalContexts)) {
    for (const extra of batch.additionalContexts) {
      if (typeof extra === 'string' && extra.trim() !== '') {
        parts.push(extra.trim());
      } else if (extra !== null && typeof extra === 'object') {
        const extraText = Array.isArray(extra.content) ? contentText(extra.content) : typeof extra.text === 'string' ? extra.text : '';
        if (extraText !== '') parts.push(extraText);
      }
    }
  }
  if (batch?.concluded === true) {
    parts.push('[Tool signaled concluded=true]');
  }
  return parts.join('\n\n');
}

function toDocId(prefix, rawLabel, fallbackIndex) {
  const raw = String(rawLabel ?? '');
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9_.\-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned === '') return `${prefix}_${String(fallbackIndex)}`;
  if (cleaned.length <= 96) return `${prefix}_${cleaned}`;
  const hash = createHash('sha256').update(raw).digest('hex').slice(0, 8);
  return `${prefix}_${cleaned.slice(0, 96)}_${hash}`;
}

function normalizeToolArguments(toolName, rawArgs, _motivation, schemaParameters) {
  const base =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const props =
    schemaParameters?.properties !== null && typeof schemaParameters?.properties === 'object'
      ? schemaParameters.properties
      : undefined;
  if (props !== undefined) {
    for (const key of Object.keys(base)) {
      if (key in props) continue;
      const camel = key.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
      const snake = key.replace(/([A-Z])/g, (_, ch) => `_${ch.toLowerCase()}`);
      if (camel !== key && camel in props && base[camel] === undefined) {
        base[camel] = base[key];
        delete base[key];
      } else if (snake !== key && snake in props && base[snake] === undefined) {
        base[snake] = base[key];
        delete base[key];
      }
    }
    for (const [key, val] of Object.entries(base)) {
      const prop = props[key];
      if (!prop || val === undefined || val === null) continue;
      const expectedType = Array.isArray(prop.type) ? prop.type[0] : prop.type;
      if (expectedType === 'string' && typeof val !== 'string' && !Array.isArray(val)) {
        base[key] = String(val);
      } else if ((expectedType === 'number' || expectedType === 'integer') && typeof val === 'string') {
        const trimmed = val.trim();
        if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) base[key] = Number(trimmed);
      } else if (expectedType === 'boolean' && typeof val === 'string') {
        const trimmed = val.trim().toLowerCase();
        if (trimmed === 'true' || trimmed === 'false') base[key] = trimmed === 'true';
      } else if (expectedType === 'array' && typeof val === 'string') {
        base[key] = val
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
    }
  }
  const required = Array.isArray(schemaParameters?.required) ? schemaParameters.required : [];
  const needsDescription =
    required.includes('description') || toolName === 'bash' || toolName === 'run_code';
  if (needsDescription && (typeof base.description !== 'string' || base.description.trim() === '')) {
    const cmdPreview =
      typeof base.command === 'string' && base.command.trim() !== ''
        ? `: ${base.command.replace(/\s+/g, ' ').trim().slice(0, 60)}`
        : '';
    base.description = `Run ${toolName}${cmdPreview}`;
  }
  return base;
}

function buildHostFileSystem(ctx) {
  const dshFs = typeof ctx?.get === 'function' ? ctx.get('fs') : undefined;
  if (dshFs === undefined || dshFs === null || typeof dshFs !== 'object') {
    return {
      stat: (p) => stat(p),
      readFile: (p, encoding) => readFile(p, encoding),
    };
  }
  return {
    stat: (p) => (typeof dshFs.stat === 'function' ? dshFs.stat(p) : stat(p)),
    readFile: (p, encoding) => (typeof dshFs.readFile === 'function' ? dshFs.readFile(p, encoding) : readFile(p, encoding)),
    ...(typeof dshFs.readdir === 'function' ? { readdir: (p, o) => dshFs.readdir(p, o) } : {}),
    ...(typeof dshFs.lstat === 'function' ? { lstat: (p) => dshFs.lstat(p) } : {}),
    ...(typeof dshFs.realpath === 'function' ? { realpath: (p) => dshFs.realpath(p) } : {}),
  };
}

async function indexExternalToolResult(toolName, args, text, store, sessionState, workspace, raf, hostFs) {
  if (toolName === 'read') return text;
  if ((toolName === 'write' || toolName === 'edit') && !text.startsWith('Tool error:')) {
    const rawTarget = args?.file_path ?? args?.path ?? args?.filePath;
    if (typeof rawTarget === 'string' && rawTarget.trim() !== '') {
      try {
        const baseDir = typeof workspace === 'string' && workspace !== '' ? workspace : process.cwd();
        const absPath = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(baseDir, rawTarget);
        const fsImpl = hostFs ?? { stat: (p) => stat(p), readFile: (p, enc) => readFile(p, enc) };
        const s = await fsImpl.stat(absPath).catch(() => undefined);
        const fileText = await fsImpl.readFile(absPath, 'utf8');
        const existing = typeof store.findByAbsPath === 'function' ? store.findByAbsPath(absPath) : undefined;
        const rel = relative(baseDir, absPath);
        const rawDocId = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : rawTarget;
        const docId =
          existing?.id ??
          (typeof raf?.sanitizeDocId === 'function'
            ? raf.sanitizeDocId(rawDocId)
            : toDocId('file', rawDocId, (sessionState?.docs?.size ?? 0) + 1));
        store.add(fileText, {
          id: docId,
          title: String(rawTarget),
          absPath,
          ...(s?.mtimeMs !== undefined ? { mtimeMs: s.mtimeMs } : {}),
          ...(s?.size !== undefined ? { byteSize: s.size } : {}),
        });
        sessionState?.docs?.set(docId, { title: String(rawTarget), text: fileText, persist: false });
      } catch {
        // Non-fatal if file cannot be read after write/edit.
      }
    }
    return text;
  }
  if (toolName !== 'web_fetch' && toolName !== 'web_search') return text;
  if (text.startsWith('Tool error:') || text.length < 1200) return text;
  const rawTarget =
    args?.url ??
    args?.query ??
    args?.path ??
    args?.file_path ??
    `${toolName}_${(sessionState?.docs?.size ?? 0) + 1}`;
  const docPrefix = toolName === 'web_search' ? 'web_search' : 'web';
  const docId = toDocId(docPrefix, rawTarget, (sessionState?.docs?.size ?? 0) + 1);
  const title = String(rawTarget);
  try {
    const doc = store.add(text, { id: docId, title, manifest: false, transient: true });
    sessionState?.docs?.set(docId, { title, text, persist: false });
    return `[Indexed in ContextStore as document "${docId}" (${doc.lines.length} lines, ~${doc.tokens} tokens) — use search, outline, grep, tally, read, branch(scope="${docId}"), or llm_query on "${docId}"]\n${text}`;
  } catch {
    return text;
  }
}

async function createDshTools(ctx, sessionId, outer, signal, sessionState, workspace, raf, hostFs) {
  const agents = ctx.get('agents');
  const tools = ctx.get('tools');
  if (agents === undefined || tools === undefined) return [];
  const agent =
    typeof agents.get === 'function'
      ? agents.get(sessionId)
      : typeof agents.currentInitiator === 'function'
        ? agents.currentInitiator()
        : undefined;
  if (agent === undefined || typeof tools.definitions !== 'function' || typeof tools.execute !== 'function') return [];
  const resolveToolSet = async (stepSignal) => {
    if (typeof tools.resolve !== 'function' || !outer?.provider || !outer?.model) return undefined;
    try {
      return await tools.resolve({
        agent,
        modelSelection: {
          provider: outer.provider,
          model: outer.model,
          ...(outer.reasoningEffort ? { reasoningEffort: outer.reasoningEffort } : {}),
        },
        signal: stepSignal ?? signal ?? new AbortController().signal,
      });
    } catch {
      return undefined;
    }
  };
  const byName = new Map();
  const initToolSet = await resolveToolSet(signal);
  try {
    const withToolSet = initToolSet !== undefined ? tools.definitions(agent, initToolSet) : [];
    if (Array.isArray(withToolSet)) {
      for (const def of withToolSet) {
        if (def && typeof def.name === 'string') byName.set(def.name, def);
      }
    }
    const baseDefs = tools.definitions(agent);
    if (Array.isArray(baseDefs)) {
      for (const def of baseDefs) {
        if (def && typeof def.name === 'string' && !byName.has(def.name)) byName.set(def.name, def);
      }
    }
  } finally {
    if (initToolSet !== undefined && typeof initToolSet.dispose === 'function') {
      await Promise.resolve(initToolSet.dispose()).catch(() => {});
    }
  }
  const extra = [];
  for (const definition of byName.values()) {
    if (definition === null || typeof definition !== 'object') continue;
    if (typeof definition.name !== 'string' || typeof definition.execute !== 'function') continue;
    if (definition.deferLoading === true) continue;
    // RAF's own tools are registered natively; every other visible DSH tool is bridged.
    if (definition.name.startsWith('raf_') || definition.name.startsWith('ref_')) continue;
    if (RAF_BUILTIN_TOOL_NAMES.has(definition.name)) continue;
    if (RAF_REPLACED_DSH_TOOLS.has(definition.name)) continue;
    extra.push({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (args, toolCtx) => {
        let stepToolSet;
        try {
          const normalizedArgs = normalizeToolArguments(definition.name, args, '', definition.parameters);
          stepToolSet = await resolveToolSet(toolCtx.signal ?? signal);
          const runBatch = () =>
            tools.execute({
              calls: [
                {
                  type: 'tool-call',
                  id: randomUUID(),
                  name: definition.name,
                  arguments: JSON.stringify(normalizedArgs),
                },
              ],
              signal: toolCtx.signal ?? signal,
              agent,
              ...(stepToolSet !== undefined ? { toolSet: stepToolSet } : {}),
            });
          let batch =
            typeof agents.withInitiator === 'function' ? await agents.withInitiator(agent, runBatch) : await runBatch();
          const firstText = toolResultText(Array.isArray(batch?.results) ? batch.results[0] : undefined);
          if (PTC_LOCKOUT_RE.test(firstText) && typeof definition.execute === 'function') {
            const directCall = () =>
              definition.execute(normalizedArgs, { agent, signal: toolCtx.signal ?? signal });
            const directVal =
              typeof agents.withInitiator === 'function'
                ? await agents.withInitiator(agent, directCall)
                : await directCall();
            const directText = typeof directVal === 'string' ? directVal : JSON.stringify(directVal ?? '');
            batch = { results: [{ name: definition.name, result: { isError: false, content: [{ type: 'text', text: directText }] } }] };
          }
          const text = formatBatchResult(batch);
          return await indexExternalToolResult(
            definition.name,
            normalizedArgs,
            text,
            toolCtx.store,
            sessionState,
            workspace,
            raf,
            hostFs,
          );
        } catch (error) {
          return `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        } finally {
          if (stepToolSet !== undefined && typeof stepToolSet.dispose === 'function') {
            await Promise.resolve(stepToolSet.dispose()).catch(() => {});
          }
        }
      },
    });
  }
  return extra;
}

/**
 * Last-resort answer: keep the successful specialist reports when the root
 * cannot produce a final answer. This is deliberately read-only.
 */
export function buildFallbackAnswer(turn) {
  if (turn === undefined || turn.engine === undefined) return undefined;
  const sections = [];
  const seen = new Set();
  try {
    for (const entry of turn.engine.board.entries()) {
      if (entry.kind !== 'branch' || entry.inProgress === true) continue;
      if (entry.summary.includes(': failed —')) continue;
      const scope = entry.scope || entry.key;
      if (seen.has(scope)) continue;
      seen.add(scope);
      const body = entry.summary.length > 2_000 ? `${entry.summary.slice(0, 2_000)}…` : entry.summary;
      sections.push(`## ${scope}\n${body}`);
    }
  } catch {
    // Board is optional for the fallback.
  }
  try {
    for (const doc of turn.store.list()) {
      if (!doc.id.startsWith(BRANCH_REPORT_ID_PREFIX) || seen.has(doc.id)) continue;
      const titleScope = typeof doc.title === 'string' ? doc.title.replace(/^branch report:\s*/i, '').trim() : '';
      if (titleScope !== '' && seen.has(titleScope)) continue;
      const body = doc.lines.join('\n');
      if (body.trim() === '') continue;
      seen.add(doc.id);
      if (titleScope !== '') seen.add(titleScope);
      sections.push(`## ${doc.title}\n${body.length > 2_000 ? `${body.slice(0, 2_000)}…` : body}`);
    }
  } catch {
    // Store is optional for the fallback.
  }
  const errorText = typeof turn.lastResultError === 'string' ? turn.lastResultError : '';
  if (sections.length === 0 && errorText === '') return undefined;
  const gap = errorText !== '' ? `\n\n## Uncovered Scopes & Errors\n${errorText}` : '';
  const body = sections.length > 0 ? sections.join('\n\n') : 'No completed branch reports were saved.';
  return `# Final Report (Saved Branch Results)\n\nRoot did not produce a final answer; saved audit reports are listed below.\n\n${body}${gap}`;
}

function createRunRegistry() {
  const runs = new Map();
  const trim = () => {
    while (runs.size > MAX_RUNS) {
      const oldest = runs.keys().next().value;
      if (oldest === undefined) break;
      runs.delete(oldest);
    }
  };
  const summary = (run) => ({
    id: run.id,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    status: run.status,
    termination: run.termination,
    model: run.model,
    question: run.question,
    settings: run.settings,
    answerPreview: typeof run.answer === 'string' ? run.answer.slice(0, 200) : '',
    usage: run.usage,
    agentCount: run.agentCount,
    stepCount: run.stepCount,
    eventCount: run.events.length,
    error: run.error,
  });
  return {
    create(input) {
      const run = {
        id: randomUUID(),
        ...input,
        startedAt: Date.now(),
        endedAt: null,
        status: 'running',
        termination: null,
        events: [],
        usage: null,
        answer: '',
        error: null,
        agentCount: 0,
        stepCount: 0,
      };
      runs.set(run.id, run);
      trim();
      return run;
    },
    append(run, event) {
      if (run === undefined) return;
      if (run.events.length >= MAX_RUN_EVENTS) return;
      const entry = { seq: run.events.length + 1, at: Date.now(), event: sanitizeRunEvent(event) };
      run.events.push(entry);
      if (event.type === 'run_start') run.agentCount += 1;
      if (event.type === 'step_start') run.stepCount += 1;
    },
    finish(run, patch) {
      if (run === undefined) return;
      Object.assign(run, patch);
      if (run.endedAt === null) run.endedAt = Date.now();
    },
    list(sessionId) {
      return [...runs.values()]
        .filter((run) => sessionId === undefined || run.sessionId === sessionId)
        .sort((left, right) => right.startedAt - left.startedAt)
        .map(summary);
    },
    get(id) {
      return runs.get(id);
    },
  };
}

function getLiveSession(ctx, sessionId) {
  try {
    const agents = ctx.get('agents');
    const agent = agents !== undefined && typeof agents.get === 'function' ? agents.get(sessionId) : undefined;
    const session = agent?.session;
    return session !== undefined && typeof session.append === 'function' ? session : undefined;
  } catch {
    return undefined;
  }
}

function sessionPosition(session, ctx) {
  try {
    const boundary = ctx?.get?.('agents')?.turnBoundaryOf?.(session);
    if (boundary && typeof boundary.turn === 'number') {
      return { turn: boundary.turn, step: typeof boundary.step === 'number' ? boundary.step : 0 };
    }
  } catch {
    // Fall through to event log inspection.
  }
  const log = Array.isArray(session?.log)
    ? session.log
    : typeof session?.snapshotEvents === 'function'
      ? session.snapshotEvents()
      : [];
  let turn = 1;
  let step = 0;
  if (Array.isArray(log)) {
    for (const event of log) {
      if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn;
      if (event?.type === 'step/start') {
        if (typeof event.data?.turn === 'number') turn = event.data.turn;
        if (typeof event.data?.step === 'number') step = event.data.step;
      }
    }
  }
  return { turn, step };
}

const activeTurns = new Map();
const MAX_ACTIVE_TURNS = 100;

function latestHumanMessage(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'user' && message.source !== null && typeof message.source === 'object' && message.source.kind === 'user') {
      return message;
    }
  }
  return undefined;
}

function toolResultFor(messages, callId) {
  if (!Array.isArray(messages) || typeof callId !== 'string') return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || message.role !== 'tool') continue;
    if (message.toolCallId !== callId && message.source?.callId !== callId) continue;
    return { text: contentText(message.content), isError: message.isError === true };
  }
  return undefined;
}

function stepUsageChunk(usage) {
  const cached = usage.cachedTokens > usage.promptTokens ? usage.promptTokens : usage.cachedTokens;
  return {
    type: 'usage',
    usage: {
      inputTokens: Math.max(0, usage.promptTokens - cached),
      outputTokens: usage.completionTokens,
      cacheReadTokens: cached,
      totalTokens: usage.promptTokens + usage.completionTokens,
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    },
  };
}

function runUsageOf(result) {
  const total = result.usage.total();
  const byRole = result.usage.byRole();
  return {
    input: total.promptTokens,
    output: total.completionTokens,
    cached: total.cachedTokens,
    cacheHitRate: total.cacheHitRate,
    rootCacheHitRate: byRole.root?.cacheHitRate ?? 0,
    branchCacheHitRate: byRole.branch?.cacheHitRate ?? 0,
    latencyMs: total.latencyMs,
    calls: total.calls,
    errors: total.errors,
  };
}

async function finishRun(turn, result, signal) {
  const failed = result.terminated === 'error' || typeof result.answer !== 'string' || result.answer === '';
  const status = signal?.aborted ? 'aborted' : failed ? 'error' : 'done';
  if (result?.state !== undefined && turn.sessionState !== undefined) {
    turn.sessionState.rootState = result.state;
  }
  if (turn.sessionState !== undefined) {
    turn.sessionState.turnStatus = status;
    turn.sessionState.pending = undefined;
  }
  captureNewDocs(turn);
  markSessionStateDirty(turn.sessionState);
  await flushSessionState(turn.sessionState);
  if (turn.run === undefined) return;
  turn.finish({
    status,
    termination: result.terminated,
    answer: typeof result.answer === 'string' ? result.answer : '',
    error: result.error ?? null,
    usage: runUsageOf(result),
  });
  turn.run = undefined;
}

/**
 * Convert an engine failure into a failed step. A text answer would hide the failure.
 */
function errorStream(message) {
  return [
    {
      type: 'finish',
      reason: { kind: 'error', failure: { message: `RAF engine error: ${message}`, code: 'ERROR' } },
    },
  ];
}

function abortedStream() {
  return [{ type: 'finish', reason: { kind: 'aborted' } }];
}

/**
 * Register RAF tool schemas as native DSH tools. The native loop executes the
 * call; the engine receives the observation through the next step's submit().
 */
function isRafScope(scope, state) {
  if (scope === null || typeof scope !== 'object') return false;
  const sessionId = scope.session?.id ?? scope.id;
  return typeof sessionId === 'string' && (engineOf(state, sessionId) === ENGINE_RAF || activeTurns.has(sessionId));
}

function registerRafTools(toolsCtx, raf, state) {
  const templateLlm = {
    profile: { name: 'raf-native-tools', contextWindow: 128_000, maxOutputTokens: 1024 },
    async complete() {
      throw new Error('RAF native tool template has no model');
    },
  };
  const template = new raf.RecursiveAgentFold({
    rootLLM: templateLlm,
    queryLLM: templateLlm,
    store: new raf.ContextStore(),
    documentTools: {
      maxReadLines: 250,
      maxReadTokens: 6000,
      maxGrepMatches: 100,
    },
    maxDepth: DEPTH_MAX,
  });
  const disposers = [];
  const perAgentDefinitions = [];
  const agentOverrideDisposers = new WeakMap();
  const trackedAgents = new Set();
  function syncAgentOverrides(agent) {
    if (agent === null || typeof agent !== 'object') return;
    const sessionId = agent.session?.id ?? agent.id;
    const isRaf = typeof sessionId === 'string' && engineOf(state, sessionId) === ENGINE_RAF;
    const existing = agentOverrideDisposers.get(agent);
    if (!isRaf) {
      if (existing !== undefined) {
        for (const dispose of existing) {
          try {
            dispose();
          } catch {
            // Ignore teardown errors.
          }
        }
        agentOverrideDisposers.delete(agent);
      }
      trackedAgents.delete(agent);
      return;
    }
    if (existing !== undefined) return;
    const scopedTools = agent.ctx?.tools ?? agent.ctx?.get?.('tools');
    if (scopedTools === undefined || typeof scopedTools.register !== 'function') return;
    const agentDisposers = [];
    for (const definition of perAgentDefinitions) {
      try {
        agentDisposers.push(scopedTools.register(definition));
      } catch {
        // Ignore if already registered in this agent scope.
      }
    }
    if (agentDisposers.length > 0) {
      agentOverrideDisposers.set(agent, agentDisposers);
      trackedAgents.add(agent);
    }
  }

  function syncAllAgents() {
    try {
      const agents = typeof toolsCtx.get === 'function' ? toolsCtx.get('agents') : undefined;
      const list = typeof agents?.list === 'function' ? agents.list() : [];
      if (Array.isArray(list)) {
        for (const agent of list) syncAgentOverrides(agent);
      }
    } catch {
      // Ignore if agents service is not ready.
    }
  }

  try {
    const whenRaf = ({ agent }) => {
      const sessionId = agent?.session?.id ?? agent?.id;
      return typeof sessionId === 'string' && engineOf(state, sessionId) === ENGINE_RAF;
    };
    for (const tool of template.toolsFor(0)) {
      const definition = {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? { type: 'object' },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value) }],
        },
        async execute(args, exec) {
          const agent = exec?.agent;
          const sessionId = agent?.session?.id ?? agent?.id;
          const turn = typeof sessionId === 'string' ? activeTurns.get(sessionId) : undefined;
          if (turn === undefined) throw new Error(`RAF turn is not active for ${tool.name}`);
          const live = turn.tools.get(tool.name) ?? turn.tools.get(tool.name.replace(/^(?:raf|ref)_/, ''));
          if (live === undefined) throw new Error(`RAF tool ${tool.name} is not available`);
          const observation = await live.execute(args ?? {}, {
            store: turn.store,
            usage: turn.engine.usage,
            depth: 0,
            agentName: 'root',
            step: turn.step,
            emit: turn.emit,
            signal: exec?.signal ?? turn.signal,
            board: turn.engine.board,
            ancestorTasks: [turn.question],
          });
          const callIds = turn.pendingCallIds ?? [];
          const callIdx = exec?.callId ? callIds.indexOf(exec.callId) : -1;
          if (callIdx >= 0 && Array.isArray(turn.pendingObservations)) {
            turn.pendingObservations[callIdx] = observation;
          } else if (Array.isArray(turn.pendingObservations)) {
            const matchIdx = (turn.pendingActions ?? []).findIndex(
              (a, i) => a?.name === tool.name && turn.pendingObservations[i] === undefined,
            );
            if (matchIdx >= 0) turn.pendingObservations[matchIdx] = observation;
          }
          turn.pendingObservation = observation;
          if (turn.sessionState.pending !== undefined) {
            captureNewDocs(turn);
            markSessionStateDirty(turn.sessionState);
          }
          return observation;
        },
      };
      if (RAF_REPLACED_DSH_TOOLS.has(tool.name)) {
        perAgentDefinitions.push(definition);
      }
      try {
        const disp = toolsCtx.tools.register(definition, { when: whenRaf });
        if (typeof disp === 'function') disposers.push(disp);
      } catch {
        if (!perAgentDefinitions.includes(definition)) {
          perAgentDefinitions.push(definition);
        }
      }
    }
    syncAllAgents();
    if (typeof toolsCtx.on === 'function') {
      const offCreated = toolsCtx.on('agent/created', (ev) => {
        cloneSeededSessionState(ev?.agent, raf);
        syncAgentOverrides(ev?.agent);
      });
      if (typeof offCreated === 'function') disposers.push(offCreated);
      const offClaimed = toolsCtx.on('agent/inbox/claimed', (ev) => syncAgentOverrides(ev?.agent));
      if (typeof offClaimed === 'function') disposers.push(offClaimed);
    }
  } catch (error) {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Ignore partial teardown failures.
      }
    }
    throw error;
  }
  const teardown = () => {
    for (const agent of trackedAgents) {
      const list = agentOverrideDisposers.get(agent);
      if (list !== undefined) {
        for (const dispose of list) {
          try {
            dispose();
          } catch {
            // Ignore teardown failures.
          }
        }
        agentOverrideDisposers.delete(agent);
      }
    }
    trackedAgents.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // Ignore teardown failures.
      }
    }
  };
  teardown.syncAllAgents = syncAllAgents;
  return teardown;
}

const sessionStates = new Map();

function atomicWriteFileSync(path, content, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error;
  }
}

async function atomicWriteFile(path, content, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode, flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      // Best-effort cleanup of temp file.
    }
    throw error;
  }
}

class SessionCommitBus extends EventEmitter {
  constructor(sessionState) {
    super();
    this.sessionState = sessionState;
    this._seq = 0;
    this._chain = Promise.resolve();
  }

  enqueueCommit(fn) {
    const run = async () => {
      await fn();
    };
    const next = this._chain.then(run, run);
    this._chain = next.catch(() => {});
    return next;
  }

  recordEvent(turn, event) {
    const seq = ++this._seq;
    this.emit('event', { seq, event });
    if (
      event?.type === 'branch_report' ||
      event?.type === 'fold' ||
      event?.type === 'tool_result' ||
      event?.type === 'answer'
    ) {
      captureNewDocs(turn);
      if (event.type === 'fold' && event.agent === 'root' && event.outcome?.directive) {
        const [from, to] = event.outcome.directive.range ?? [0, 0];
        const foldLine = `[Fold ${from}-${to}] ${event.outcome.directive.summary}`;
        if (Array.isArray(turn?.stepFolds)) turn.stepFolds.push(foldLine);
        if (typeof turn?.appendCustom === 'function') {
          turn.appendCustom('raf-fold', { range: [from, to], summary: event.outcome.directive.summary });
        }
      }
      if (
        event.type === 'branch_report' ||
        (event.agent === 'root' && (event.type === 'fold' || event.type === 'answer'))
      ) {
        void this.enqueueCommit(async () => {
          if (turn?.engine) {
            turn.sessionState.rootState = turn.engine.snapshot();
          }
          markSessionStateDirty(turn.sessionState);
          await flushSessionState(turn.sessionState);
        });
      }
    }
  }
}

function cloneSeededSessionState(agent, raf) {
  if (agent === null || typeof agent !== 'object') return;
  const isSeeded = agent.meta?.isSeeded === true || agent.session?.header?.isSeeded === true;
  if (!isSeeded) return;
  const childId = agent.session?.id ?? agent.id;
  const parentId = agent.meta?.parentSessionId ?? agent.meta?.seedSessionId ?? agent.session?.header?.parentId;
  if (typeof childId !== 'string' || childId === '' || typeof parentId !== 'string' || parentId === '') return;
  const parent = sessionStates.get(parentId);
  if (!parent) return;
  const child = getSessionState(childId, raf);
  if (parent.rootState !== undefined) {
    child.rootState = JSON.parse(JSON.stringify(parent.rootState));
  }
  try {
    child.board = raf.ResearchBoard.restore(parent.board.snapshot());
  } catch {
    child.board = new raf.ResearchBoard();
  }
  child.docs.clear();
  for (const [k, v] of parent.docs.entries()) {
    child.docs.set(k, { ...v });
  }
  child.initialQuestion = parent.initialQuestion;
  child.initialManifest = parent.initialManifest;
  child.initialDocIds = parent.initialDocIds ? new Set(parent.initialDocIds) : undefined;
  for (const src of parent.sources) child.sources.add(src);
  child.loaded = true;
  markSessionStateDirty(child);
}
function getSessionState(sessionId, raf) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default';
  let state = sessionStates.get(key);
  if (!state) {
    if (sessionStates.size >= 100) {
      const oldestKey = sessionStates.keys().next().value;
      if (oldestKey !== undefined) sessionStates.delete(oldestKey);
    }
    state = {
      sessionId: key,
      memo: new Map(),
      chunkCounts: new Map(),
      board: new raf.ResearchBoard(),
      docs: new Map(),
      sources: new Set(),
      workspaceIngested: false,
      loaded: false,
      rootState: undefined,
      initialQuestion: undefined,
      initialManifest: undefined,
      initialDocIds: undefined,
      turnStatus: undefined,
      pending: undefined,
      commitBus: undefined,
      dirty: false,
    };
    state.commitBus = new SessionCommitBus(state);
  } else if (!state.commitBus) {
    state.commitBus = new SessionCommitBus(state);
  }
  return state;
}

function sessionStatePath(sessionId) {
  const safe = String(sessionId).replace(/[^A-Za-z0-9_.-]+/g, '_');
  return join(dirname(statePath()), 'sessions', `${safe}.json`);
}

function captureNewDocs(turn) {
  if (turn === undefined || turn.sessionState === undefined || turn.store === undefined) return;
  for (const doc of turn.store.list()) {
    if (typeof doc?.id !== 'string' || !doc.id.startsWith(BRANCH_REPORT_ID_PREFIX)) continue;
    if (turn.sessionState.docs.has(doc.id)) continue;
    turn.sessionState.docs.set(doc.id, { title: doc.title ?? doc.id, text: doc.lines.join('\n'), persist: true });
  }
}

function buildSessionSnapshotJson(state) {
  const docs = Object.create(null);
  let docChars = 0;
  let docCount = 0;
  let skippedDocs = 0;
  const ordered = [...state.docs.entries()].sort(([left], [right]) => {
    const leftReport = left.startsWith(BRANCH_REPORT_ID_PREFIX) ? 0 : 1;
    const rightReport = right.startsWith(BRANCH_REPORT_ID_PREFIX) ? 0 : 1;
    return leftReport - rightReport;
  });
  for (const [id, doc] of ordered) {
    if (!doc || doc.persist === false) continue;
    if (typeof doc.title !== 'string' || typeof doc.text !== 'string') continue;
    if (docCount >= RAF_STATE_MAX_DOCS || docChars + doc.text.length > RAF_STATE_MAX_DOC_CHARS) {
      skippedDocs += 1;
      continue;
    }
    docs[id] = { title: doc.title, text: doc.text };
    docChars += doc.text.length;
    docCount += 1;
  }
  let boardSnapshot;
  try {
    boardSnapshot = state.board?.snapshot?.();
  } catch {
    boardSnapshot = undefined;
  }
  return JSON.stringify({
    version: 2,
    sessionId: state.sessionId,
    updatedAt: Date.now(),
    ...(state.rootState !== undefined ? { rootState: state.rootState } : {}),
    ...(state.initialQuestion !== undefined ? { initialQuestion: state.initialQuestion } : {}),
    ...(state.initialManifest !== undefined ? { initialManifest: state.initialManifest } : {}),
    ...(state.initialDocIds !== undefined ? { initialDocIds: [...state.initialDocIds] } : {}),
    ...(state.turnStatus !== undefined ? { turnStatus: state.turnStatus } : {}),
    ...(state.pending !== undefined ? { pending: state.pending } : {}),
    ...(boardSnapshot !== undefined ? { board: boardSnapshot } : {}),
    docs,
    ...(skippedDocs > 0 ? { skippedDocs } : {}),
  });
}

function markSessionStateDirty(state) {
  if (state !== undefined) state.dirty = true;
}

async function flushSessionState(state) {
  if (state === undefined || !state.dirty || typeof state.sessionId !== 'string' || state.sessionId === '') return;
  state.dirty = false;
  try {
    await atomicWriteFile(sessionStatePath(state.sessionId), buildSessionSnapshotJson(state), 0o600);
  } catch (error) {
    state.dirty = true;
    console.error('RAF: cannot persist session state', error);
  }
}

function persistSessionState(state) {
  if (state === undefined || typeof state.sessionId !== 'string' || state.sessionId === '') return;
  state.dirty = false;
  try {
    atomicWriteFileSync(sessionStatePath(state.sessionId), buildSessionSnapshotJson(state), 0o600);
  } catch (error) {
    console.error('RAF: cannot persist session state', error);
  }
}

async function loadSessionState(sessionId, raf) {
  const state = getSessionState(sessionId, raf);
  if (state.loaded) return;
  state.loaded = true;
  try {
    const parsed = JSON.parse(await readFile(sessionStatePath(sessionId), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || parsed.sessionId !== state.sessionId) return;
    if (parsed.version !== 1 && parsed.version !== 2) return;
    if (parsed.rootState !== null && typeof parsed.rootState === 'object' && Array.isArray(parsed.rootState.blocks)) {
      state.rootState = parsed.rootState;
    }
    if (typeof parsed.initialQuestion === 'string' && parsed.initialQuestion !== '') {
      state.initialQuestion = parsed.initialQuestion;
    }
    if (typeof parsed.initialManifest === 'string') {
      state.initialManifest = parsed.initialManifest;
    }
    if (Array.isArray(parsed.initialDocIds)) {
      state.initialDocIds = new Set(parsed.initialDocIds.filter((id) => typeof id === 'string'));
    }
    if (parsed.turnStatus === 'done' || parsed.turnStatus === 'aborted' || parsed.turnStatus === 'error') {
      state.turnStatus = parsed.turnStatus;
    }
    if (parsed.board !== null && typeof parsed.board === 'object') {
      try {
        state.board = raf.ResearchBoard.restore(parsed.board);
      } catch {
        state.board = new raf.ResearchBoard();
      }
    }
    if (parsed.docs !== null && typeof parsed.docs === 'object') {
      for (const [id, doc] of Object.entries(parsed.docs)) {
        if (typeof id !== 'string' || doc === null || typeof doc !== 'object') continue;
        if (typeof doc.title !== 'string' || typeof doc.text !== 'string') continue;
        state.docs.set(id, { title: doc.title, text: doc.text, persist: true });
      }
    }
    const pending = parsed.pending;
    if (
      pending !== null &&
      typeof pending === 'object' &&
      typeof pending.callId === 'string' &&
      pending.callId !== '' &&
      Number.isInteger(pending.step) &&
      pending.step >= 0 &&
      typeof pending.motivation === 'string' &&
      pending.action !== null &&
      typeof pending.action === 'object' &&
      typeof pending.action.name === 'string' &&
      pending.action.name !== '' &&
      pending.action.arguments !== null &&
      typeof pending.action.arguments === 'object' &&
      !Array.isArray(pending.action.arguments) &&
      (pending.observation === undefined || typeof pending.observation === 'string')
    ) {
      const validActions = Array.isArray(pending.actions) && pending.actions.length > 0 ? pending.actions : [pending.action];
      const validCallIds = Array.isArray(pending.callIds) && pending.callIds.length > 0 ? pending.callIds : [pending.callId];
      state.pending = {
        callId: pending.callId,
        callIds: validCallIds,
        step: pending.step,
        motivation: pending.motivation,
        action: { name: pending.action.name, arguments: pending.action.arguments },
        actions: validActions,
        ...(pending.observation !== undefined ? { observation: pending.observation } : {}),
        ...(Array.isArray(pending.observations) ? { observations: pending.observations } : {}),
      };
    }
    // A persisted manifest can reference a document that the size cap skipped.
    state.initialManifest = undefined;
    state.initialDocIds = undefined;
  } catch {
    // Missing or corrupt state is not fatal. Start this session fresh.
  }
}

function latestCheckpointText(messages) {
  if (!Array.isArray(messages)) return '';
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue;
    if (message.source?.kind !== 'compact-checkpoint') continue;
    const text = renderContent(message.content).trim();
    if (text !== '') return text;
  }
  return '';
}

function sameTurn(turn, position, human, messages) {
  if (turn === undefined || turn.finished) return false;
  const callIds = Array.isArray(turn.pendingCallIds) && turn.pendingCallIds.length > 0
    ? turn.pendingCallIds
    : turn.pendingCallId !== undefined
      ? [turn.pendingCallId]
      : [];
  if (callIds.length === 0) return false;
  if (human?.id !== undefined && turn.userMessageId !== undefined && human.id !== turn.userMessageId) return false;
  if (position !== undefined && turn.nativeTurn !== undefined && turn.nativeTurn !== position.turn) return false;
  return callIds.some((cid, idx) => toolResultFor(messages, cid) !== undefined || turn.pendingObservations?.[idx] !== undefined) || turn.pendingObservation !== undefined;
}

function workspaceOf(ctx, session) {
  try {
    const workingDirectory = ctx.get('workingDirectory');
    if (session !== undefined && workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      const current = workingDirectory.get(session);
      if (typeof current === 'string' && current !== '') return current;
    }
  } catch {
    // Fall back to the original Session project.
  }
  if (session !== undefined && typeof session.header?.cwd === 'string' && session.header.cwd !== '') return session.header.cwd;
  return process.cwd();
}

const STUDY_INTENT =
  /(?:\b(?:study|explore|investigate|research|deep[- ]?dive|thorough(?:ly)?|deep(?:ly)?)\b|изучи|изуча|исследуй|глубок|досконал|досканал)/iu;
const PROJECT_INTENT =
  /(?:\b(?:project|repo(?:sitory)?|codebase|workspace)\b|проект|репозитор|воркспейс)/iu;
const STUDY_SCOPE_ROOTS = Object.freeze(['docs', 'results', 'scripts']);

function studyScopes(store) {
  const scopes = new Set();
  for (const doc of store.list()) {
    const id = typeof doc?.id === 'string' ? doc.id : '';
    if (id === '' || id === 'session') continue;
    const parts = id.split('/');
    const head = parts[0] ?? '';
    if (head === 'packages' && parts.length > 2 && typeof parts[1] === 'string') {
      scopes.add(`packages/${parts[1]}`);
    } else if (STUDY_SCOPE_ROOTS.includes(head)) {
      scopes.add(head);
    }
  }
  return [...scopes].sort().slice(0, 6);
}

function studyBrief(question, store) {
  if (!STUDY_INTENT.test(question) || !PROJECT_INTENT.test(question)) return '';
  const scopes = studyScopes(store);
  if (scopes.length < 2) return '';
  const tasks = scopes
    .map(
      (scope) =>
        `{"scope":${JSON.stringify(scope)},"task":"Deeply study ${scope}: purpose, key components, exact file paths and line references, tests/benchmarks/results, and risks."}`,
    )
    .join(', ');
  return `\n\n### Deep-study protocol (repository-wide)\nThis is a deep study of the repository, not a docs-only summary. Cover implementation, tests, benchmarks/results, docs, and risks.\nIf the branch tool is available, you MUST delegate each independent scope to a specialist now: branch(tasks=[${tasks}]). Synthesize their reports in the final answer.\nFor each scope, use outline/search/grep/tally for exact code and facts; use llm_query for long documents that need semantic scanning; use read only for targeted verification windows. Do not read every file serially in root.\nFinal answer: purpose, architecture/mechanism, implementation with paths/lines, tests/benchmarks/results, risks.`;
}

async function ensureTurn(ctx, outer, settings, runs, raf) {

  const session = getLiveSession(ctx, outer.sessionId);
  const position = session === undefined ? undefined : sessionPosition(session, ctx);
  const workspace = workspaceOf(ctx, session);
  const messages = Array.isArray(outer.messages) ? outer.messages : [];
  const human = latestHumanMessage(messages);
  const existing = activeTurns.get(outer.sessionId);
  if (sameTurn(existing, position, human, messages)) return existing;
  if (existing !== undefined) {
    existing.finish({ status: 'aborted', termination: 'error', answer: '', error: 'Turn superseded before completion', usage: null });
    existing.run = undefined;
    activeTurns.delete(outer.sessionId);
  }

  const userIndex = latestUserIndex(messages);
  const question = questionOf(messages, userIndex);
  let effectiveQuestion = question === '' ? 'Answer the latest request.' : question;
  const contextMessages = userIndex < 0 ? messages : messages.filter((_message, index) => index !== userIndex);
  await loadSessionState(outer.sessionId, raf);
  const sessionState = getSessionState(outer.sessionId, raf);
  if (sessionState.turnStatus === 'done') {
    if (contextMessages.length === 0) {
      sessionState.rootState = undefined;
      sessionState.initialQuestion = undefined;
      sessionState.initialManifest = undefined;
      sessionState.initialDocIds = undefined;
      for (const docId of [...sessionState.docs.keys()]) {
        if (docId.startsWith(BRANCH_REPORT_ID_PREFIX)) sessionState.docs.delete(docId);
      }
      sessionState.memo.clear();
      sessionState.chunkCounts.clear();
      sessionState.sources.clear();
      sessionState.workspaceIngested = false;
      sessionState.board = new raf.ResearchBoard();
    }
    sessionState.pending = undefined;
    sessionState.turnStatus = undefined;
  }
  if (sessionState.rootState === undefined) {
    const checkpoint = latestCheckpointText(contextMessages);
    if (checkpoint !== '') {
      effectiveQuestion += `\n\n### Prior context (compacted)\n${checkpoint}\n\nContinue from this prior state without redoing completed work.`;
    }
  }
  const store = new raf.ContextStore();
  if (sessionState.rootState === undefined) {
    const transcript = renderTranscript(contextMessages);
    if (transcript !== '') store.add(transcript, { id: 'session', title: 'DSH session transcript' });
  }
  for (const [docId, docEntry] of sessionState.docs.entries()) {
    if (docId !== 'session' && typeof docEntry?.text === 'string' && docEntry.text !== '') {
      try {
        store.add(docEntry.text, {
          id: docId,
          title: docEntry.title ?? docId,
          manifest: !docId.startsWith(BRANCH_REPORT_ID_PREFIX),
        });
      } catch {
        // Corrupt or externally generated state must not abort the turn.
        sessionState.docs.delete(docId);
      }
    }
  }
  const contextWindow = contextWindowOf(ctx, outer.sessionId, outer);
  const rootTarget = { provider: outer.provider, model: outer.model };
  const branchTarget = resolveTierTarget(outer, settings, 'BRANCH', rootTarget);
  const queryTarget = resolveTierTarget(outer, settings, 'QUERY', rootTarget);
  const branchEffort =
    typeof settings.branchReasoningEffort === 'string' && settings.branchReasoningEffort !== ''
      ? settings.branchReasoningEffort
      : undefined;
  const branchConfigured =
    (settings.branchProvider ?? '') !== '' || (settings.branchModel ?? '') !== '' || branchEffort !== undefined;
  const rootProfile = { name: rootTarget.model, contextWindow, maxOutputTokens: RAF_ROOT_MAX_OUTPUT };
  const branchProfile = { name: branchTarget.model, contextWindow, maxOutputTokens: RAF_ROOT_MAX_OUTPUT };
  const queryProfile = { name: queryTarget.model, contextWindow, maxOutputTokens: RAF_QUERY_MAX_OUTPUT };
  const activeGate = raf.defaultRateLimitGate ?? rateLimitGate;
  const hostFs = buildHostFileSystem(ctx);
  const hostAddendum = extractHostAddendum(outer, messages);
  const userMessage = userIndex >= 0 ? messages[userIndex] : undefined;
  const initialAttachments = extractMessageAttachments(userMessage);
  const appendCustom =
    typeof session?.appendCustom === 'function' ? (type, data) => session.appendCustom(type, data) : undefined;
  const run = runs.create({
    sessionId: outer.sessionId,
    model: `${outer.provider}/${outer.model}`,
    settings: { ...settings },
    question: effectiveQuestion,
  });
  const onRetry = (info) => {
    runs.append(run, { type: 'llm_retry', ...info });
  };
  const rootLLM = new DshLlmClient(ctx, outer, rootProfile, outer.reasoningEffort, rootTarget, activeGate, onRetry);
  const branchLLM =
    branchConfigured || branchTarget.provider !== rootTarget.provider || branchTarget.model !== rootTarget.model
      ? new DshLlmClient(ctx, outer, branchProfile, branchEffort, branchTarget, activeGate, onRetry)
      : undefined;
  const queryLLM = new DshLlmClient(ctx, outer, queryProfile, undefined, queryTarget, activeGate, onRetry);
  const persistIngested = (res) => {
    if (!res || !Array.isArray(res.files)) return;
    for (const file of res.files) {
      if (file && typeof file.id === 'string' && typeof file.content === 'string') {
        sessionState.docs.set(file.id, { title: file.title ?? file.id, text: file.content, persist: false });
      }
    }
  };
  if (!sessionState.workspaceIngested && typeof workspace === 'string' && workspace !== '') {
    sessionState.workspaceIngested = true;
    try {
      const res = await store.addPath(workspace, {
        cwd: workspace,
        fs: hostFs,
        idPrefix: '',
        maxFiles: 1200,
        maxWalkFileBytes: 8 * 1024 * 1024,
        skipRichDocuments: true,
        signal: outer.signal,
      });
      persistIngested(res);
      sessionState.sources.add(workspace);
    } catch {
      // Non-fatal if workspace is empty or inaccessible.
    }
  }
  const promptPaths =
    typeof raf.extractPromptPaths === 'function' ? raf.extractPromptPaths(effectiveQuestion, workspace) : [];
  for (const promptPath of promptPaths) {
    if (sessionState.sources.has(promptPath)) continue;
    try {
      const res = await store.addPath(promptPath, { cwd: workspace, fs: hostFs, signal: outer.signal });
      persistIngested(res);
      sessionState.sources.add(promptPath);
      sessionState.board.record({
        agent: 'root',
        kind: 'tool',
        scope: res.sourceId,
        key: `add_document:${res.sourceId}`,
        summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
      });
    } catch (error) {
      console.error('RAF: cannot auto-ingest prompt path', promptPath, error);
    }
  }
  if (contextMessages.length === 0) {
    sessionState.rootState = undefined;
    sessionState.initialQuestion = undefined;
    sessionState.board = new raf.ResearchBoard();
  } else if (sessionState.rootState === undefined) {
    const recovered = extractPriorTurnBlocks(contextMessages, raf);
    if (recovered !== undefined) {
      sessionState.initialQuestion ??= recovered.initialQuestion;
      sessionState.rootState = recovered.rootState;
    }
  }
  const deepStudyBrief = settings.deepStudy === true ? studyBrief(effectiveQuestion, store) : '';
  if (deepStudyBrief !== '') effectiveQuestion += deepStudyBrief;
  if (sessionState.initialQuestion === undefined) {
    sessionState.initialQuestion = effectiveQuestion;
  }
  if (sessionState.initialManifest === undefined) {
    sessionState.initialManifest = store.manifest();
    sessionState.initialDocIds = new Set(store.list().map((d) => d.id));
  }
  const turn = {
    sessionId: outer.sessionId,
    run,
    finish: (patch) => runs.finish(run, patch),
    engine: undefined,
    store,
    sessionState,
    workspace,
    hostFs,
    raf,
    tools: new Map(),
    question: effectiveQuestion,
    userMessageId: human?.id,
    nativeTurn: position?.turn,
    nativeStep: position?.step ?? 0,
    step: 0,
    stepFolds: [],
    appendCustom,
    pendingCallId: undefined,
    pendingCallIds: [],
    pendingObservation: undefined,
    pendingObservations: [],
    pendingAction: undefined,
    pendingActions: [],
    finished: false,
    signal: outer.signal,
    emit: (event) => {
      runs.append(run, event);
      sessionState.commitBus?.recordEvent(turn, event);
    },
  };
  const extraTools = await createDshTools(ctx, outer.sessionId, outer, outer.signal, sessionState, workspace, raf, hostFs);
  const engine = new raf.RecursiveAgentFold({
    rootLLM,
    ...(branchLLM !== undefined ? { branchLLM } : {}),
    queryLLM,
    store,
    board: sessionState.board,
    ingest: { cwd: workspace, fs: hostFs, onIngest: persistIngested },
    documentTools: {
      maxReadLines: 250,
      maxReadTokens: 6000,
      maxGrepMatches: 100,
    },
    maxDepth: settings.depth,
    agent: {
      temperature: 0,
      maxObservationTokens: 6400,
      maxInvalidSteps: RAF_MAX_INVALID_STEPS,
      maxInvalidTotal: RAF_MAX_INVALID_TOTAL,
      maxReasoningTokens: RAF_MAX_REASONING_TOKENS,
      ...(Number.isFinite(contextWindow) && contextWindow > 0
        ? { maxPromptTokens: Math.floor(contextWindow * RAF_PROMPT_BUDGET_RATIO) }
        : {}),
    },
    llmQuery: {
      reserveRatio: settings.reserve,
      concurrency: settings.concurrency,
      temperature: 0,
      cache: { memo: sessionState.memo, chunkCounts: sessionState.chunkCounts },
    },
    rootMaxSteps: RAF_ROOT_MAX_STEPS,
    branchMaxSteps: RAF_BRANCH_MAX_STEPS,
    extraTools,
    signal: outer.signal,
    onEvent: turn.emit,
  });
  turn.engine = engine;
  turn.rootLLM = rootLLM;
  turn.tools = new Map();
  for (const tool of engine.toolsFor(0)) {
    turn.tools.set(tool.name, tool);
    turn.tools.set(`raf_${tool.name}`, tool);
    turn.tools.set(`ref_${tool.name}`, tool);
  }
  const commonBeginOpts = {
    initialManifest: sessionState.initialManifest,
    initialDocIds: sessionState.initialDocIds,
    ...(initialAttachments.length > 0 ? { initialAttachments } : {}),
    ...(hostAddendum !== '' ? { systemPromptAddendum: hostAddendum } : {}),
  };
  if (sessionState.rootState !== undefined) {
    engine.begin(sessionState.initialQuestion ?? effectiveQuestion, {
      initialState: sessionState.rootState,
      followUpQuestion: effectiveQuestion,
      ...commonBeginOpts,
    });
  } else {
    engine.begin(effectiveQuestion, commonBeginOpts);
  }
  if (sessionState.pending !== undefined) {
    const pending = sessionState.pending;
    try {
      if (sessionState.rootState === undefined) {
        throw new Error('RAF: pending tool call has no fold state to resume; refusing to re-run the tool');
      }
      const pendingCallIds =
        Array.isArray(pending.callIds) && pending.callIds.length > 0 ? pending.callIds : [pending.callId];
      const savedObs = pendingCallIds.map((cid, i) => {
        const existingObs = Array.isArray(pending.observations) ? pending.observations[i] : pending.observation;
        const fromMsg = toolResultFor(messages, cid)?.text;
        return existingObs ?? fromMsg;
      });
      if (savedObs.some((obs) => obs === undefined)) {
        throw new Error(
          `RAF: pending tool call "${pending.action.name}" (${pending.callId}) has no saved result; refusing to re-run it`,
        );
      }
      engine.restorePending({
        step: pending.step,
        motivation: pending.motivation,
        action: pending.action,
        ...(Array.isArray(pending.actions) && pending.actions.length > 0 ? { actions: pending.actions } : {}),
      });
      engine.submit(savedObs.length === 1 ? savedObs[0] : savedObs);
      sessionState.rootState = engine.snapshot();
      sessionState.pending = undefined;
      captureNewDocs({ sessionState, store });
      markSessionStateDirty(sessionState);
      await flushSessionState(sessionState);
    } catch (error) {
      sessionState.pending = undefined;
      sessionState.turnStatus = 'error';
      markSessionStateDirty(sessionState);
      await flushSessionState(sessionState);
      throw error;
    }
  }
  activeTurns.set(outer.sessionId, turn);
  while (activeTurns.size > MAX_ACTIVE_TURNS) {
    const oldest = activeTurns.keys().next().value;
    if (oldest === undefined) break;
    const evicted = activeTurns.get(oldest);
    if (evicted !== undefined && !evicted.finished && evicted.run !== undefined) {
      evicted.finish({ status: 'aborted', termination: 'error', answer: '', error: 'Turn evicted before completion', usage: null });
      evicted.run = undefined;
    }
    activeTurns.delete(oldest);
  }
  return turn;
}

async function* rafStream(ctx, outer, settings, runs) {
  let turn;
  try {
    const raf = await loadRaf();
    turn = await ensureTurn(ctx, outer, settings, runs, raf);
  } catch (error) {
    if (outer.signal?.aborted === true) {
      for (const chunk of abortedStream()) yield chunk;
    } else {
      for (const chunk of errorStream(error instanceof Error ? error.message : String(error))) yield chunk;
    }
    return;
  }
  try {
    const callIds =
      Array.isArray(turn.pendingCallIds) && turn.pendingCallIds.length > 0
        ? turn.pendingCallIds
        : turn.pendingCallId !== undefined
          ? [turn.pendingCallId]
          : [];
    if (callIds.length > 0) {
      const actions =
        Array.isArray(turn.pendingActions) && turn.pendingActions.length > 0
          ? turn.pendingActions
          : turn.pendingAction !== undefined
            ? [turn.pendingAction]
            : [];
      const indexedObs = new Array(callIds.length);
      const errTexts = [];
      for (let idx = 0; idx < callIds.length; idx++) {
        const cid = callIds[idx];
        const act = actions[idx] ?? turn.pendingAction;
        let result = toolResultFor(outer.messages, cid);
        if (result?.isError === true && PTC_LOCKOUT_RE.test(result.text) && act !== undefined) {
          const fallbackTool = turn.tools.get(act.name);
          if (fallbackTool !== undefined && typeof fallbackTool.execute === 'function') {
            try {
              const fallbackOut = await fallbackTool.execute(act.arguments ?? {}, {
                store: turn.store,
                usage: turn.engine.usage,
                depth: 0,
                agentName: 'root',
                step: turn.step,
                emit: turn.emit,
                signal: outer.signal,
                board: turn.engine.board,
                ancestorTasks: [turn.question],
              });
              result = { text: String(fallbackOut ?? ''), isError: false };
            } catch (fallbackErr) {
              result = {
                text: `Tool error: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`,
                isError: true,
              };
            }
          }
        }
        const isError = result?.isError === true;
        const preObs = turn.pendingObservations?.[idx] ?? (idx === 0 ? turn.pendingObservation : undefined);
        const observed = isError
          ? (result?.text ?? '') || (preObs ?? '')
          : (preObs ?? '') || (result?.text ?? '');
        const observation =
          observed !== ''
            ? observed
            : result !== undefined || preObs !== undefined
              ? '(completed with no output)'
              : 'Error: tool result missing';
        if (isError) errTexts.push(observation);
        indexedObs[idx] = isError
          ? observation
          : await indexExternalToolResult(
              act?.name,
              act?.arguments,
              observation,
              turn.store,
              turn.sessionState,
              turn.workspace,
              turn.raf,
              turn.hostFs,
            );
      }
      turn.engine.submit(
        indexedObs.length === 1 ? indexedObs[0] : indexedObs,
        errTexts.length > 0 ? { error: errTexts.join('; ') } : undefined,
      );
      turn.pendingCallId = undefined;
      turn.pendingCallIds = [];
      turn.pendingObservation = undefined;
      turn.pendingObservations = [];
      turn.pendingAction = undefined;
      turn.pendingActions = [];
      turn.sessionState.pending = undefined;
      const snapshot = typeof turn.engine.snapshot === 'function' ? turn.engine.snapshot() : undefined;
      if (snapshot !== undefined) turn.sessionState.rootState = snapshot;
      captureNewDocs(turn);
      markSessionStateDirty(turn.sessionState);
      await flushSessionState(turn.sessionState);
    }
    let liveText = '';
    let liveOpen = false;
    let visibleStreamChars = 0;
    let stepResult;
    let stepFailure;
    let stepDone = false;
    let wake = null;
    const pendingDeltas = [];
    const notify = () => {
      if (wake !== null) {
        const resolve = wake;
        wake = null;
        resolve();
      }
    };
    turn.rootLLM.onDelta = (text) => {
      if (typeof text !== 'string' || text === '') return;
      pendingDeltas.push(text);
      notify();
    };
    const stepPromise = turn.engine
      .next()
      .then(
        (step) => {
          stepResult = step;
        },
        (error) => {
          stepFailure = error;
        },
      )
      .finally(() => {
        stepDone = true;
        turn.rootLLM.onDelta = undefined;
        notify();
      });
    while (!stepDone || pendingDeltas.length > 0) {
      if (pendingDeltas.length === 0) {
        await new Promise((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const text = pendingDeltas.shift();
      // Keep whitespace deltas: providers stream words and spaces separately.
      const cleaned = cleanReasoningText(text, false);
      if (cleaned === '') continue;
      liveText += cleaned;
      if (visibleStreamChars >= RAF_VISIBLE_REASONING_CHARS) continue;
      if (!liveOpen) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        liveOpen = true;
      }
      const remaining = RAF_VISIBLE_REASONING_CHARS - visibleStreamChars;
      const delta = cleaned.slice(0, remaining);
      visibleStreamChars += delta.length;
      yield { type: 'reasoning-delta', index: 0, text: delta };
    }
    await stepPromise;
    if (stepFailure !== undefined) throw stepFailure;
    const step = stepResult;
    if (step === undefined) throw new Error('RAF step produced no result');
    captureNewDocs(turn);
    markSessionStateDirty(turn.sessionState);
    const reasoningFallback = typeof step.reasoning === 'string' ? step.reasoning.trim() : '';
    // A retried call never re-streams reasoning, so streamed deltas can be a failed prefix.
    const streamedReasoning = turn.rootLLM.retried === true ? '' : cleanReasoningText(liveText);
    const foldHeader =
      Array.isArray(turn.stepFolds) && turn.stepFolds.length > 0 ? turn.stepFolds.splice(0).join('\n') : '';
    const motivation =
      step.kind === 'tool' && typeof step.motivation === 'string'
        ? cleanReasoningText(step.motivation).replace(/^[.,;:!?\-\s]+/u, '')
        : '';
    const visible = capVisibleReasoning(
      cleanReasoningText(
        [
          foldHeader,
          streamedReasoning !== '' ? streamedReasoning : reasoningFallback,
          motivation !== '' ? `→ ${motivation}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      ),
    );
    let index = 0;
    if (liveOpen) {
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: visible } };
      index = 1;
    } else if (visible !== '') {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      yield { type: 'reasoning-delta', index: 0, text: visible };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: visible } };
      index = 1;
    }
    if (step.kind === 'tool') {
      const rawActions = Array.isArray(step.actions) && step.actions.length > 0 ? step.actions : [step.action];
      const callIds = new Array(rawActions.length);
      const normalizedActions = new Array(rawActions.length);
      for (let i = 0; i < rawActions.length; i++) {
        const act = rawActions[i] ?? step.action;
        const callId = randomUUID();
        const targetTool = turn.tools.get(act.name);
        const normalizedArgs = normalizeToolArguments(
          act.name,
          act.arguments,
          step.motivation,
          targetTool?.parameters,
        );
        callIds[i] = callId;
        normalizedActions[i] = { name: act.name, arguments: normalizedArgs };
      }
      turn.pendingCallId = callIds[0];
      turn.pendingCallIds = callIds;
      turn.pendingAction = normalizedActions[0];
      turn.pendingActions = normalizedActions;
      turn.pendingObservations = new Array(rawActions.length);
      turn.step = step.step;
      turn.sessionState.pending = {
        callId: callIds[0],
        callIds,
        step: step.step,
        motivation: step.motivation,
        action: normalizedActions[0],
        actions: normalizedActions,
      };
      const pendingSnapshot = typeof turn.engine.snapshot === 'function' ? turn.engine.snapshot() : undefined;
      if (pendingSnapshot !== undefined) turn.sessionState.rootState = pendingSnapshot;
      captureNewDocs(turn);
      markSessionStateDirty(turn.sessionState);
      await flushSessionState(turn.sessionState);
      for (let i = 0; i < normalizedActions.length; i++) {
        const callId = callIds[i];
        const normAct = normalizedActions[i];
        const args = JSON.stringify(normAct.arguments);
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index, id: callId, name: normAct.name, argumentsDelta: args };
        yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: normAct.name, arguments: args } };
        index += 1;
      }
      if (step.usage !== undefined) yield stepUsageChunk(step.lastUsage ?? step.usage);
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    if (step.kind === 'answer') {
      const answer = typeof step.answer === 'string' ? step.answer : '';
      if (answer !== '') {
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text: answer };
        yield { type: 'block-end', index, block: { type: 'text', text: answer } };
      }
      if (step.usage !== undefined) yield stepUsageChunk(step.lastUsage ?? step.usage);
      yield { type: 'finish', reason: { kind: 'stop' } };
      await finishRun(turn, step.result, outer.signal);
    } else {
      const answer = typeof step.result.answer === 'string' && step.result.answer !== '' ? step.result.answer : '';
      const failure =
        answer === ''
          ? typeof step.result.error === 'string' && step.result.error !== ''
            ? step.result.error
            : 'RAF engine returned no answer'
          : undefined;
      if (failure !== undefined) {
        turn.lastResultError = failure;
        const fallback = outer.signal?.aborted ? undefined : buildFallbackAnswer(turn);
        if (fallback !== undefined) {
          const result = {
            ...step.result,
            answer: fallback,
            terminated: 'forced_answer',
            error: undefined,
          };
          yield { type: 'block-start', index, blockType: 'text' };
          yield { type: 'text-delta', index, text: fallback };
          yield { type: 'block-end', index, block: { type: 'text', text: fallback } };
          if (step.usage !== undefined) yield stepUsageChunk(step.lastUsage ?? step.usage);
          yield { type: 'finish', reason: { kind: 'stop' } };
          await finishRun(turn, result, outer.signal);
          turn.finished = true;
          activeTurns.delete(outer.sessionId);
          return;
        }
        // A failed engine run must fail the step unless the outer request was aborted.
        await finishRun(turn, step.result, outer.signal);
        turn.finished = true;
        activeTurns.delete(outer.sessionId);
        if (outer.signal?.aborted === true) {
          for (const chunk of abortedStream()) yield chunk;
        } else {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: failure, code: 'ERROR' } } };
        }
        return;
      }
      yield { type: 'block-start', index, blockType: 'text' };
      yield { type: 'text-delta', index, text: answer };
      yield { type: 'block-end', index, block: { type: 'text', text: answer } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      await finishRun(turn, step.result, outer.signal);
    }
    turn.finished = true;
    activeTurns.delete(outer.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (turn !== undefined) turn.lastResultError = message;
    if (turn !== undefined && outer.signal?.aborted !== true) {
      const fallback = buildFallbackAnswer(turn);
      if (fallback !== undefined) {
        const snapshot = typeof turn.engine?.snapshot === 'function' ? turn.engine.snapshot() : undefined;
        if (snapshot !== undefined) turn.sessionState.rootState = snapshot;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: fallback };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: fallback } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        await finishRun(
          turn,
          { state: snapshot, answer: fallback, terminated: 'forced_answer', usage: turn.engine?.usage },
          outer.signal,
        );
        turn.finished = true;
        activeTurns.delete(outer.sessionId);
        return;
      }
    }
    if (turn !== undefined) {
      if (turn.sessionState !== undefined && turn.engine !== undefined) {
        const snapshot = typeof turn.engine.snapshot === 'function' ? turn.engine.snapshot() : undefined;
        if (snapshot !== undefined) turn.sessionState.rootState = snapshot;
      }
      const status = outer.signal?.aborted ? 'aborted' : 'error';
      if (turn.sessionState !== undefined) turn.sessionState.turnStatus = status;
      captureNewDocs(turn);
      markSessionStateDirty(turn.sessionState);
      await flushSessionState(turn.sessionState);
      if (turn.run !== undefined) {
        turn.finish({ status, answer: '', error: message, usage: null });
        turn.run = undefined;
      }
      turn.finished = true;
      activeTurns.delete(outer.sessionId);
    }
    if (outer.signal?.aborted === true) {
      for (const chunk of abortedStream()) yield chunk;
    } else {
      for (const chunk of errorStream(message)) yield chunk;
    }
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request body is too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function admissionRejection(ctx, req) {
  if (ctx?._isRafMockHost === true) return undefined;
  try {
    const connection = ctx.get('connection');
    if (connection === undefined || typeof connection.admit !== 'function') return 403;
    const admission = connection.admit(req);
    return 'rejection' in admission ? admission.rejection : undefined;
  } catch {
    return 403;
  }
}

const compactionOriginals = new WeakMap();

export function apply(ctx) {
  const state = loadState();
  const runs = createRunRegistry();
  let disposed = false;

  ctx.effect(() => () => {
    for (const s of sessionStates.values()) {
      if (s.dirty) persistSessionState(s);
    }
    activeTurns.clear();
  }, 'raf: active turns');

  const wrapCompaction = (compaction) => {
    if (!compaction || typeof compaction.compactIfNeeded !== 'function' || compactionOriginals.has(compaction)) {
      return () => {};
    }
    const rawDescriptor = Object.getOwnPropertyDescriptor(compaction, 'compactIfNeeded');
    const originalFn = compaction.compactIfNeeded;
    const boundOriginal = originalFn.bind(compaction);
    compactionOriginals.set(compaction, { rawDescriptor, originalFn });
    compaction.compactIfNeeded = (agent, trigger, signal) => {
      if (trigger === 'pressure' && isRafScope(agent, state)) {
        return Promise.resolve(null);
      }
      return boundOriginal(agent, trigger, signal);
    };
    return () => {
      const saved = compactionOriginals.get(compaction);
      if (saved !== undefined) {
        if (saved.rawDescriptor !== undefined) {
          Object.defineProperty(compaction, 'compactIfNeeded', saved.rawDescriptor);
        } else {
          delete compaction.compactIfNeeded;
        }
        compactionOriginals.delete(compaction);
      }
    };
  };
  ctx.effect(() => wrapCompaction(ctx.get?.('compaction')), 'raf: suppress pressure compaction');
  if (typeof ctx.inject === 'function') {
    ctx.inject(['compaction'], (compCtx) => {
      compCtx.effect?.(() => wrapCompaction(compCtx.compaction ?? compCtx.get?.('compaction')), 'raf: suppress pressure compaction');
    });
  }

  let syncAgentTools = () => {};
  ctx.effect(() => {
    let dispose = () => {};
    let cancelled = false;
    void loadRaf()
      .then((raf) => {
        if (cancelled) return;
        try {
          dispose = registerRafTools(ctx, raf, state);
          if (typeof dispose.syncAllAgents === 'function') {
            syncAgentTools = dispose.syncAllAgents;
          }
        } catch (error) {
          console.error('RAF: cannot register native tools', error);
        }
      })
      .catch((error) => {
        console.error('RAF: cannot load engine for native tools', error);
      });
    return () => {
      cancelled = true;
      syncAgentTools = () => {};
      dispose();
    };
  }, 'raf: native tools');

  const persist = () => {
    if (disposed) return;
    const json = stateJson(state);
    try {
      atomicWriteFileSync(statePath(), json, 0o600);
    } catch (error) {
      console.error('RAF: cannot persist engine state', error);
    }
  };

  ctx.on('llm/stream', (options, next) => {
    if (rafInternal.getStore() === true) return next();
    if (options === null || typeof options !== 'object') return next();
    if (typeof dshIsAgentLoopRequest === 'function') {
      if (!dshIsAgentLoopRequest(options)) return next();
    } else {
      // Internal DSH calls set purpose. RAF owns only the main agent call.
      if (options.purpose !== undefined) return next();
      // RAF answers a human request. A live RAF turn continues after tool results.
      const messages = Array.isArray(options.messages) ? options.messages : [];
      if (!hasHumanUserMessage(messages) && !activeTurns.has(options.sessionId)) return next();
    }
    if (engineOf(state, options.sessionId) !== ENGINE_RAF) return next();
    return rafStream(ctx, options, state.settings, runs);
  });

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ENGINE_ROUTE,
          handler: async (req, res) => {
            try {
              const rejection = admissionRejection(webCtx, req);
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              const url = new URL(req.url ?? '/', 'http://localhost');
              const sessionId = url.searchParams.get('sessionId') ?? undefined;
              if (req.method === 'GET') {
                sendJson(res, 200, {
                  ...(sessionId === undefined ? {} : { engine: engineOf(state, sessionId) }),
                  defaultEngine: state.defaultEngine,
                  settings: state.settings,
                });
                return;
              }
              if (req.method !== 'POST') {
                res.writeHead(405, { allow: 'GET, POST' });
                res.end('method not allowed');
                return;
              }
              const payload = JSON.parse(await readBody(req));
              if (payload === null || typeof payload !== 'object') throw new Error('invalid payload');
              if (payload.engine !== undefined) {
                if (typeof payload.sessionId !== 'string' || payload.sessionId === '') {
                  throw new Error('sessionId is required to switch the engine');
                }
                setEngine(state, payload.sessionId, payload.engine);
                syncAgentTools();
              }
              if (payload.settings !== undefined) {
                state.settings = sanitizeSettings(payload.settings);
              }
              persist();
              sendJson(res, 200, {
                ok: true,
                ...(sessionId === undefined ? {} : { engine: engineOf(state, sessionId) }),
                defaultEngine: state.defaultEngine,
                settings: state.settings,
              });
            } catch (error) {
              const status = typeof error?.status === 'number' ? error.status : 400;
              sendJson(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      'raf: engine state route',
    );

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'prefix',
          path: RUNS_ROUTE,
          handler: async (req, res) => {
            try {
              const rejection = admissionRejection(webCtx, req);
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              if (req.method !== 'GET') {
                res.writeHead(405, { allow: 'GET' });
                res.end('method not allowed');
                return;
              }
              const url = new URL(req.url ?? '/', 'http://localhost');
              const rest = url.pathname.slice(RUNS_ROUTE.length).replace(/^\/+/, '');
              if (rest === '') {
                const rawSessionId = url.searchParams.get('sessionId');
                const sessionId =
                  typeof rawSessionId === 'string' && rawSessionId.trim() !== ''
                    ? rawSessionId.trim()
                    : undefined;
                sendJson(res, 200, { runs: runs.list(sessionId) });
                return;
              }
              const run = runs.get(decodeURIComponent(rest));
              if (run === undefined) {
                sendJson(res, 404, { error: 'run not found' });
                return;
              }
              sendJson(res, 200, run);
            } catch (error) {
              const status = typeof error?.status === 'number' ? error.status : 400;
              sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      'raf: runs route',
    );

    webCtx.effect(
      () =>
        webCtx.webServer.register({
          kind: 'exact',
          path: MODELS_ROUTE,
          handler: async (req, res) => {
            try {
              const rejection = admissionRejection(webCtx, req);
              if (rejection !== undefined) {
                res.writeHead(rejection);
                res.end(rejection === 401 ? 'unauthorized' : 'forbidden');
                return;
              }
              if (req.method !== 'GET') {
                res.writeHead(405, { allow: 'GET' });
                res.end('method not allowed');
                return;
              }
              const providers = await catalogModels(ctx);
              sendJson(res, 200, { providers });
            } catch (error) {
              const status = typeof error?.status === 'number' ? error.status : 400;
              sendJson(res, status, { error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
      'raf: models route',
    );
  });


  ctx.effect(
    () => () => {
      disposed = true;
    },
    'raf: engine state',
  );
}
