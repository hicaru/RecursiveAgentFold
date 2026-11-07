import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
const RAF_QUERY_MAX_OUTPUT = 4096;

export const inject = ['llm'];

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
  return {
    promptTokens: inputTokens,
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
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text;
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

function formatTrace(events, settings, outer, usage) {
  const lines = [];
  lines.push('RAF execution trace (diagnostic data, not model reasoning).');
  lines.push(`model: ${outer.provider}/${outer.model}`);
  lines.push(`settings: depth=${settings.depth} reserve=${settings.reserve} readers=${settings.concurrency}`);
  if (usage !== null && typeof usage === 'object') {
    lines.push(
      `usage: in=${usage.input ?? 0} out=${usage.output ?? 0} cached=${usage.cached ?? 0} root_cache=${Math.round((usage.rootCacheHitRate ?? 0) * 100)}% total_cache=${Math.round((usage.cacheHitRate ?? 0) * 100)}%`,
    );
  }
  for (const event of events) {
    switch (event.type) {
      case 'run_start':
        lines.push(`[run] ${event.agent} depth=${event.depth} question=${shortText(event.question, 300)}`);
        break;
      case 'step_start':
        lines.push(`[step ${event.step}] ${event.agent} ctx=${event.contextTokens} blocks=${event.blocks}`);
        break;
      case 'llm_call':
        lines.push(
          `  [llm ${event.role}] ${event.model} in=${event.usage.promptTokens} out=${event.usage.completionTokens} cached=${event.usage.cachedTokens} ${event.latencyMs}ms${event.finishReason !== undefined ? ` finish=${event.finishReason}` : ''}`,
        );
        break;
      case 'llm_response':
        lines.push(`  [response] ${shortText(event.text, 600)}`);
        break;
      case 'fold': {
        const directive = event.outcome?.directive ?? event.requested;
        const range = Array.isArray(directive?.range) ? `[${directive.range.join(',')}]` : '';
        lines.push(`  [fold${event.outcome?.kind ? ` ${event.outcome.kind}` : ''}] ${range} ${shortText(directive?.summary, 500)}`);
        if (Array.isArray(event.outcome?.corrections) && event.outcome.corrections.length > 0) {
          lines.push(`    corrections: ${shortText(event.outcome.corrections.join('; '), 400)}`);
        }
        break;
      }
      case 'tool_call':
        lines.push(`  [tool ${event.action.name}] ${shortText(event.action.arguments, 500)}`);
        break;
      case 'tool_result':
        lines.push(
          `  [result ${event.name}] tokens=${event.tokens}${event.error ? ` error=${event.error}` : ''} ${shortText(event.observation, 700)}`,
        );
        break;
      case 'llm_query': {
        const extra = event.usage
          ? ` calls=${event.calls ?? 0} in=${event.usage.promptTokens} out=${event.usage.completionTokens} cached=${event.usage.cachedTokens}`
          : '';
        lines.push(
          `  [llm_query] mode=${event.mode} chunks=${event.chunks} relevant=${event.relevant} errors=${event.errors} memo=${event.memoHits} chunkTokens=${event.chunkTokens}${extra} query=${shortText(event.query, 300)}`,
        );
        break;
      }
      case 'format_error':
        lines.push(`  [format_error step ${event.step}] ${shortText(event.errors.join('; '), 500)}`);
        break;
      case 'error':
        lines.push(`  [error${event.step === undefined ? '' : ` step ${event.step}`}] ${shortText(event.message, 600)}`);
        break;
      case 'answer':
        lines.push(`  [answer step ${event.step}] ${shortText(event.answer, 600)}`);
        break;
      case 'run_end':
        lines.push(`[end] ${event.agent} steps=${event.steps} terminated=${event.terminated}`);
        break;
      default:
        lines.push(`  [${String(event.type)}]`);
    }
  }
  const text = lines.join('\n');
  return text.length > 12000 ? `${text.slice(0, 12000)}\n… trace truncated` : text;
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


const RAF_DSH_TOOLS = Object.freeze(
  new Set(['read', 'glob', 'grep', 'bash', 'write', 'edit', 'apply_patch', 'lsp', 'web_search', 'web_fetch']),
);
const RAF_DSH_NAME = Object.freeze({
  read: 'read_file',
  grep: 'grep_files',
  search: 'search_files',
  outline: 'outline_files',
});

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
    if (!RAF_DSH_TOOLS.has(definition.name)) continue;
    extra.push({
      name: RAF_DSH_NAME[definition.name] ?? definition.name,
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
          if (
            !text.startsWith('Tool error:') &&
            text.length >= 1200 &&
            (definition.name === 'read' || definition.name === 'web_fetch')
          ) {
            const rawTarget =
              args?.path ?? args?.file_path ?? args?.filePath ?? args?.url ?? `${definition.name}_${(sessionState?.docs?.size ?? 0) + 1}`;
            const docId = toDocId(definition.name === 'web_fetch' ? 'web' : 'file', rawTarget, (sessionState?.docs?.size ?? 0) + 1);
            const title = String(rawTarget);
            try {
              const doc = toolCtx.store.add(text, { id: docId, title });
              sessionState?.docs?.set(docId, { title, text });
              return `[Indexed in ContextStore as document "${docId}" (${doc.lines.length} lines, ~${doc.tokens} tokens) — use search, outline, grep, tally, read, branch(scope="${docId}"), or llm_query on "${docId}"]\n${text}`;
            } catch {
              return text;
            }
          }
          return text;
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

function createInlineTrace(ctx, outer, signal) {
  const session = getLiveSession(ctx, outer.sessionId);
  if (session === undefined) return () => {};
  const { turn, step } = sessionPosition(session);
  const pending = new Map();
  let failed = false;
  const append = (type, data, opts) => {
    if (failed) return undefined;
    try {
      return session.append(type, data, ...(opts === undefined ? [] : [opts]));
    } catch (error) {
      failed = true;
      console.error('RAF: cannot append inline session event', error);
      return undefined;
    }
  };
  return (event) => {
    if (signal?.aborted || event === null || typeof event !== 'object') return;
    try {
      if (event.type === 'tool_call') {
        const action = event.action !== null && typeof event.action === 'object' ? event.action : {};
        const name = typeof action.name === 'string' && action.name !== '' ? action.name : 'tool';
        const args = JSON.stringify(action.arguments ?? {});
        const callId = randomUUID();
        const label = String(event.agent ?? 'root');
        const motivation = String(event.motivation ?? '').replace(/\s+/g, ' ').trim().slice(0, 400);
        const line = motivation === '' ? `${label} · ${name}` : `${label} · ${motivation}`;
        const message = {
          id: randomUUID(),
          role: 'assistant',
          content: [
            { type: 'text', text: line },
            { type: 'tool-call', id: callId, name, arguments: args },
          ],
          source: { kind: 'model', provider: outer.provider, model: outer.model },
        };
        if (append('assistant/message', { turn, step, message, stream: [] }, { surfaceOp: 'append' }) === undefined) return;
        const call = append('tool/call', { turn, step, callId, name, arguments: args });
        const key = `${label}\u0000${Number(event.step ?? 0)}\u0000${name}`;
        const list = pending.get(key) ?? [];
        list.push({ callId, callSeq: call?.seq });
        pending.set(key, list);
        return;
      }
      if (event.type === 'tool_result') {
        const key = `${String(event.agent ?? 'root')}\u0000${Number(event.step ?? 0)}\u0000${String(event.name ?? '')}`;
        const list = pending.get(key);
        const item = list === undefined ? undefined : list.shift();
        if (item === undefined) return;
        const observation = shortText(event.observation, 6000);
        const message = {
          id: randomUUID(),
          role: 'tool',
          toolCallId: item.callId,
          source: { kind: 'tool', callId: item.callId },
          content: [{ type: 'text', text: observation === '' ? '—' : observation }],
          isError: event.error !== undefined,
        };
        append(
          'tool/result',
          { turn, step, message },
          { surfaceOp: 'append', ...(item.callSeq === undefined ? {} : { sourceEventSeqs: [item.callSeq] }) },
        );
      }
    } catch (error) {
      failed = true;
      console.error('RAF: cannot render inline session event', error);
    }
  };
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
    };
    sessionStates.set(key, state);
  }
  return state;
}

async function* rafStream(ctx, outer, settings, runs) {
  const signal = outer.signal;
  let run;
  let finished = false;
  try {
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const messages = Array.isArray(outer.messages) ? outer.messages : [];
    const userIndex = latestUserIndex(messages);
    const question = questionOf(messages, userIndex);
    const effectiveQuestion = question === '' ? 'Answer the latest request.' : question;
    const contextMessages = userIndex < 0 ? messages : messages.filter((_message, index) => index !== userIndex);
    const transcript = renderTranscript(contextMessages);
    run = runs.create({
      sessionId: outer.sessionId,
      model: `${outer.provider}/${outer.model}`,
      settings: { ...settings },
      question: effectiveQuestion,
    });
    const raf = await loadRaf();
    const sessionState = getSessionState(outer.sessionId, raf);
    const contextWindow = contextWindowOf(ctx, outer.sessionId);
    const rootTarget = resolveTierTarget(outer, settings, 'ROOT');
    const branchTarget = resolveTierTarget(outer, settings, 'BRANCH', rootTarget);
    const queryTarget = resolveTierTarget(outer, settings, 'QUERY', rootTarget);
    const rootProfile = {
      name: rootTarget.model,
      contextWindow,
      maxOutputTokens: RAF_ROOT_MAX_OUTPUT,
    };
    const branchProfile = {
      name: branchTarget.model,
      contextWindow,
      maxOutputTokens: RAF_ROOT_MAX_OUTPUT,
    };
    const queryProfile = {
      name: queryTarget.model,
      contextWindow,
      maxOutputTokens: RAF_QUERY_MAX_OUTPUT,
    };
    const store = new raf.ContextStore();
    if (transcript !== '') store.add(transcript, { id: 'session', title: 'DSH session transcript' });
    for (const [docId, docEntry] of sessionState.docs.entries()) {
      if (docId !== 'session' && typeof docEntry?.text === 'string' && docEntry.text !== '') {
        store.add(docEntry.text, { id: docId, title: docEntry.title ?? docId });
      }
    }
    const rootLLM = new DshLlmClient(ctx, outer, rootProfile, outer.reasoningEffort, rootTarget);
    const branchLLM =
      branchTarget.provider !== rootTarget.provider || branchTarget.model !== rootTarget.model
        ? new DshLlmClient(ctx, outer, branchProfile, outer.reasoningEffort, branchTarget)
        : undefined;
    const queryLLM = new DshLlmClient(ctx, outer, queryProfile, 'low', queryTarget);
    const extraTools = createDshTools(ctx, outer.sessionId, signal, sessionState);
    const inline = createInlineTrace(ctx, outer, signal);
    const events = [];
    const emitEvent = (event) => {
      events.push(event);
      runs.append(run, event);
      inline(event);
    };
    const persistIngested = (res) => {
      if (!res || !Array.isArray(res.files)) return;
      for (const f of res.files) {
        if (f && typeof f.id === 'string' && typeof f.content === 'string') {
          sessionState.docs.set(f.id, { title: f.title ?? f.id, text: f.content });
        }
      }
    };
    const promptPaths =
      typeof raf.extractPromptPaths === 'function'
        ? raf.extractPromptPaths(effectiveQuestion, process.cwd())
        : [];
    for (const promptPath of promptPaths) {
      if (sessionState.sources.has(promptPath)) continue;
      try {
        const callEvent = {
          type: 'tool_call',
          agent: 'root',
          step: 0,
          action: { name: 'add_document', arguments: { path: promptPath } },
          motivation: `Auto-ingest path referenced in prompt: ${promptPath}`,
        };
        emitEvent(callEvent);
        const res = await store.addPath(promptPath, { cwd: process.cwd(), signal });
        persistIngested(res);
        sessionState.sources.add(promptPath);
        sessionState.board.record({
          agent: 'root',
          kind: 'tool',
          scope: res.sourceId,
          key: `add_document:${res.sourceId}`,
          summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
        });
        emitEvent({
          type: 'tool_result',
          agent: 'root',
          step: 0,
          name: 'add_document',
          observation: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
          tokens: res.totalTokens,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emitEvent({
          type: 'tool_result',
          agent: 'root',
          step: 0,
          name: 'add_document',
          observation: `Failed to auto-ingest ${promptPath}: ${msg}`,
          tokens: 0,
          error: msg,
        });
      }
    }
    const engine = new raf.RecursiveAgentFold({
      rootLLM,
      ...(branchLLM !== undefined ? { branchLLM } : {}),
      queryLLM,
      store,
      board: sessionState.board,
      ingest: { cwd: process.cwd(), onIngest: persistIngested },
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
      signal,
      onEvent: emitEvent,
    });
    const result = await engine.run(effectiveQuestion);
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
    const text =
      answer !== ''
        ? answer
        : result.error !== undefined
          ? `RAF engine error: ${result.error}`
          : 'RAF engine returned no answer.';
    const total = result.usage.total();
    const byRole = result.usage.byRole();
    const rootCacheHitRate = byRole.root?.cacheHitRate ?? 0;
    const branchCacheHitRate = byRole.branch?.cacheHitRate ?? 0;
    const runUsage = {
      input: total.promptTokens,
      output: total.completionTokens,
      cached: total.cachedTokens,
      cacheHitRate: total.cacheHitRate,
      rootCacheHitRate,
      branchCacheHitRate,
      latencyMs: total.latencyMs,
      calls: total.calls,
      errors: total.errors,
    };
    runs.finish(run, {
      status: result.terminated === 'error' ? 'error' : 'done',
      termination: result.terminated,
      answer: text,
      error: result.error ?? null,
      usage: runUsage,
    });
    finished = true;
    const trace = formatTrace(events, settings, outer, runUsage);
    let index = 0;
    if (trace !== '') {
      const reasoning = `\n~~~text\n${trace}\n~~~\n`;
      yield { type: 'block-start', index, blockType: 'reasoning' };
      for (let offset = 0; offset < reasoning.length; offset += 2000) {
        yield { type: 'reasoning-delta', index, text: reasoning.slice(offset, offset + 2000) };
      }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } };
      index += 1;
    }
    yield { type: 'block-start', index, blockType: 'text' };
    for (let offset = 0; offset < text.length; offset += 2000) {
      yield { type: 'text-delta', index, text: text.slice(offset, offset + 2000) };
    }
    yield { type: 'block-end', index, block: { type: 'text', text } };
    yield {
      type: 'usage',
      usage: {
        inputTokens: total.promptTokens,
        outputTokens: total.completionTokens,
        cacheReadTokens: total.cachedTokens,
        totalTokens: total.promptTokens + total.completionTokens,
      },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } catch (error) {
    if (run !== undefined && !finished) {
      const message = error instanceof Error ? error.message : String(error);
      runs.finish(run, {
        status: signal?.aborted ? 'aborted' : 'error',
        answer: '',
        error: message,
        usage: null,
      });
    }
    if (signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const text = `RAF engine error: ${message}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
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
    // RAF answers a human request. Skip calls with synthetic messages only.
    if (!hasHumanUserMessage(Array.isArray(options.messages) ? options.messages : [])) return next();
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
