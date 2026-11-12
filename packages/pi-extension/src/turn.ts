import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AssistantMessage, JsonObject, JsonValue, Message, ThinkingContent, ToolCall, Usage } from '@earendil-works/pi-ai';
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionContext,
  ExtensionToolContext,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import {
  BRANCH_REPORT_ID_PREFIX,
  ContextStore,
  defaultRateLimitRegistry,
  extractPromptPaths,
  normalizeBranchArguments,
  RecursiveAgentFold,
  sanitizeDocId,
  type AgentEvent,
  type AgentRunResult,
  type ChatMessage,
  type IngestResult,
  type JSONSchema,
  type RateLimitCoordinator,
  type Tool,
} from '@raf/engine/source';
import type { RafConfig } from './config.js';
import {
  addUsage,
  applyCacheBreakpointsToPayload,
  ModelClient,
  PrefetchedRootClient,
  reasoningOf,
  toEngineResponse,
  toEngineUsage,
  toPiMessages,
} from './llm.js';
import type { AgentMessage } from './pi-types.js';
import type { Routes } from './routes.js';
import { geminiSafeSchema } from './schema.js';
import { contentText, renderTranscript, seedPriorTurns, type SessionState, type TurnStatus } from './state.js';
import type { CallSnapshot, RunTracker } from './tracker.js';

/** Engine limits. Synthetic wall-clock step/tool timeouts are intentionally absent. */
const ROOT_MAX_STEPS = 100;
const BRANCH_MAX_STEPS = 30;
const ROOT_MAX_OUTPUT = 16_000;
const READER_MAX_OUTPUT = 16_384;
const PROMPT_BUDGET_RATIO = 0.8;
const MAX_INVALID_STEPS = 3;
const MAX_INVALID_TOTAL = 6;
const MAX_REASONING_TOKENS = 32_000;
const MAX_OBSERVATION_TOKENS = 6400;
const WORKSPACE_MAX_FILES = 1200;
const WORKSPACE_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Native tool results longer than this are indexed as documents. */
const INDEX_RESULT_MIN_CHARS = 6000;
const UPDATE_INTERVAL_MS = 150;
/** Bound extra callable tools exposed dynamically to branch subagents. */
const MAX_EXTRA_CALLABLE_TOOLS = 24;

/** Provider native tool-call rejection errors that can recover via live FORMAT_REPAIR. */
const RECOVERABLE_TOOL_CALL_ERROR =
  /unexpected[_\s-]*tool|malformed[_\s-]*function|invalid[_\s-]*tool[_\s-]*(?:call|use)|tool[_\s-]*use[_\s-]*not[_\s-]*supported/i;

/** Read-only native tools that can execute concurrently inside specialist waves. */
const CONCURRENCY_SAFE_NATIVE: ReadonlySet<string> = new Set(
  Object.freeze(['find', 'ls', 'glob', 'web_search', 'google_search', 'websearch', 'fetch', 'webfetch']),
);

export const RAF_DOC_TOOL_OPTIONS = Object.freeze({
  maxReadLines: 500,
  maxReadTokens: 12_000,
  maxGrepMatches: 100,
});

/** RAF built-in tools. They register under bare names and shadow matching pi tools. */
export const RAF_TOOL_NAMES = Object.freeze([
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
] as const);
export type RafToolName = (typeof RAF_TOOL_NAMES)[number];

