import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AssistantMessage, JsonObject, JsonValue, Message, ThinkingContent, Usage } from '@earendil-works/pi-ai';
import type { AgentToolResult, AgentToolUpdateCallback, ExtensionContext, ExtensionToolContext, ToolInfo } from '@earendil-works/pi-coding-agent';
import {
  BRANCH_REPORT_ID_PREFIX,
  ContextStore,
  defaultRateLimitGate,
  RecursiveAgentFold,
  extractPromptPaths,
  sanitizeDocId,
  type AgentEvent,
  type AgentRunResult,
  type ChatMessage,
  type IngestResult,
  type JSONSchema,
  type Tool,
} from '@raf/engine';
import type { RafConfig } from './config.js';
import { addUsage, ModelClient, PrefetchedRootClient, reasoningOf, toEngineResponse, toPiMessages } from './llm.js';
import type { AgentMessage } from './pi-types.js';
import type { Routes } from './routes.js';
import { contentText, renderTranscript, seedPriorTurns, type SessionState, type TurnStatus } from './state.js';
import type { CallSnapshot, RunTracker } from './tracker.js';

/** Engine limits. They match the tuned DSH host settings. */
const ROOT_MAX_STEPS = 100;
const BRANCH_MAX_STEPS = 20;
const ROOT_MAX_OUTPUT = 16_000;
const READER_MAX_OUTPUT = 16_384;
const PROMPT_BUDGET_RATIO = 0.6;
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

/** RAF built-in tools. They register under these bare names and replace the pi tool of the same name. */
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

/** Native pi tools that RAF never bridges into the engine: competing sub-agent tooling would recurse. */
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

/** pi tool name for an engine tool name. RAF tools keep the native name, so pi's tool is replaced. */
export function piToolName(engineName: string): string {
  return engineName;
}

export interface BridgeableToolsOptions {
  /** True when resolving tools callable by branch subagents through `ctx.executeTool()`. */
  readonly forSubagent?: boolean;
}

/**
 * Native pi tools exposed to RAF agents.
 * Root may emit active `direct` and `model-only` tools natively; branch subagents
 * run inside `ctx.executeTool()` and therefore exclude `model-only` tools.
 */
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

/** Tool-call id accepted by every provider when the transcript is replayed natively. */
function newCallId(): string {
  return `call_${randomBytes(12).toString('hex')}`;
}

/** JSON copy of tool arguments. Engine arguments come from parsed model text. */
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
    const found = propSchema.type.find((entry): entry is string => typeof entry === 'string' && entry !== 'null');
    if (found !== undefined) return found;
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

/**
 * Normalize parsed protocol arguments to match a native tool's JSON Schema:
 * resolve common parameter aliases, coerce XML-stringified scalars/JSON, and
 * strip undeclared keys when `additionalProperties` is `false`.
 */
export function fitArguments(args: JsonObject, schema: unknown): JsonObject {
  if (!isPlainRecord(schema)) return args;
  const props = isPlainRecord(schema.properties) ? schema.properties : undefined;
  if (props === undefined) return args;

  const working: JsonObject = { ...args };
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

  if ('limit' in props && working.limit === undefined && working.max_matches !== undefined) {
    working.limit = working.max_matches;
    consumedAliases.add('max_matches');
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

/** Text of a tool result for the engine. Errors carry a prefix so the model sees the failure. */
function resultText(content: readonly { readonly type: string }[], isError: boolean): string {
  const text = contentText(content);
  if (!isError) return text === '' ? '(completed with no output)' : text;
  return `Tool error: ${text === '' ? 'tool failed' : text}`;
}

/** Last compaction summary on the branch, used when RAF starts without a fold state. */
function latestCheckpoint(ctx: ExtensionContext): string {
  const branch = ctx.sessionManager.getBranch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === 'compaction' && entry.summary.trim() !== '') return entry.summary.trim();
  }
  return '';
}

const STUDY_INTENT =
  /(?:\b(?:study|explore|investigate|research|deep[- ]?dive|thorough(?:ly)?|deep(?:ly)?)\b|изучи|изуча|исследуй|глубок|досконал|досканал)/iu;
const PROJECT_INTENT = /(?:\b(?:project|repo(?:sitory)?|codebase|workspace)\b|проект|репозитор|воркспейс)/iu;
const STUDY_SCOPE_ROOTS: ReadonlySet<string> = new Set(Object.freeze(['docs', 'results', 'scripts']));

