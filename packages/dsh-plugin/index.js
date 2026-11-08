import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ENGINE_STANDARD = 'standard';
const ENGINE_RAF = 'raf';
const ENGINE_ROUTE = '/plugins/@raf/dsh-plugin/engine';
const RUNS_ROUTE = '/plugins/@raf/dsh-plugin/runs';
const DEFAULT_SETTINGS = Object.freeze({
  depth: 2,
  reserve: 0.3,
  concurrency: 4,
  rootModel: '',
  branchModel: '',
  queryModel: '',
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
const RAF_ROOT_MAX_STEPS = 32;
const RAF_ROOT_MAX_OUTPUT = 16000;
const RAF_QUERY_MAX_OUTPUT = 16384;

export const inject = ['agents', 'llm', 'tools'];

const rafInternal = new AsyncLocalStorage();

let rafPromise;

function loadRaf() {
  rafPromise ??= import(new URL('../engine/dist/index.js', import.meta.url));
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

function sanitizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {};
  return Object.freeze({
    depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
    reserve: toReserve(source.reserve),
    concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
    rootModel: toModelString(source.rootModel),
    branchModel: toModelString(source.branchModel),
    queryModel: toModelString(source.queryModel),
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

function latestUserIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isHumanUserMessage(messages[index])) return index;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== null && typeof message === 'object' && message.role === 'user') return index;
  }
  return -1;
}

function hasHumanUserMessage(messages) {
  return messages.some(isHumanUserMessage);
}

function renderTranscript(messages) {
  const parts = [];
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'tool') continue;
    const text = renderContent(message.content);
    if (text === '') continue;
    const label = message.role === 'tool' ? 'Tool result' : message.role === 'assistant' ? 'Assistant' : 'User';
    parts.push(`## ${label}\n${text}`);
  }
  return parts.join('\n\n');
}

function questionOf(messages, index) {
  if (index < 0) return '';
  return renderContent(messages[index].content);
}