/** Competing sub-agent orchestration tools that must not recurse inside RAF. */
const BLOCKED_BRIDGE_TOOLS: ReadonlySet<string> = new Set(
  Object.freeze([
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

const RAF_NAME_SET: ReadonlySet<string> = new Set(RAF_TOOL_NAMES);

/** Return the pi tool name for an engine tool name. */
export function piToolName(engineName: string): string {
  return engineName;
}

export interface BridgeableToolsOptions {
  readonly forSubagent?: boolean;
}

/** Return native pi tools exposed to RAF agents. */
export function bridgeableTools(
  all: readonly ToolInfo[],
  active: readonly string[],
  options?: BridgeableToolsOptions,
): ToolInfo[] {
  const activeSet = new Set(active);
  const forSubagent = options?.forSubagent === true;
  return all.filter((tool) => {
    if (!activeSet.has(tool.name)) return false;
    if (RAF_NAME_SET.has(tool.name) || BLOCKED_BRIDGE_TOOLS.has(tool.name)) return false;
    if (tool.exposure === 'direct') return true;
    if (!forSubagent && tool.exposure === 'model-only') return true;
    return false;
  });
}

function newCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

function toJsonObject(args: Readonly<Record<string, unknown>>): JsonObject {
  const value: unknown = JSON.parse(JSON.stringify(args));
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function declaredTypeOf(propSchema: unknown): string | undefined {
  if (!isPlainRecord(propSchema)) return undefined;
  if (typeof propSchema.type === 'string') return propSchema.type;
  if (Array.isArray(propSchema.type)) {
    const types = propSchema.type.filter((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    if (isPlainRecord(propSchema.properties) && Object.keys(propSchema.properties).length > 0 && types.includes('object')) {
      return 'object';
    }
    if ('items' in propSchema && types.includes('array')) {
      return 'array';
    }
    if (types[0] !== undefined) return types[0];
  }
  return undefined;
}

function coerceValue(value: JsonValue | undefined, propSchema: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  const expected = declaredTypeOf(propSchema);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if ((expected === 'number' || expected === 'integer') && trimmed !== '') {
      const parsed = Number(trimmed);
      if (Number.isFinite(parsed) && (expected === 'number' || Number.isInteger(parsed))) return parsed;
    }
    if (expected === 'boolean') {
      if (trimmed === 'true') return true;
      if (trimmed === 'false') return false;
    }
    if ((expected === 'array' || expected === 'object') && (trimmed.startsWith('[') || trimmed.startsWith('{'))) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (expected === 'array' && Array.isArray(parsed)) return parsed as JsonValue;
        if (expected === 'object' && isPlainRecord(parsed)) return parsed as JsonObject;
      } catch {
        return value;
      }
    }
  }
  return value;
}

function normalizeEditEntry(entry: JsonValue): JsonValue {
  if (!isPlainRecord(entry)) return entry;
  const next: JsonObject = { ...(entry as JsonObject) };
  if (next.oldText === undefined && typeof next.old_string === 'string') {
    next.oldText = next.old_string;
    delete next.old_string;
  }
  if (next.newText === undefined && typeof next.new_string === 'string') {
    next.newText = next.new_string;
    delete next.new_string;
  }
  return next;
}

/** Normalize parsed protocol arguments to match a native tool JSON Schema. */
export function fitArguments(args: JsonObject, schema: unknown): JsonObject {
  if (!isPlainRecord(schema)) return args;
  const props = isPlainRecord(schema.properties) ? schema.properties : undefined;
  if (props === undefined) return args;

  const baseArgs =
    'tasks' in props && ('scope' in props || 'task' in props)
      ? toJsonObject(normalizeBranchArguments(args))
      : args;
  const working: JsonObject = { ...baseArgs };
  const consumedAliases = new Set<string>();

  if ('path' in props && working.path === undefined) {
    if (typeof working.file_path === 'string') {
      working.path = working.file_path;
      consumedAliases.add('file_path');
    } else if (typeof working.document === 'string') {
      working.path = working.document;
      consumedAliases.add('document');
    }
  } else if ('file_path' in props && working.file_path === undefined && typeof working.path === 'string') {
    working.file_path = working.path;
    consumedAliases.add('path');
  }

  if ('offset' in props && working.offset === undefined) {
    if (working.start_line !== undefined) {
      working.offset = working.start_line;
      consumedAliases.add('start_line');
    } else if (working.end_line !== undefined) {
      working.offset = 1;
    }
  }

  if ('limit' in props && working.limit === undefined) {
    if (working.max_matches !== undefined) {
      working.limit = working.max_matches;
      consumedAliases.add('max_matches');
    } else if (working.end_line !== undefined) {
      const s = Number(working.offset ?? working.start_line ?? 1);
      const e = Number(working.end_line);
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
        working.limit = e - s + 1;
        consumedAliases.add('end_line');
      }
    }
  }

  if ('ignoreCase' in props && working.ignoreCase === undefined && typeof working.case_sensitive === 'boolean') {
    working.ignoreCase = !working.case_sensitive;
    consumedAliases.add('case_sensitive');
  }

  if ('edits' in props && working.edits === undefined) {
    const oldText =
      typeof working.oldText === 'string'
        ? working.oldText
        : typeof working.old_string === 'string'
          ? working.old_string
          : undefined;
    const newText =
      typeof working.newText === 'string'
        ? working.newText
        : typeof working.new_string === 'string'
          ? working.new_string
          : undefined;
    if (oldText !== undefined && newText !== undefined) {
      working.edits = [{ oldText, newText }];
      consumedAliases.add('oldText');
      consumedAliases.add('newText');
      consumedAliases.add('old_string');
      consumedAliases.add('new_string');
    }
  }

  for (const key of consumedAliases) {
    if (!(key in props)) delete working[key];
  }

  for (const [key, propSchema] of Object.entries(props)) {
    if (!(key in working)) continue;
    const coerced = coerceValue(working[key], propSchema);
    if (coerced !== undefined) working[key] = coerced;
  }

  if ('edits' in props && Array.isArray(working.edits)) {
    working.edits = working.edits.map((item) => normalizeEditEntry(item));
  }

  if (schema.additionalProperties !== false) return working;
  const allowed = new Set(Object.keys(props));
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(working)) {
    if (allowed.has(key) && value !== undefined) out[key] = value;
  }
  return out;
}

function resultText(content: readonly { readonly type: string }[], isError: boolean): string {
  const text = contentText(content);
  if (!isError) return text === '' ? '(completed with no output)' : text;
  return `Tool error: ${text === '' ? 'tool failed' : text}`;
}

function latestCheckpoint(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === 'compaction' && entry.summary.trim() !== '') return entry.summary.trim();
  }
  return '';
}

export interface TurnInit {
  readonly ctx: ExtensionContext;
  readonly config: RafConfig;
  readonly routes: Routes;
  readonly session: SessionState;
  readonly tracker: RunTracker;
  readonly prompt: string;
  readonly nativeTools: readonly ToolInfo[];
  readonly getSubagentTools?: () => readonly ToolInfo[];
  readonly history: readonly AgentMessage[];
}

export interface RafToolDetails {
  readonly tool: string;
  readonly call?: CallSnapshot;
  readonly lines: number;
  readonly chars: number;
}

export type StepOutcome =
  | { readonly kind: 'tool'; readonly replacement: AssistantMessage }
  | { readonly kind: 'final'; readonly replacement: AssistantMessage; readonly status: TurnStatus; readonly result: AgentRunResult };