/** Workspace scopes (top-level packages and doc folders) from the store manifest. */
function studyScopes(store: ContextStore): string[] {
  const scopes = new Set<string>();
  for (const doc of store.list()) {
    const parts = doc.id.split('/');
    const head = parts[0] ?? '';
    if (head === 'packages' && parts.length > 2 && parts[1] !== undefined) scopes.add(`packages/${parts[1]}`);
    else if (STUDY_SCOPE_ROOTS.has(head)) scopes.add(head);
  }
  return [...scopes].sort().slice(0, 6);
}

/** Opt-in brief that asks the root to delegate a repository study to scoped specialists. */
function studyBrief(question: string, store: ContextStore): string {
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

export interface TurnInit {
  readonly ctx: ExtensionContext;
  readonly config: RafConfig;
  readonly routes: Routes;
  readonly session: SessionState;
  readonly tracker: RunTracker;
  readonly prompt: string;
  readonly nativeTools: readonly ToolInfo[];
  /** Dynamic callable tool resolver for branch subagents (`depth >= 1`). */
  readonly getSubagentTools?: () => readonly ToolInfo[];
  /** Conversation before the current prompt. */
  readonly history: readonly AgentMessage[];
}

/** Details stored on every RAF tool result. */
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

/**
 * One RAF turn: from a user prompt to the final answer. Each root step is one
 * native pi request. pi sends the AgentFold context built here, the engine
 * parses and folds the response, and pi executes the resulting tool natively.
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
  private prepared: ChatMessage[] | undefined;
  private awaiting = false;
  private pendingCallId: string | undefined;
  private step = 0;
  private readonly toolCallStack: ActiveToolCall[] = [];
  private extraRootUsage: Usage[] = [];
  private lastError: string | undefined;
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

    const onRateLimited = (ev: { readonly rateLimitUntil?: number }) => {
      if (typeof ev.rateLimitUntil === 'number') this.tracker.setRateLimit(ev.rateLimitUntil);
    };
    const onRateResumed = () => {
      this.tracker.setRateLimit(0);
    };
    defaultRateLimitGate.on('rate:limited', onRateLimited);
    defaultRateLimitGate.on('rate:resumed', onRateResumed);
    this.detachRateLimit = () => {
      defaultRateLimitGate.off('rate:limited', onRateLimited);
      defaultRateLimitGate.off('rate:resumed', onRateResumed);
      this.tracker.setRateLimit(0);
    };

    const registry = init.ctx.modelRegistry;
    const sessionId = init.ctx.sessionManager.getSessionId();
    const { root, branch, reader } = init.routes;
    const rootThinking = reasoningOf(root.thinking);
    const rootLive = new ModelClient({
      registry,
      model: root.model,
      maxOutputTokens: ROOT_MAX_OUTPUT,
      sessionId,
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
      ingest: { cwd: this.workspace, onIngest: (res) => this.keepIngested(res, true) },
      documentTools: { maxReadLines: 250, maxReadTokens: 6000, maxGrepMatches: 100 },
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
        store.add(doc.text, { id, title: doc.title, manifest: !id.startsWith(BRANCH_REPORT_ID_PREFIX) });
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
    let effective = question;
    if (config.deepStudy) effective += studyBrief(question, store);
    session.initialQuestion ??= effective;
    if (session.initialManifest === undefined) {
      session.initialManifest = store.manifest();
      session.initialDocIds = new Set(store.list().map((doc) => doc.id));
    }
    turn.begin(effective, init.history);
    return turn;
  }

  private currentToolCtx(): ExtensionToolContext | undefined {
    return this.toolCallStack[this.toolCallStack.length - 1]?.ctx;
  }

  private recordNestedUsage(usage: Usage): void {
    const active = this.toolCallStack[this.toolCallStack.length - 1];
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
    for (const path of extractPromptPaths(this.question, this.workspace)) {
      if (session.sources.has(path)) continue;
      try {
        const res = await this.store.addPath(path, { cwd: this.workspace, ...(signal !== undefined ? { signal } : {}) });
        this.keepIngested(res, true);
        session.sources.add(path);
        session.board.record({
          agent: 'root',
          kind: 'tool',
          scope: res.sourceId,
          key: `add_document:${res.sourceId}`,
          summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
        });
      } catch {
        // A path-like word that is not a readable path is ignored.
      }
    }
  }

  private keepIngested(res: IngestResult, persist: boolean): void {
    for (const file of res.files) this.session.docs.set(file.id, { title: file.title, text: file.content, persist });
  }

  private begin(question: string, history: readonly AgentMessage[]): void {
    const session = this.session;
    this.tracker.startRun();
    const frozen = {
      ...(session.initialManifest !== undefined ? { initialManifest: session.initialManifest } : {}),
      ...(session.initialDocIds !== undefined ? { initialDocIds: session.initialDocIds } : {}),
    };
    if (session.rootState !== undefined) {
      this.engine.begin(session.initialQuestion ?? question, { initialState: session.rootState, followUpQuestion: question, ...frozen });
    } else {
      this.engine.begin(question, frozen);
    }
    const pending = session.pending;
    session.pending = undefined;
    if (pending === undefined || session.rootState === undefined) return;
    const result = findToolResult(history, pending.callId);
    if (result === undefined) return;
    try {
      this.engine.restorePending({ step: pending.step, motivation: pending.motivation, action: pending.action });
      this.engine.submit(result.text, result.isError ? { error: result.text } : undefined);
    } catch {
      // A pending step that no longer matches the fold state is dropped; the tool never runs twice.
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

  /**
   * Replace the native request with the AgentFold context. Before that, the
   * native result of the previous tool step (and any steering message) goes
   * into the fold state.
   */
  prepareRequest(messages: readonly AgentMessage[]): Message[] {
    if (this.pendingCallId !== undefined) this.submitObservation(messages, this.pendingCallId);
    const prepared = this.engine.prepareRootMessages();
    this.prepared = prepared;
    this.awaiting = true;
    this.tracker.rootRequest();
    return toPiMessages(prepared, this.routes.root.model);
  }

  private submitObservation(messages: readonly AgentMessage[], callId: string): void {
    const found = findToolResult(messages, callId);
    const steering = steeringAfter(messages, callId);
    const base = found === undefined ? 'Error: tool result missing' : this.indexResult(found.toolName, found.args, found.text, found.isError);
    const observation = steering === '' ? base : `${base}\n\n[User message during this step]\n${steering}`;
    this.engine.submit(observation, found?.isError === true ? { error: found.text } : undefined);
    this.pendingCallId = undefined;
  }

  private nextIndexedId(toolName: string): string {
    for (;;) {
      this.session.docSeq += 1;
      const candidate = sanitizeDocId(`tool_${toolName}_${this.session.docSeq}`);
      if (!this.store.has(candidate) && !this.session.docs.has(candidate)) return candidate;
    }
  }

  /**
   * Keep large native results searchable: index them as documents, and
   * re-read files that write/edit changed so RAF reads the new content.
   */
  indexResult(toolName: string, args: Readonly<Record<string, unknown>>, text: string, isError: boolean): string {
    if (isError) return text;
    if (toolName === 'write' || toolName === 'edit') {
      const target = args.path ?? args.file_path;
      if (typeof target === 'string' && target.trim() !== '') this.refreshFile(target);
      return text;
    }
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
      const rel = relative(this.workspace, abs);
      const id = sanitizeDocId(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target);
      const text = readFileSync(abs, 'utf8');
      this.store.add(text, { id, title: target });
      this.session.docs.set(id, { title: target, text, persist: false });
    } catch {
      // A file that cannot be read back is left to the next read call.
    }
  }

  /**
   * Turn the native response into one RAF step. Returns the replacement
   * message: a native tool call, or the final answer.
   */
  async acceptResponse(message: AssistantMessage, signal: AbortSignal | undefined): Promise<StepOutcome | undefined> {
    if (!this.awaiting) return undefined;
    this.awaiting = false;
    this.link(signal);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      this.root.clear();
      if (message.stopReason === 'error') this.lastError = message.errorMessage;
      return undefined;
    }
    this.tracker.addCost('root', message.usage.cost.total);
    if (this.prepared !== undefined) this.root.prefetch(this.prepared, toEngineResponse(message));
    this.prepared = undefined;
    this.extraRootUsage = [];
    let step: Awaited<ReturnType<RecursiveAgentFold['next']>>;
    try {
      step = await this.engine.next();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (this.controller.signal.aborted) return undefined;
      return this.final(message, this.failureText(this.lastError), 'error', undefined);
    }
    const usage = this.extraRootUsage.reduce(addUsage, message.usage);
    for (const extra of this.extraRootUsage) this.tracker.addCost('root', extra.cost.total);
    const thinking = thinkingBlocks(message, step.kind === 'done' ? undefined : step.reasoning);
    if (step.kind === 'tool') {
      this.step = step.step;
      const callId = newCallId();
      this.pendingCallId = callId;
      const name = piToolName(step.action.name);
      const schema = this.tools.get(step.action.name)?.parameters;
      const args = fitArguments(toJsonObject(step.action.arguments), schema);
      this.session.pending = { callId, step: step.step, motivation: step.motivation, action: step.action };
      const motivation = step.motivation.trim();
      return {
        kind: 'tool',
        replacement: {
          ...message,
          content: [
            ...thinking,
            ...(motivation !== '' ? [{ type: 'text' as const, text: motivation }] : []),
            { type: 'toolCall', id: callId, name, arguments: args },
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
    return this.final({ ...message, usage }, fallback ?? this.failureText(this.lastError), fallback === undefined ? 'error' : 'done', step.result);
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
    const replacement: AssistantMessage = { ...message, content: [...thinking, { type: 'text', text }], stopReason: 'stop' };
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

  /** Last-resort answer built from completed specialist reports. Read-only. */
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

  /** Execute a RAF built-in tool for a native pi tool call. */
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
    this.toolCallStack.push(frame);
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
      const observation = await tool.execute(params, {
        store: this.store,
        usage: this.engine.usage,
        depth: 0,
        agentName: 'root',
        step: this.step,
        emit: (event) => this.onEvent(event),
        signal: this.controller.signal,
        board: this.session.board,
        ancestorTasks: [this.question],
      });
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
    } finally {
      unsubscribe();
      if (timer !== undefined) clearTimeout(timer);
      this.tracker.endCall(toolCallId);
      const idx = this.toolCallStack.lastIndexOf(frame);
      if (idx !== -1) this.toolCallStack.splice(idx, 1);
    }
  }

  /** Run a native pi tool for a branch sub-agent, through pi's validation and hooks. */
  async runNative(name: string, args: Record<string, unknown>, signal: AbortSignal | undefined): Promise<string> {
    const ctx = this.currentToolCtx();
    if (ctx === undefined) throw new Error(`${name} can run only inside a RAF tool call`);
    const outcome = await ctx.executeTool(name, args, signal !== undefined ? { signal } : {});
    const text = resultText(outcome.result.content, outcome.isError);
    return this.indexResult(name, args, text, outcome.isError);
  }

  /** End the turn. Unfinished work is aborted. */
  finish(status: TurnStatus): void {
    if (this.finished) return;
    this.finished = true;
    this.detachRateLimit();
    const snapshot = this.engine.snapshot();
    if (snapshot !== undefined) this.session.rootState = snapshot;
    if (status === 'done') this.session.pending = undefined;
    this.captureReports();
    this.root.clear();
    if (!this.controller.signal.aborted) this.controller.abort(new Error(`RAF turn ${status}`));
    this.tracker.endRun();
  }

  get error(): string | undefined {
    return this.lastError;
  }
}

/** Keep native thinking blocks. Without them, show the engine's reasoning text. */
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

/** Find the native result of one tool call and the arguments it ran with. */
function findToolResult(messages: readonly AgentMessage[], callId: string): FoundResult | undefined {
  let args: Readonly<Record<string, unknown>> = {};
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const block of message.content) if (block.type === 'toolCall' && block.id === callId) args = block.arguments;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'toolResult' || message.toolCallId !== callId) continue;
    return { toolName: message.toolName, args, text: resultText(message.content, message.isError), isError: message.isError };
  }
  return undefined;
}

/** Text of user messages that arrived after the assistant message with this tool call. */
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

/** Engine tool that forwards a branch call to a native pi tool. */
function bridgeTool(info: BridgeableShape, turn: () => RafTurn | undefined): Tool {
  return {
    name: info.name,
    description: info.description,
    parameters: info.parameters as JSONSchema,
    async execute(args, toolCtx) {
      const current = turn();
      if (current === undefined) throw new Error(`${info.name}: RAF turn is not active`);
      const fitted = fitArguments(toJsonObject(args), info.parameters);
      return current.runNative(info.name, fitted, toolCtx.signal);
    },
  };
}

/** One progress line for a running RAF tool. */
export function progressLine(call: CallSnapshot | undefined): string {
  if (call === undefined) return 'running…';
  const running = call.agents.filter((agent) => agent.status === 'running').length;
  const done = call.agents.filter((agent) => agent.status === 'done').length;
  const parts: string[] = [];
  if (call.agents.length > 0) parts.push(`${running} running, ${done}/${call.agents.length} done`);
  if (call.readerDone + call.readerActive > 0) parts.push(`${call.readerDone} chunks read, ${call.readerActive} reading`);
  return parts.length === 0 ? 'running…' : parts.join(' · ');
}