function contextWindowOf(ctx, sessionId) {
  try {
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
  const content = [{ type: 'text', text: message.content }];
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
  return {
    // DSH reports uncached input, cache reads, and cache writes separately; engine prompt counts are totals.
    promptTokens: inputTokens + cachedTokens + cacheWriteTokens,
    completionTokens: outputTokens,
    cachedTokens,
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
  const settingValue =
    tier === 'ROOT'
      ? settings?.rootModel
      : tier === 'BRANCH'
        ? settings?.branchModel
        : tier === 'QUERY'
          ? settings?.queryModel
          : '';
  const fromSettings = parseModelSpec(settingValue, fallback);
  if (fromSettings !== undefined) return fromSettings;
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

class DshLlmClient {
  constructor(ctx, outer, profile, reasoningEffort, target) {
    this.ctx = ctx;
    this.outer = outer;
    this.profile = profile;
    this.reasoningEffort = reasoningEffort;
    this.provider = target?.provider ?? outer.provider;
    this.model = target?.model ?? outer.model;
    this.onDelta = undefined;
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
    let text = '';
    let reasoning = '';
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
    let finishKind;
    let failure;
    await rafInternal.run(true, async () => {
      for await (const chunk of this.ctx.llm.stream(options)) {
        if (chunk === null || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') text += chunk.text;
        else if (chunk.type === 'reasoning-delta') {
          reasoning += chunk.text;
          if (typeof this.onDelta === 'function') this.onDelta(chunk.text);
        }
        else if (chunk.type === 'usage') usage = chunk.usage;
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind;
          failure = chunk.reason?.failure;
        }
      }
    });
    if (finishKind === 'error' || finishKind === 'aborted') {
      const error = new Error(typeof failure?.message === 'string' ? failure.message : 'LLM request failed');
      if (typeof failure?.code === 'string') error.code = failure.code;
      throw error;
    }
    return {
      text,
      reasoning,
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
function cleanReasoningText(text) {
  return text
    .replace(PROTOCOL_TAG_TEXT, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
  const text = contentText(value.content);
  if (value.isError === true) {
    const reason = value.error !== null && typeof value.error === 'object' && typeof value.error.message === 'string' ? value.error.message : 'tool failed';
    return text === '' ? `Tool error: ${reason}` : `Tool error: ${text}`;
  }
  if (text !== '') return text;
  if (value.value !== undefined) {
    try {
      return typeof value.value === 'string' ? value.value : JSON.stringify(value.value);
    } catch {
      return String(value.value);
    }
  }
  return '';
}

function toDocId(prefix, rawLabel, fallbackIndex) {
  const cleaned = String(rawLabel ?? '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9_.\-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(-52);
  return `${prefix}_${cleaned || String(fallbackIndex)}`;
}

function indexExternalToolResult(toolName, args, text, store, sessionState) {
  if (toolName !== 'read' && toolName !== 'web_fetch') return text;
  if (text.startsWith('Tool error:') || text.length < 1200) return text;
  const rawTarget =
    args?.path ?? args?.file_path ?? args?.filePath ?? args?.url ?? `${toolName}_${(sessionState?.docs?.size ?? 0) + 1}`;
  const docId = toDocId(toolName === 'web_fetch' ? 'web' : 'file', rawTarget, (sessionState?.docs?.size ?? 0) + 1);
  const title = String(rawTarget);
  try {
    const doc = store.add(text, { id: docId, title });
    sessionState?.docs?.set(docId, { title, text });
    return `[Indexed in ContextStore as document "${docId}" (${doc.lines.length} lines, ~${doc.tokens} tokens) — use search, outline, grep, tally, read, branch(scope="${docId}"), or llm_query on "${docId}"]\n${text}`;
  } catch {
    return text;
  }
}

function createDshTools(ctx, sessionId, signal, sessionState) {
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
  const definitions = tools.definitions(agent);
  if (!Array.isArray(definitions)) return [];
  const extra = [];
  for (const definition of definitions) {
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
        try {
          const batch = await tools.execute({
            calls: [
              {
                type: 'tool-call',
                id: randomUUID(),
                name: definition.name,
                arguments: JSON.stringify(args ?? {}),
              },
            ],
            signal: toolCtx.signal ?? signal,
            agent,
          });
          const first = Array.isArray(batch.results) ? batch.results[0] : undefined;
          const text = toolResultText(first);
          return indexExternalToolResult(definition.name, args, text, toolCtx.store, sessionState);
        } catch (error) {
          return `Tool ${definition.name} failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  }
  return extra;
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

function sessionPosition(session) {
  const log = Array.isArray(session.log) ? session.log : [];
  let turn = 1;
  let step = 0;
  for (const event of log) {
    if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn;
    if (event?.type === 'step/start') {
      if (typeof event.data?.turn === 'number') turn = event.data.turn;
      if (typeof event.data?.step === 'number') step = event.data.step;
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

function addUsage(left, right) {
  return {
    promptTokens: left.promptTokens + right.promptTokens,
    completionTokens: left.completionTokens + right.completionTokens,
    cachedTokens: left.cachedTokens + right.cachedTokens,
    ...(left.reasoningTokens !== undefined || right.reasoningTokens !== undefined
      ? { reasoningTokens: (left.reasoningTokens ?? 0) + (right.reasoningTokens ?? 0) }
      : {}),
  };
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

function finishRun(turn, result, signal) {
  if (turn.run === undefined) return;
  const status = signal?.aborted ? 'aborted' : result.terminated === 'error' ? 'error' : 'done';
  turn.finish({
    status,
    termination: result.terminated,
    answer: typeof result.answer === 'string' ? result.answer : '',
    error: result.error ?? null,
    usage: runUsageOf(result),
  });
  turn.run = undefined;
}

function errorStream(message) {
  const text = `RAF engine error: ${message}`;
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

/**
 * Register RAF tool schemas as native DSH tools. The native loop executes the
 * call; the engine receives the observation through the next step's submit().
 */
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
          const before = turn.engine.usage.total();
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
          const after = turn.engine.usage.total();
          turn.pendingToolUsage = {
            promptTokens: after.promptTokens - before.promptTokens,
            completionTokens: after.completionTokens - before.completionTokens,
            cachedTokens: after.cachedTokens - before.cachedTokens,
            ...(after.reasoningTokens !== undefined || before.reasoningTokens !== undefined
              ? { reasoningTokens: (after.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0) }
              : {}),
          };
          turn.pendingObservation = observation;
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
      const offCreated = toolsCtx.on('agent/created', (ev) => syncAgentOverrides(ev?.agent));
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

function getSessionState(sessionId, raf) {
  const key = typeof sessionId === 'string' && sessionId !== '' ? sessionId : 'default';
  let state = sessionStates.get(key);
  if (!state) {
    if (sessionStates.size >= 100) {
      const oldestKey = sessionStates.keys().next().value;
      if (oldestKey !== undefined) sessionStates.delete(oldestKey);
    }
    state = {
      memo: new Map(),
      chunkCounts: new Map(),
      board: new raf.ResearchBoard(),
      docs: new Map(),
      sources: new Set(),
      workspaceIngested: false,
    };
    sessionStates.set(key, state);
  }
  return state;
}

function sameTurn(turn, position, human, messages) {
  if (turn === undefined || turn.finished || turn.pendingCallId === undefined) return false;
  if (human?.id !== undefined && turn.userMessageId !== undefined && human.id !== turn.userMessageId) return false;
  if (position !== undefined && turn.nativeTurn !== undefined && turn.nativeTurn !== position.turn) return false;
  return toolResultFor(messages, turn.pendingCallId) !== undefined || turn.pendingObservation !== undefined;
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
  const position = session === undefined ? undefined : sessionPosition(session);
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
  const transcript = renderTranscript(contextMessages);
  const sessionState = getSessionState(outer.sessionId, raf);
  const store = new raf.ContextStore();
  if (transcript !== '') store.add(transcript, { id: 'session', title: 'DSH session transcript' });
  for (const [docId, docEntry] of sessionState.docs.entries()) {
    if (docId !== 'session' && typeof docEntry?.text === 'string' && docEntry.text !== '') {
      store.add(docEntry.text, { id: docId, title: docEntry.title ?? docId });
    }
  }
  const contextWindow = contextWindowOf(ctx, outer.sessionId);
  const rootTarget = resolveTierTarget(outer, settings, 'ROOT');
  const branchTarget = resolveTierTarget(outer, settings, 'BRANCH', rootTarget);
  const queryTarget = resolveTierTarget(outer, settings, 'QUERY', rootTarget);
  const rootProfile = { name: rootTarget.model, contextWindow, maxOutputTokens: RAF_ROOT_MAX_OUTPUT };
  const branchProfile = { name: branchTarget.model, contextWindow, maxOutputTokens: RAF_ROOT_MAX_OUTPUT };
  const queryProfile = { name: queryTarget.model, contextWindow, maxOutputTokens: RAF_QUERY_MAX_OUTPUT };
  const rootLLM = new DshLlmClient(ctx, outer, rootProfile, outer.reasoningEffort, rootTarget);
  const branchLLM =
    branchTarget.provider !== rootTarget.provider || branchTarget.model !== rootTarget.model
      ? new DshLlmClient(ctx, outer, branchProfile, outer.reasoningEffort, branchTarget)
      : undefined;
  const queryLLM = new DshLlmClient(ctx, outer, queryProfile, 'low', queryTarget);
  const persistIngested = (res) => {
    if (!res || !Array.isArray(res.files)) return;
    for (const file of res.files) {
      if (file && typeof file.id === 'string' && typeof file.content === 'string') {
        sessionState.docs.set(file.id, { title: file.title ?? file.id, text: file.content });
      }
    }
  };
  if (!sessionState.workspaceIngested && typeof workspace === 'string' && workspace !== '') {
    sessionState.workspaceIngested = true;
    try {
      const res = await store.addPath(workspace, {
        cwd: workspace,
        idPrefix: '',
        maxFiles: 300,
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
      const res = await store.addPath(promptPath, { cwd: workspace, signal: outer.signal });
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
  const deepStudyBrief = studyBrief(effectiveQuestion, store);
  if (deepStudyBrief !== '') effectiveQuestion += deepStudyBrief;
  const run = runs.create({
    sessionId: outer.sessionId,
    model: `${outer.provider}/${outer.model}`,
    settings: { ...settings },
    question: effectiveQuestion,
  });
  const turn = {
    sessionId: outer.sessionId,
    run,
    finish: (patch) => runs.finish(run, patch),
    engine: undefined,
    store,
    sessionState,
    tools: new Map(),
    question: effectiveQuestion,
    userMessageId: human?.id,
    nativeTurn: position?.turn,
    nativeStep: position?.step ?? 0,
    step: 0,
    pendingCallId: undefined,
    pendingObservation: undefined,
    pendingAction: undefined,
    pendingToolUsage: undefined,
    finished: false,
    signal: outer.signal,
    emit: (event) => runs.append(run, event),
  };
  const extraTools = createDshTools(ctx, outer.sessionId, outer.signal, sessionState);
  const engine = new raf.RecursiveAgentFold({
    rootLLM,
    ...(branchLLM !== undefined ? { branchLLM } : {}),
    queryLLM,
    store,
    board: sessionState.board,
    ingest: { cwd: workspace, onIngest: persistIngested },
    documentTools: {
      maxReadLines: 120,
      maxReadTokens: 4000,
      maxGrepMatches: 60,
    },
    maxDepth: settings.depth,
    agent: { temperature: 0 },
    llmQuery: {
      reserveRatio: settings.reserve,
      concurrency: settings.concurrency,
      temperature: 0,
      cache: { memo: sessionState.memo, chunkCounts: sessionState.chunkCounts },
    },
    rootMaxSteps: RAF_ROOT_MAX_STEPS,
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
  engine.begin(effectiveQuestion);
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
    for (const chunk of errorStream(error instanceof Error ? error.message : String(error))) yield chunk;
    return;
  }
  try {
    if (turn.pendingCallId !== undefined) {
      const result = toolResultFor(outer.messages, turn.pendingCallId);
      const observation = result?.text || turn.pendingObservation || 'Error: tool result missing';
      const indexed =
        result?.isError === true
          ? observation
          : indexExternalToolResult(turn.pendingAction?.name, turn.pendingAction?.arguments, observation, turn.store, turn.sessionState);
      turn.engine.submit(indexed, result?.isError === true ? { error: observation } : undefined);
      turn.pendingCallId = undefined;
      turn.pendingObservation = undefined;
      turn.pendingAction = undefined;
    }
    let liveText = '';
    let liveOpen = false;
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
      const cleaned = cleanReasoningText(text);
      if (cleaned === '') continue;
      if (!liveOpen) {
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        liveOpen = true;
      }
      liveText += cleaned;
      yield { type: 'reasoning-delta', index: 0, text: cleaned };
    }
    await stepPromise;
    if (stepFailure !== undefined) throw stepFailure;
    const step = stepResult;
    if (step === undefined) throw new Error('RAF step produced no result');
    if (turn.pendingToolUsage !== undefined && step.kind !== 'done') {
      step.usage = addUsage(step.usage, turn.pendingToolUsage);
      turn.pendingToolUsage = undefined;
    }
    const reasoningFallback = typeof step.reasoning === 'string' ? step.reasoning.trim() : '';
    const motivation =
      step.kind === 'tool' && typeof step.motivation === 'string'
        ? cleanReasoningText(step.motivation).replace(/^[.,;:!?\-\s]+/u, '')
        : '';
    const visible = cleanReasoningText([
      liveText.trim() !== '' ? liveText.trim() : reasoningFallback,
      motivation !== '' ? `→ ${motivation}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'));
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
      const callId = randomUUID();
      turn.pendingCallId = callId;
      turn.pendingAction = step.action;
      turn.step = step.step;
      const args = JSON.stringify(step.action.arguments ?? {});
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index, id: callId, name: step.action.name, argumentsDelta: args };
      yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name: step.action.name, arguments: args } };
      if (step.usage !== undefined) yield stepUsageChunk(step.usage);
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
      if (step.usage !== undefined) yield stepUsageChunk(step.usage);
      yield { type: 'finish', reason: { kind: 'stop' } };
      finishRun(turn, step.result, outer.signal);
    } else {
      const answer =
        typeof step.result.answer === 'string' && step.result.answer !== ''
          ? step.result.answer
          : (step.result.error ?? 'RAF engine returned no answer.');
      if (answer !== '') {
        yield { type: 'block-start', index, blockType: 'text' };
        yield { type: 'text-delta', index, text: answer };
        yield { type: 'block-end', index, block: { type: 'text', text: answer } };
      }
      yield { type: 'finish', reason: { kind: 'stop' } };
      finishRun(turn, step.result, outer.signal);
    }
    turn.finished = true;
    activeTurns.delete(outer.sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (turn !== undefined) {
      if (turn.run !== undefined) {
        turn.finish({ status: outer.signal?.aborted ? 'aborted' : 'error', answer: '', error: message, usage: null });
        turn.run = undefined;
      }
      turn.finished = true;
      activeTurns.delete(outer.sessionId);
    }
    for (const chunk of errorStream(message)) yield chunk;
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
  try {
    const connection = ctx.get('connection');
    if (connection === undefined || typeof connection.admit !== 'function') return undefined;
    const admission = connection.admit(req);
    return 'rejection' in admission ? admission.rejection : undefined;
  } catch {
    return undefined;
  }
}

export function apply(ctx) {
  const state = loadState();
  const runs = createRunRegistry();
  let writeQueue = Promise.resolve();
  let disposed = false;

  ctx.effect(() => () => activeTurns.clear(), 'raf: active turns');

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
    writeQueue = writeQueue
      .then(async () => {
        await mkdir(dirname(statePath()), { recursive: true });
        const temporary = `${statePath()}.tmp`;
        await writeFile(temporary, json, 'utf8');
        await rename(temporary, statePath());
      })
      .catch((error) => {
        console.error('RAF: cannot persist engine state', error);
      });
  };

  ctx.on('llm/stream', (options, next) => {
    if (rafInternal.getStore() === true) return next();
    if (options === null || typeof options !== 'object') return next();
    // Internal DSH calls set purpose. RAF owns only the main agent call.
    if (options.purpose !== undefined) return next();
    // RAF answers a human request. A live RAF turn continues after tool results.
    const messages = Array.isArray(options.messages) ? options.messages : [];
    if (!hasHumanUserMessage(messages) && !activeTurns.has(options.sessionId)) return next();
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
  });


  ctx.effect(
    () => () => {
      disposed = true;
    },
    'raf: engine state',
  );
}