interface ActiveToolCall {
  readonly ctx: ExtensionToolContext;
  usage: Usage | undefined;
}

const activeCallStorage = new AsyncLocalStorage<ActiveToolCall>();

/**
 * One RAF turn: from a user prompt to the final answer.
 */
export class RafTurn {
  readonly question: string;
  readonly routes: Routes;
  readonly startedAt = Date.now();
  private readonly session: SessionState;
  private readonly tracker: RunTracker;
  private readonly store: ContextStore;
  private readonly engine: RecursiveAgentFold;
  private readonly root: PrefetchedRootClient;
  private readonly tools = new Map<string, Tool>();
  private readonly controller = new AbortController();
  private readonly linked = new WeakSet<AbortSignal>();
  private readonly workspace: string;
  private readonly detachRateLimit: () => void;
  private prepared?: ChatMessage[];
  private lastPrepared?: readonly ChatMessage[];
  private awaiting = false;
  private pendingCallIds: readonly string[] = [];
  private step = 0;
  private readonly fallbackToolCalls: ActiveToolCall[] = [];
  private extraRootUsage: Usage[] = [];
  private lastError?: string;
  private finished = false;

  private constructor(
    init: TurnInit,
    store: ContextStore,
    question: string,
    rootTools: readonly Tool[],
    resolveSubagentTools: () => readonly Tool[],
  ) {
    this.question = question;
    this.routes = init.routes;
    this.session = init.session;
    this.tracker = init.tracker;
    this.store = store;
    this.workspace = init.ctx.cwd;

    const { root, branch, reader } = init.routes;
    const rootGate = defaultRateLimitRegistry.get(root.model.provider);
    const branchGate = defaultRateLimitRegistry.get(branch.model.provider);
    const readerGate = defaultRateLimitRegistry.get(reader.model.provider);
    const uniqueGates = new Set<RateLimitCoordinator>([rootGate, branchGate, readerGate]);

    const onRateLimited = (ev: { readonly rateLimitUntil?: number }) => {
      if (typeof ev.rateLimitUntil === 'number') this.tracker.setRateLimit(ev.rateLimitUntil);
    };
    const onRateResumed = () => {
      this.tracker.setRateLimit(0);
    };
    for (const gate of uniqueGates) {
      gate.on('rate:limited', onRateLimited);
      gate.on('rate:resumed', onRateResumed);
    }
    this.detachRateLimit = () => {
      for (const gate of uniqueGates) {
        gate.off('rate:limited', onRateLimited);
        gate.off('rate:resumed', onRateResumed);
      }
      this.tracker.setRateLimit(0);
    };

    const registry = init.ctx.modelRegistry;
    const sessionId = init.ctx.sessionManager.getSessionId();
    const rootThinking = reasoningOf(root.thinking);
    const rootLive = new ModelClient({
      registry,
      model: root.model,
      maxOutputTokens: ROOT_MAX_OUTPUT,
      sessionId,
      rateLimitGate: rootGate,
      ...(rootThinking !== undefined ? { reasoning: rootThinking } : {}),
      onUsage: (usage) => this.extraRootUsage.push(usage),
    });
    this.root = new PrefetchedRootClient(rootLive);

    const branchThinking = reasoningOf(branch.thinking);
    const branchLLM = new ModelClient({
      registry,
      model: branch.model,
      maxOutputTokens: ROOT_MAX_OUTPUT,
      sessionId,
      disableContinuation: true,
      rateLimitGate: branchGate,
      ...(branchThinking !== undefined ? { reasoning: branchThinking } : {}),
      onUsage: (usage) => {
        init.tracker.addCost('branch', usage.cost.total);
        this.recordNestedUsage(usage);
      },
    });

    const readerThinking = reasoningOf(reader.thinking);
    const queryLLM = new ModelClient({
      registry,
      model: reader.model,
      maxOutputTokens: READER_MAX_OUTPUT,
      sessionId,
      disableContinuation: true,
      rateLimitGate: readerGate,
      ...(readerThinking !== undefined ? { reasoning: readerThinking } : {}),
      onUsage: (usage) => {
        init.tracker.addCost('llm_query', usage.cost.total);
        this.recordNestedUsage(usage);
      },
      onStart: () => init.tracker.readerStarted(),
      onEnd: () => init.tracker.readerEnded(),
    });

    const contextWindow = root.model.contextWindow;
    this.engine = new RecursiveAgentFold({
      rootLLM: this.root,
      branchLLM,
      queryLLM,
      store,
      board: init.session.board,
      clearTransientOnRun: false,
      ingest: { cwd: this.workspace, onIngest: (res) => this.keepIngested(res, true) },
      documentTools: RAF_DOC_TOOL_OPTIONS,
      maxDepth: init.config.depth,
      agent: {
        temperature: 0,
        maxObservationTokens: MAX_OBSERVATION_TOKENS,
        maxInvalidSteps: MAX_INVALID_STEPS,
        maxInvalidTotal: MAX_INVALID_TOTAL,
        maxReasoningTokens: MAX_REASONING_TOKENS,
        ...(contextWindow > 0 ? { maxPromptTokens: Math.floor(contextWindow * PROMPT_BUDGET_RATIO) } : {}),
      },
      llmQuery: {
        reserveRatio: init.config.reserve,
        concurrency: init.config.concurrency,
        temperature: 0,
        cache: init.session.cache,
      },
      rootMaxSteps: ROOT_MAX_STEPS,
      branchMaxSteps: BRANCH_MAX_STEPS,
      branchConcurrency: init.config.concurrency,
      extraTools: (depth) => (depth === 0 ? rootTools : resolveSubagentTools()),
      signal: this.controller.signal,
      onEvent: (event) => this.onEvent(event),
    });
    for (const tool of this.engine.toolsFor(0)) this.tools.set(tool.name, tool);
  }

  /** Build a turn: index documents, restore carried-over state, and begin the root agent. */
  static async create(init: TurnInit): Promise<RafTurn> {
    const { ctx, config, session } = init;
    let question = init.prompt.trim() === '' ? 'Answer the latest request.' : init.prompt;
    if (session.rootState === undefined) {
      const checkpoint = latestCheckpoint(ctx);
      if (checkpoint !== '') {
        question += `\n\n### Prior context (compacted)\n${checkpoint}\n\nContinue from this prior state without redoing completed work.`;
      }
    }
    const store = new ContextStore();
    if (session.rootState === undefined) {
      const transcript = renderTranscript(init.history);
      if (transcript !== '') store.add(transcript, { id: 'session', title: 'pi session transcript' });
    }
    for (const [id, doc] of session.docs) {
      try {
        const isReport = id.startsWith(BRANCH_REPORT_ID_PREFIX);
        store.add(doc.text, { id, title: doc.title, manifest: !isReport, transient: isReport });
      } catch {
        session.docs.delete(id);
      }
    }
    const holder: { turn?: RafTurn } = {};
    const rootTools = Object.freeze(init.nativeTools.map((info) => bridgeTool(info, () => holder.turn)));
    const resolveSubagentTools = (): readonly Tool[] => {
      const turnRef = holder.turn;
      const baseInfos =
        init.getSubagentTools !== undefined
          ? init.getSubagentTools()
          : init.nativeTools.filter((info) => info.exposure === 'direct');
      const byName = new Map<string, Tool>();
      for (const info of baseInfos) {
        if (RAF_NAME_SET.has(info.name) || BLOCKED_BRIDGE_TOOLS.has(info.name)) continue;
        byName.set(info.name, bridgeTool(info, () => holder.turn));
      }
      const callable = turnRef?.currentToolCtx()?.tools;
      if (callable !== undefined) {
        let added = 0;
        for (const agentTool of callable) {
          if (added >= MAX_EXTRA_CALLABLE_TOOLS) break;
          if (byName.has(agentTool.name) || RAF_NAME_SET.has(agentTool.name) || BLOCKED_BRIDGE_TOOLS.has(agentTool.name)) {
            continue;
          }
          byName.set(
            agentTool.name,
            bridgeTool(
              {
                name: agentTool.name,
                description: agentTool.description,
                parameters: agentTool.parameters as JSONSchema,
              },
              () => holder.turn,
            ),
          );
          added += 1;
        }
      }
      return [...byName.values()];
    };
    const turn = new RafTurn(init, store, question, rootTools, resolveSubagentTools);
    holder.turn = turn;
    await turn.index(config, ctx.signal);
    if (init.history.length > 0 && session.rootState === undefined) {
      const seeded = seedPriorTurns(init.history);
      if (seeded !== undefined) {
        session.initialQuestion ??= seeded.initialQuestion;
        session.rootState = seeded.rootState;
      }
    }
    session.initialQuestion ??= question;
    if (session.initialManifest === undefined) {
      session.initialManifest = store.manifest();
      const docIds = new Set<string>();
      const docRevs: Record<string, number> = {};
      for (const doc of store.listManifest()) {
        docIds.add(doc.id);
        docRevs[doc.id] = doc.rev;
      }
      session.initialDocIds = docIds;
      session.initialDocRevs = Object.freeze(docRevs);
    }
    if (session.initialBoardRev === undefined) {
      const rev = session.board.settledRev();
      session.initialBoardRev = rev;
      if (rev > 0) session.initialBoardSnapshot = session.board.renderSettled();
    }
    turn.begin(question, init.history);
    return turn;
  }

  private currentActiveCall(): ActiveToolCall | undefined {
    return activeCallStorage.getStore() ?? this.fallbackToolCalls[this.fallbackToolCalls.length - 1];
  }

  private currentToolCtx(): ExtensionToolContext | undefined {
    return this.currentActiveCall()?.ctx;
  }

  private recordNestedUsage(usage: Usage): void {
    const active = this.currentActiveCall();
    if (active === undefined) return;
    active.usage = active.usage === undefined ? usage : addUsage(active.usage, usage);
  }

  private async index(config: RafConfig, signal: AbortSignal | undefined): Promise<void> {
    const session = this.session;
    if (config.indexWorkspace && !session.workspaceIngested) {
      session.workspaceIngested = true;
      try {
        const res = await this.store.addPath(this.workspace, {
          cwd: this.workspace,
          idPrefix: '',
          maxFiles: WORKSPACE_MAX_FILES,
          maxWalkFileBytes: WORKSPACE_MAX_FILE_BYTES,
          skipRichDocuments: true,
          ...(signal !== undefined ? { signal } : {}),
        });
        this.keepIngested(res, false);
        session.sources.add(this.workspace);
      } catch {
        // An empty or unreadable workspace is not fatal.
      }
    }
    const promptPaths = extractPromptPaths(this.question, this.workspace).filter((p) => !session.sources.has(p));
    if (promptPaths.length > 0) {
      const results = await this.store.addPaths(promptPaths, {
        cwd: this.workspace,
        ...(signal !== undefined ? { signal } : {}),
      });
      for (const res of results) {
        this.keepIngested(res, true);
        session.sources.add(res.resolvedPath);
        session.board.record({
          agent: 'root',
          kind: 'tool',
          scope: res.sourceId,
          key: `add_document:${res.sourceId}`,
          summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
        });
      }
    }
  }

  private keepIngested(res: IngestResult, persist: boolean): void {
    for (const file of res.files) {
      this.session.docs.set(file.id, { title: file.title, text: file.content, persist });
    }
  }

  private begin(question: string, history: readonly AgentMessage[]): void {
    const session = this.session;
    this.tracker.startRun();
    const frozen = {
      ...(session.initialManifest !== undefined ? { initialManifest: session.initialManifest } : {}),
      ...(session.initialDocIds !== undefined ? { initialDocIds: session.initialDocIds } : {}),
      ...(session.initialDocRevs !== undefined ? { initialDocRevs: session.initialDocRevs } : {}),
      ...(session.initialBoardRev !== undefined ? { initialBoardRev: session.initialBoardRev } : {}),
      ...(session.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: session.initialBoardSnapshot } : {}),
    };
    if (session.rootState !== undefined) {
      this.engine.begin(session.initialQuestion ?? question, {
        initialState: session.rootState,
        followUpQuestion: question,
        ...frozen,
      });
    } else {
      this.engine.begin(question, frozen);
    }
    const pending = session.pending;
    session.pending = undefined;
    if (pending === undefined || session.rootState === undefined) return;
    const callIds = pending.callIds && pending.callIds.length > 0 ? pending.callIds : [pending.callId];
    const results: FoundResult[] = [];
    for (const cid of callIds) {
      const r = findToolResult(history, cid);
      if (r === undefined) return;
      results.push(r);
    }
    try {
      this.engine.restorePending({
        step: pending.step,
        motivation: pending.motivation,
        action: pending.action,
        ...(pending.actions !== undefined ? { actions: pending.actions } : {}),
      });
      const texts = results.map((r) => r.text);
      const firstErr = results.find((r) => r.isError)?.text;
      this.engine.submit(
        texts.length === 1 ? (texts[0] ?? '') : texts,
        firstErr !== undefined ? { error: firstErr } : undefined,
      );
    } catch {
      // Drop any pending step that no longer matches the fold state.
    }
  }

  private onEvent(event: AgentEvent): void {
    this.tracker.apply(event);
    if (event.type === 'branch_report') this.captureReports();
  }

  private captureReports(): void {
    for (const doc of this.store.list()) {
      if (!doc.id.startsWith(BRANCH_REPORT_ID_PREFIX) || this.session.docs.has(doc.id)) continue;
      this.session.docs.set(doc.id, { title: doc.title, text: doc.lines.join('\n'), persist: true });
    }
  }

  /** Abort engine work when pi aborts the run. */
  link(signal: AbortSignal | undefined): void {
    if (signal === undefined || this.linked.has(signal)) return;
    this.linked.add(signal);
    if (signal.aborted) this.controller.abort(signal.reason);
    else signal.addEventListener('abort', () => this.controller.abort(signal.reason), { once: true });
  }

  get done(): boolean {
    return this.finished;
  }

  get currentStep(): number {
    return this.step;
  }

  /** Apply 4-zone Anthropic cache_control breakpoints to the native root payload. */
  decorateProviderPayload(payload: unknown): unknown {
    if (!this.awaiting || this.lastPrepared === undefined) return undefined;
    return applyCacheBreakpointsToPayload(payload, this.lastPrepared, this.routes.root.model);
  }

  /** Return true when ContextStore holds virtual or external documents. */
  hasVirtualDocs(): boolean {
    for (const doc of this.store.list()) {
      if (doc.id === 'session' || doc.id.startsWith(BRANCH_REPORT_ID_PREFIX) || doc.id.startsWith('tool_')) {
        return true;
      }
      if (this.session.docs.get(doc.id)?.persist === true) return true;
    }
    return false;
  }

  /** Replace the native request with the AgentFold context. */
  prepareRequest(messages: readonly AgentMessage[]): Message[] {
    if (this.pendingCallIds.length > 0) this.submitObservations(messages, this.pendingCallIds);
    const prepared = this.engine.prepareRootMessages();
    this.prepared = prepared;
    this.lastPrepared = prepared;
    this.awaiting = true;
    this.tracker.rootRequest();
    return toPiMessages(prepared, this.routes.root.model);
  }

  private submitObservations(messages: readonly AgentMessage[], callIds: readonly string[]): void {
    const observations: string[] = new Array(callIds.length);
    const errors: string[] = [];
    for (let i = 0; i < callIds.length; i++) {
      const cid = callIds[i];
      const found = cid !== undefined ? findToolResult(messages, cid) : undefined;
      if (found === undefined) {
        observations[i] = 'Error: tool result missing';
      } else {
        observations[i] = this.indexResult(found.toolName, found.args, found.text, found.isError);
        if (found.isError) errors.push(found.text);
      }
    }
    const lastId = callIds[callIds.length - 1];
    const steering = lastId !== undefined ? steeringAfter(messages, lastId) : '';
    if (steering !== '' && observations.length > 0) {
      const lastIdx = observations.length - 1;
      observations[lastIdx] = `${observations[lastIdx] ?? ''}\n\n[User message during this step]\n${steering}`;
    }
    this.engine.submit(
      observations.length === 1 ? (observations[0] ?? '') : observations,
      errors.length > 0 ? { error: errors.join('; ') } : undefined,
    );
    this.pendingCallIds = [];
  }

  private nextIndexedId(toolName: string): string {
    for (;;) {
      this.session.docSeq += 1;
      const candidate = sanitizeDocId(`tool_${toolName}_${this.session.docSeq}`);
      if (!this.store.has(candidate) && !this.session.docs.has(candidate)) return candidate;
    }
  }

  /** Index large native results and synchronize workspace files after write, edit, or bash. */
  indexResult(toolName: string, args: Readonly<Record<string, unknown>>, text: string, isError: boolean): string {
    if (toolName === 'bash') {
      this.refreshModifiedWorkspaceFiles();
    }
    if (isError) return text;
    if (toolName === 'write' || toolName === 'edit') {
      const target = args.path ?? args.file_path;
      if (typeof target === 'string' && target.trim() !== '') this.refreshFile(target);
      return text;
    }
    if (RAF_NAME_SET.has(toolName)) return text;
    if (text.length < INDEX_RESULT_MIN_CHARS) return text;
    const label = String(args.url ?? args.path ?? args.query ?? args.command ?? toolName);
    const id = this.nextIndexedId(toolName);
    try {
      const doc = this.store.add(text, { id, title: `${toolName}: ${label.slice(0, 120)}` });
      this.session.docs.set(id, { title: doc.title, text, persist: true });
      return `[Indexed in ContextStore as document "${id}" (${doc.lines.length} lines, ~${doc.tokens} tokens) — use search, outline, grep, tally, read, branch(scope="${id}"), or llm_query on "${id}"]\n${text}`;
    } catch {
      return text;
    }
  }

  private refreshFile(target: string): void {
    try {
      const abs = isAbsolute(target) ? resolve(target) : resolve(this.workspace, target);
      const st = statSync(abs, { throwIfNoEntry: false });
      if (!st || !st.isFile()) return;
      const existing = this.store.findByAbsPath(abs);
      if (
        existing !== undefined &&
        existing.mtimeMs === st.mtimeMs &&
        existing.byteSize === st.size &&
        Math.abs(Date.now() - st.mtimeMs) >= 15
      ) {
        return;
      }
      const rel = relative(this.workspace, abs);
      const id =
        existing?.id ?? sanitizeDocId(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target);
      const text = readFileSync(abs, 'utf8');
      this.store.add(text, { id, title: target, absPath: abs, mtimeMs: st.mtimeMs, byteSize: st.size });
      this.session.docs.set(id, { title: target, text, persist: false });
    } catch {
      // Unreadable files wait for the next read call.
    }
  }

  private refreshModifiedWorkspaceFiles(): void {
    for (const doc of this.store.listManifest()) {
      if (doc.absPath === undefined) continue;
      try {
        const st = statSync(doc.absPath, { throwIfNoEntry: false });
        if (!st || !st.isFile()) continue;
        if (doc.mtimeMs === st.mtimeMs && doc.byteSize === st.size) continue;
        const text = readFileSync(doc.absPath, 'utf8');
        this.store.add(text, {
          id: doc.id,
          title: doc.title,
          absPath: doc.absPath,
          mtimeMs: st.mtimeMs,
          byteSize: st.size,
        });
        this.session.docs.set(doc.id, { title: doc.title, text, persist: false });
      } catch {
        // Ignore deleted or binary files modified during shell commands.
      }
    }
  }

  /** Turn the native response into one RAF step (supporting parallel multi-tool batches). */
  async acceptResponse(message: AssistantMessage, signal: AbortSignal | undefined): Promise<StepOutcome | undefined> {
    if (!this.awaiting) return undefined;
    this.awaiting = false;
    this.link(signal);
    const recoverableToolErr =
      message.stopReason === 'error' &&
      signal?.aborted !== true &&
      RECOVERABLE_TOOL_CALL_ERROR.test(message.errorMessage ?? '');

    if ((message.stopReason === 'error' && !recoverableToolErr) || message.stopReason === 'aborted') {
      this.root.clear();
      this.lastPrepared = undefined;
      if (message.stopReason === 'error') this.lastError = message.errorMessage;
      return undefined;
    }

    this.tracker.addCost('root', message.usage.cost.total);
    if (this.prepared !== undefined) {
      if (recoverableToolErr) {
        this.root.prefetch(this.prepared, {
          text: '',
          model: message.responseModel ?? message.model,
          latencyMs: message.durationMs ?? 0,
          usage: toEngineUsage(message.usage),
          finishReason: 'error',
        });
      } else {
        this.root.prefetch(this.prepared, toEngineResponse(message));
      }
    }
    this.prepared = undefined;
    this.lastPrepared = undefined;
    this.extraRootUsage = [];
    let usage: Usage = message.usage;
    try {
      const step = await this.engine.next();
      usage = this.extraRootUsage.reduce(addUsage, message.usage);
      for (const extra of this.extraRootUsage) this.tracker.addCost('root', extra.cost.total);
      const thinking = thinkingBlocks(message, step.kind === 'done' ? undefined : step.reasoning);
      if (step.kind === 'tool') {
        this.step = step.step;
        const actions = step.actions.length > 0 ? step.actions : [step.action];
        const callBlocks: ToolCall[] = new Array(actions.length);
        const callIds: string[] = new Array(actions.length);
        for (let i = 0; i < actions.length; i++) {
          const act = actions[i] ?? step.action;
          const name = piToolName(act.name);
          const schema = this.tools.get(act.name)?.parameters;
          const args = fitArguments(toJsonObject(act.arguments), schema);
          const cid = newCallId();
          callIds[i] = cid;
          callBlocks[i] = { type: 'toolCall', id: cid, name, arguments: args };
        }
        this.pendingCallIds = callIds;
        this.session.pending = {
          callId: callIds[0] ?? newCallId(),
          callIds,
          step: step.step,
          motivation: step.motivation,
          action: step.action,
          actions,
        };
        const motivation = step.motivation.trim();
        return {
          kind: 'tool',
          replacement: {
            ...message,
            content: [
              ...thinking,
              ...(motivation !== '' ? [{ type: 'text' as const, text: motivation }] : []),
              ...callBlocks,
            ],
            stopReason: 'toolUse',
            usage,
          },
        };
      }
      if (step.kind === 'answer') {
        return this.final({ ...message, usage }, step.answer, 'done', step.result, thinking);
      }
      const answer = step.result.answer ?? '';
      if (answer !== '') return this.final({ ...message, usage }, answer, 'done', step.result);
      this.lastError = step.result.error ?? 'RAF engine returned no answer';
      const fallback = this.controller.signal.aborted ? undefined : this.fallbackAnswer();
      return this.final(
        { ...message, usage },
        fallback ?? this.failureText(this.lastError),
        fallback === undefined ? 'error' : 'done',
        step.result,
      );
    } catch (error) {
      this.pendingCallIds = [];
      this.session.pending = undefined;
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.controller.signal.aborted) return undefined;
      return this.final({ ...message, usage }, this.failureText(this.lastError), 'error', undefined);
    }
  }

  private final(
    message: AssistantMessage,
    text: string,
    status: TurnStatus,
    result: AgentRunResult | undefined,
    thinking: ThinkingContent[] = [],
  ): StepOutcome {
    this.session.pending = undefined;
    const snapshot = result?.state ?? this.engine.snapshot();
    if (snapshot !== undefined) this.session.rootState = snapshot;
    const replacement: AssistantMessage = {
      ...message,
      content: [...thinking, { type: 'text', text }],
      stopReason: 'stop',
    };
    const finalResult: AgentRunResult = result ?? {
      answer: null,
      steps: this.step,
      terminated: 'error',
      state: snapshot ?? { blocks: [] },
      usage: this.engine.usage,
      formatIssues: 0,
      ...(this.lastError !== undefined ? { error: this.lastError } : {}),
    };
    return { kind: 'final', replacement, status, result: finalResult };
  }

  private failureText(error: string): string {
    return `RAF stopped without a final answer: ${error}`;
  }

  private fallbackAnswer(): string | undefined {
    const sections: string[] = [];
    const seen = new Set<string>();
    for (const entry of this.session.board.entries()) {
      if (entry.kind !== 'branch' || entry.inProgress === true || entry.summary.includes(': failed —')) continue;
      const scope = entry.scope || entry.key;
      if (seen.has(scope)) continue;
      seen.add(scope);
      sections.push(`## ${scope}\n${entry.summary.length > 2000 ? `${entry.summary.slice(0, 2000)}…` : entry.summary}`);
    }
    for (const doc of this.store.list()) {
      if (!doc.id.startsWith(BRANCH_REPORT_ID_PREFIX) || seen.has(doc.id)) continue;
      const scope = doc.title.replace(/^branch report:\s*/i, '').trim();
      if (scope !== '' && seen.has(scope)) continue;
      const body = doc.lines.join('\n');
      if (body.trim() === '') continue;
      seen.add(doc.id);
      sections.push(`## ${doc.title}\n${body.length > 2000 ? `${body.slice(0, 2000)}…` : body}`);
    }
    if (sections.length === 0) return undefined;
    const gap = this.lastError !== undefined ? `\n\n## Uncovered Scopes & Errors\n${this.lastError}` : '';
    return `# Final Report (Saved Branch Results)\n\nRoot did not produce a final answer; saved specialist reports are listed below.\n\n${sections.join('\n\n')}${gap}`;
  }

  /** Execute a RAF built-in tool inside an isolated AsyncLocalStorage frame. */
  async executeTool(
    name: RafToolName,
    params: Record<string, unknown>,
    toolCallId: string,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<RafToolDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<RafToolDetails>> {
    const tool = this.tools.get(name);
    if (tool === undefined) throw new Error(`RAF tool ${name} is not available in this turn`);
    this.link(signal);
    const frame: ActiveToolCall = { ctx, usage: undefined };
    this.fallbackToolCalls.push(frame);
    this.tracker.beginCall(toolCallId, name);
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      timer = undefined;
      last = Date.now();
      const call = this.tracker.callSnapshot(toolCallId);
      onUpdate?.({
        content: [{ type: 'text', text: progressLine(call) }],
        details: { tool: name, ...(call !== undefined ? { call } : {}), lines: 0, chars: 0 },
      });
    };
    const unsubscribe =
      onUpdate === undefined
        ? () => {}
        : this.tracker.subscribe(() => {
            if (timer !== undefined) return;
            timer = setTimeout(push, Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - last)));
          });
    try {
      const observation = await activeCallStorage.run(frame, () =>
        tool.execute(params, {
          store: this.store,
          usage: this.engine.usage,
          depth: 0,
          agentName: 'root',
          step: this.step,
          emit: (event) => this.onEvent(event),
          signal: this.controller.signal,
          board: this.session.board,
          ancestorTasks: [this.question],
        }),
      );
      this.captureReports();
      this.tracker.endCall(toolCallId);
      const call = this.tracker.callSnapshot(toolCallId);
      return {
        content: [{ type: 'text', text: observation }],
        ...(frame.usage !== undefined ? { usage: frame.usage } : {}),
        details: {
          tool: name,
          ...(call !== undefined && (call.agents.length > 0 || call.queries.length > 0) ? { call } : {}),
          lines: observation.split('\n').length,
          chars: observation.length,
        },
      };
    } catch (error) {
      this.captureReports();
      this.tracker.endCall(toolCallId);
      const call = this.tracker.callSnapshot(toolCallId);
      if (call !== undefined && (call.agents.length > 0 || call.queries.length > 0)) {
        onUpdate?.({
          content: [{ type: 'text', text: progressLine(call) }],
          details: { tool: name, call, lines: 0, chars: 0 },
        });
      }
      throw error;
    } finally {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      this.tracker.endCall(toolCallId);
      const idx = this.fallbackToolCalls.lastIndexOf(frame);
      if (idx !== -1) this.fallbackToolCalls.splice(idx, 1);
    }
  }

  /** Run a native pi tool for a branch sub-agent through pi's validation and hooks. */
  async runNative(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string> {
    const ctx = this.currentToolCtx();
    if (ctx === undefined) throw new Error(`${name} can run only inside a RAF tool call`);
    const outcome = await ctx.executeTool(name, args, signal !== undefined ? { signal } : {});
    const text = resultText(outcome.result.content, outcome.isError);
    return this.indexResult(name, args, text, outcome.isError);
  }

  /** End the turn and abort any unfinished background work. */
  finish(status: TurnStatus): void {
    if (this.finished) return;
    this.finished = true;
    this.detachRateLimit();
    const snapshot = this.engine.snapshot();
    if (snapshot !== undefined) this.session.rootState = snapshot;
    if (status === 'done' || status === 'error') {
      this.session.pending = undefined;
    } else if (status === 'aborted') {
      const hasProgress = (snapshot?.blocks.length ?? 0) > 0 || snapshot?.latest !== undefined;
      if (!hasProgress) this.session.pending = undefined;
    }
    this.captureReports();
    this.root.clear();
    this.lastPrepared = undefined;
    if (!this.controller.signal.aborted) this.controller.abort(new Error(`RAF turn ${status}`));
    this.tracker.endRun();
  }

  get error(): string | undefined {
    return this.lastError;
  }
}

function thinkingBlocks(message: AssistantMessage, reasoning: string | undefined): ThinkingContent[] {
  const native = message.content.filter((block): block is ThinkingContent => block.type === 'thinking');
  if (native.length > 0) return native;
  return reasoning !== undefined && reasoning.trim() !== '' ? [{ type: 'thinking', thinking: reasoning }] : [];
}

interface FoundResult {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly text: string;
  readonly isError: boolean;
}

function findToolResult(messages: readonly AgentMessage[], callId: string): FoundResult | undefined {
  let args: Readonly<Record<string, unknown>> = {};
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.id === callId) args = block.arguments;
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'toolResult' || message.toolCallId !== callId) continue;
    return {
      toolName: message.toolName,
      args,
      text: resultText(message.content, message.isError),
      isError: message.isError,
    };
  }
  return undefined;
}

function steeringAfter(messages: readonly AgentMessage[], callId: string): string {
  const start = messages.findIndex(
    (message) => message.role === 'assistant' && message.content.some((block) => block.type === 'toolCall' && block.id === callId),
  );
  if (start < 0) return '';
  const parts: string[] = [];
  for (let i = start + 1; i < messages.length; i++) {
    const message = messages[i];
    if (message?.role === 'user') {
      const text = contentText(message.content);
      if (text !== '') parts.push(text);
    }
  }
  return parts.join('\n\n');
}

interface BridgeableShape {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

function bridgeTool(info: BridgeableShape, turn: () => RafTurn | undefined): Tool {
  const safe = CONCURRENCY_SAFE_NATIVE.has(info.name.toLowerCase());
  return {
    name: info.name,
    description: info.description,
    parameters: geminiSafeSchema(info.parameters) as JSONSchema,
    ...(safe ? { isConcurrencySafe: () => true } : {}),
    async execute(args, toolCtx) {
      const current = turn();
      if (current === undefined) throw new Error(`${info.name}: RAF turn is not active`);
      const fitted = fitArguments(toJsonObject(args), info.parameters);
      return current.runNative(info.name, fitted, toolCtx.signal);
    },
  };
}

export function progressLine(call: CallSnapshot | undefined): string {
  if (call === undefined) return 'running…';
  const running = call.agents.filter((agent) => agent.status === 'running').length;
  const done = call.agents.filter((agent) => agent.status === 'done').length;
  const parts: string[] = [];
  if (call.agents.length > 0) parts.push(`${running} running, ${done}/${call.agents.length} done`);
  if (call.readerDone + call.readerActive > 0) parts.push(`${call.readerDone} chunks read, ${call.readerActive} reading`);
  return parts.length === 0 ? 'running…' : parts.join(' · ');
}
