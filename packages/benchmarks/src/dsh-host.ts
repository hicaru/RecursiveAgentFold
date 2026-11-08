import { EventEmitter, once } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import type {
  AgentEvent,
  ChatMessage,
  LLMClient,
  LLMQueryOptions,
  UsageTracker,
} from '@raf/engine';
import type { BenchDocument, BenchTask } from './runner.js';

export interface DshRunOptions {
  readonly root: LLMClient;
  readonly branch?: LLMClient;
  readonly query?: LLMClient;
  readonly llmQuery?: LLMQueryOptions;
  readonly maxDepth?: number;
  readonly rootMaxSteps?: number;
  readonly shareQueryMemo?: boolean;
  readonly onEvent?: (e: AgentEvent) => void;
  readonly usage: UsageTracker;
}

export interface DshChecks {
  readonly runId: string;
  readonly runStatus: string;
  readonly runEventCount: number;
  readonly clientAgentCount: number;
  readonly nativeToolCalls: number;
}

export interface DshPluginTaskOutcome {
  readonly output: string | null;
  readonly steps: number;
  readonly terminated: string;
  readonly error?: string;
  readonly formatIssues: number;
  readonly dshChecks: DshChecks;
}

interface DshContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: string;
}

interface DshMessage {
  readonly id: string;
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: readonly DshContentBlock[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly source?: {
    readonly kind: string;
    readonly provider?: string;
    readonly model?: string;
    readonly callId?: string;
  };
}

interface DshStreamOptions {
  readonly sessionId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly messages?: readonly DshMessage[];
  readonly purpose?: string;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly reasoningEffort?: string;
  readonly signal?: AbortSignal;
}

interface DshStreamChunk {
  readonly type: string;
  readonly index?: number;
  readonly blockType?: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly argumentsDelta?: string;
  readonly block?: DshContentBlock;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly totalTokens?: number;
  };
  readonly reason?: {
    readonly kind: string;
    readonly failure?: {
      readonly message?: string;
      readonly code?: string;
    };
  };
}

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly parameters?: Record<string, unknown>;
  readonly deferLoading?: boolean;
  readonly output?: {
    readonly render?: (args: unknown, value: unknown) => ReadonlyArray<{ readonly type: string; readonly text: string }>;
  };
  readonly execute: (
    args: Record<string, unknown>,
    exec?: { readonly agent?: unknown; readonly signal?: AbortSignal },
  ) => Promise<unknown>;
}

interface ToolCallInput {
  readonly type?: string;
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

interface ToolBatchInput {
  readonly calls: readonly ToolCallInput[];
  readonly agent?: unknown;
  readonly signal?: AbortSignal;
  readonly toolSet?: unknown;
}

interface ToolCallOutcome {
  readonly callId: string;
  readonly name: string;
  readonly result: {
    readonly isError: boolean;
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly value?: unknown;
    readonly error?: { readonly message: string };
  };
}

interface ToolBatchOutput {
  readonly results: readonly ToolCallOutcome[];
}

interface MockRoute {
  readonly kind: 'exact' | 'prefix';
  readonly path: string;
  readonly handler: (req: MockHttpReq, res: MockHttpRes) => Promise<void>;
}

interface MockHttpReq {
  readonly method: string;
  readonly url: string;
  [Symbol.asyncIterator](): AsyncIterator<Buffer>;
}

interface MockHttpRes {
  status: number;
  body: string;
  writeHead(status: number, headers?: Record<string, string | number>): void;
  end(chunk?: string): void;
}

interface PluginRunEventEntry {
  readonly seq: number;
  readonly at: number;
  readonly event: AgentEvent;
}

interface PluginRunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly termination: string | null;
  readonly answer: string;
  readonly error: string | null;
  readonly stepCount: number;
  readonly agentCount: number;
  readonly events: readonly PluginRunEventEntry[];
}

interface PluginRunSummary {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly eventCount: number;
}

interface ClientRunModel {
  readonly agents: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly steps: readonly unknown[];
  }>;
}

type BuildRunModelFn = (run: PluginRunRecord) => ClientRunModel | null;

let cachedBuildRunModel: BuildRunModelFn | undefined;

function loadClientBuildRunModel(): BuildRunModelFn {
  if (cachedBuildRunModel !== undefined) return cachedBuildRunModel;
  const here = dirname(fileURLToPath(import.meta.url));
  const clientPath = join(here, '..', '..', 'dsh-plugin', 'client.js');
  const code = readFileSync(clientPath, 'utf8');
  const storage = new Map<string, string>();
  const fakeWindow: {
    __ModuleLoader__: {
      load: (spec: { readonly id: string; readonly factory: (req: (id: string) => unknown) => unknown }) => void;
    };
    localStorage: {
      getItem: (k: string) => string | null;
      setItem: (k: string, v: string) => void;
    };
    __RAF_BUILD_RUN_MODEL__?: BuildRunModelFn;
  } = {
    __ModuleLoader__: {
      load(spec) {
        spec.factory((modId: string) => {
          if (modId === 'react') {
            return {
              createElement: () => null,
              useState: <T>(init: T) => [init, () => {}],
              useEffect: () => {},
              useMemo: <T>(fn: () => T) => fn(),
              useCallback: <T>(fn: T) => fn,
              useRef: <T>(init: T) => ({ current: init }),
            };
          }
          return {};
        });
      },
    },
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => {
        storage.set(k, v);
      },
    },
  };
  runInNewContext(code, {
    window: fakeWindow,
    Date,
    Math,
    Map,
    Set,
    Array,
    Object,
    Number,
    String,
    Boolean,
    JSON,
    RegExp,
    Error,
    Promise,
     encodeURIComponent,
    decodeURIComponent,
    setTimeout,
    clearTimeout,
  });
  if (typeof fakeWindow.__RAF_BUILD_RUN_MODEL__ !== 'function') {
    throw new Error('Failed to load __RAF_BUILD_RUN_MODEL__ from @raf/dsh-plugin/client.js');
  }
  cachedBuildRunModel = fakeWindow.__RAF_BUILD_RUN_MODEL__;
  return cachedBuildRunModel;
}

class MockExecutionPipeline {
  readonly ctx: unknown;
  readonly source: {
    readonly get: (name: string, scope: unknown, toolSet?: unknown) => RegisteredTool | undefined;
    readonly reject?: (name: string) => Error;
  };

  constructor(
    ctx: unknown,
    source: {
      readonly get: (name: string, scope: unknown, toolSet?: unknown) => RegisteredTool | undefined;
      readonly reject?: (name: string) => Error;
    },
  ) {
    this.ctx = ctx;
    this.source = source;
  }

  async execute(batch: ToolBatchInput): Promise<ToolBatchOutput> {
    const results: ToolCallOutcome[] = [];
    for (let i = 0; i < batch.calls.length; i++) {
      const call = batch.calls[i];
      if (!call) continue;
      const tool = this.source.get(call.name, batch.agent, batch.toolSet);
      if (!tool) {
        const err = this.source.reject?.(call.name) ?? new Error(`unknown tool "${call.name}"`);
        results.push({
          callId: call.id,
          name: call.name,
          result: {
            isError: true,
            content: [{ type: 'text', text: err.message }],
            error: { message: err.message },
          },
        });
        continue;
      }
      try {
        const parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        const val = await tool.execute(parsedArgs, { agent: batch.agent, signal: batch.signal });
        const rendered =
          typeof tool.output?.render === 'function'
            ? tool.output.render(parsedArgs, val)
            : [{ type: 'text', text: String(val ?? '') }];
        results.push({
          callId: call.id,
          name: call.name,
          result: {
            isError: false,
            content: rendered,
            value: val,
          },
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        results.push({
          callId: call.id,
          name: call.name,
          result: {
            isError: true,
            content: [{ type: 'text', text: msg }],
            error: { message: msg },
          },
        });
      }
    }
    return { results };
  }
}

function dshMessagesToChatMessages(messages: readonly DshMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    const textParts: string[] = [];
    for (let j = 0; j < m.content.length; j++) {
      const block = m.content[j];
      if (block && block.type === 'text' && typeof block.text === 'string') {
        textParts.push(block.text);
      }
    }
    const role: 'system' | 'user' | 'assistant' =
      m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: textParts.join('\n') });
  }
  return out;
}

async function callRouteJson<T>(
  routes: readonly MockRoute[],
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ readonly status: number; readonly data: T }> {
  const url = new URL(urlPath, 'http://localhost');
  let matched: MockRoute | undefined;
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    if (!r) continue;
    if (r.kind === 'exact' && url.pathname === r.path) {
      matched = r;
      break;
    }
    if (r.kind === 'prefix' && (url.pathname === r.path || url.pathname.startsWith(`${r.path}/`))) {
      matched = r;
      break;
    }
  }
  if (!matched) {
    throw new Error(`No registered DSH route matched ${urlPath}`);
  }
  const payloadBuf = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
  const req: MockHttpReq = {
    method,
    url: urlPath,
    async *[Symbol.asyncIterator]() {
      if (payloadBuf !== undefined) yield payloadBuf;
    },
  };
  const res: MockHttpRes = {
    status: 200,
    body: '',
    writeHead(status: number) {
      this.status = status;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') this.body = chunk;
    },
  };
  await matched.handler(req, res);
  return {
    status: res.status,
    data: JSON.parse(res.body) as T,
  };
}

let hostCounter = 0;

export class DshBenchmarkGroupHost {
  private readonly hostId: number;
  private readonly profileDir: string;
  private readonly workspaceDir: string;
  private readonly opts: Omit<DshRunOptions, 'onEvent' | 'usage'>;
  private readonly disposers: Array<() => void>;
  private readonly routes: MockRoute[];
  private readonly agentsBySession: Map<
    string,
    {
      readonly id: string;
      readonly session: {
        readonly id: string;
        readonly header: { readonly cwd: string };
        readonly log: Array<Record<string, unknown>>;
        readonly append: (ev: Record<string, unknown>) => void;
      };
      readonly ctx: {
        readonly tools: {
          readonly register: (def: RegisteredTool) => () => void;
        };
      };
    }
  >;
  private readonly toolsService: {
    register: (def: RegisteredTool, opts?: unknown) => () => void;
    executable: (name: string, scope?: unknown) => RegisteredTool | undefined;
    definitions: (scope?: unknown) => readonly RegisteredTool[];
    selectExecutor: (scope: unknown) => { execute: (batch: ToolBatchInput) => Promise<ToolBatchOutput> };
    execute: (batch: ToolBatchInput) => Promise<ToolBatchOutput>;
  };
  private streamInterceptor:
    | ((
        options: DshStreamOptions,
        next: () => AsyncIterable<DshStreamChunk>,
      ) => AsyncIterable<DshStreamChunk>)
    | undefined;
  private activeUsage: UsageTracker | undefined;
  private readonly seenRunIds = new Set<string>();

  private constructor(
    hostId: number,
    profileDir: string,
    workspaceDir: string,
    opts: Omit<DshRunOptions, 'onEvent' | 'usage'>,
    disposers: Array<() => void>,
    routes: MockRoute[],
    agentsBySession: Map<
      string,
      {
        readonly id: string;
        readonly session: {
          readonly id: string;
          readonly header: { readonly cwd: string };
          readonly log: Array<Record<string, unknown>>;
          readonly append: (ev: Record<string, unknown>) => void;
        };
        readonly ctx: {
          readonly tools: {
            readonly register: (def: RegisteredTool) => () => void;
          };
        };
      }
    >,
    toolsService: {
      register: (def: RegisteredTool, opts?: unknown) => () => void;
      executable: (name: string, scope?: unknown) => RegisteredTool | undefined;
      definitions: (scope?: unknown) => readonly RegisteredTool[];
      selectExecutor: (scope: unknown) => { execute: (batch: ToolBatchInput) => Promise<ToolBatchOutput> };
      execute: (batch: ToolBatchInput) => Promise<ToolBatchOutput>;
    },
    streamInterceptor:
      | ((
          options: DshStreamOptions,
          next: () => AsyncIterable<DshStreamChunk>,
        ) => AsyncIterable<DshStreamChunk>)
      | undefined,
    setActiveUsageBinder: (getter: () => UsageTracker | undefined) => void,
  ) {
    this.hostId = hostId;
    this.profileDir = profileDir;
    this.workspaceDir = workspaceDir;
    this.opts = opts;
    this.disposers = disposers;
    this.routes = routes;
    this.agentsBySession = agentsBySession;
    this.toolsService = toolsService;
    this.streamInterceptor = streamInterceptor;
    setActiveUsageBinder(() => this.activeUsage);
  }

  static async create(
    docs: readonly BenchDocument[],
    opts: Omit<DshRunOptions, 'onEvent' | 'usage'>,
  ): Promise<DshBenchmarkGroupHost> {
    const hostId = ++hostCounter;
    const profileDir = await mkdtemp(join(tmpdir(), `raf-dsh-bench-profile-${hostId}-`));
    const workspaceDir = await mkdtemp(join(tmpdir(), `raf-dsh-bench-ws-${hostId}-`));

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      if (!doc) continue;
      const targetPath = join(workspaceDir, doc.id);
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, doc.text, 'utf8');
    }

    const clampedDepth = Math.min(3, Math.max(1, Math.round(opts.maxDepth ?? 2)));
    const reserve = opts.llmQuery?.reserveRatio ?? 0.3;
    const concurrency = opts.llmQuery?.concurrency ?? 4;
    const branchModel = (opts.branch ?? opts.root).profile.name;
    const queryModel = (opts.query ?? opts.root).profile.name;

    await mkdir(join(profileDir, 'raf-engine'), { recursive: true });
    await writeFile(
      join(profileDir, 'raf-engine', 'state.json'),
      JSON.stringify(
        {
          version: 1,
          defaultEngine: 'raf',
          engines: {},
          settings: {
            depth: clampedDepth,
            reserve,
            concurrency,
            branchProvider: 'bench-branch',
            branchModel,
            branchReasoningEffort: '',
            queryProvider: 'bench-query',
            queryModel,
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const prevProfileDir = process.env.DSH_PROFILE_DIR;
    process.env.DSH_PROFILE_DIR = profileDir;

    const registeredTools = new Map<string, RegisteredTool>();
    const perAgentTools = new WeakMap<object, Map<string, RegisteredTool>>();
    registeredTools.set('bash', {
      name: 'bash',
      description: 'Execute a shell command in the workspace',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['command', 'description'],
      },
      async execute(args) {
        if (typeof args.description !== 'string' || args.description.trim() === '') {
          throw new Error('invalid arguments: missing required property "description"');
        }
        return '(mock bash disabled in benchmark)';
      },
    });

    const ptcExecutor = {
      ctx: {},
      pipeline: new MockExecutionPipeline(
        {},
        {
          get: (name) => (name === 'run_code' ? registeredTools.get('run_code') : undefined),
          reject: (name) =>
            new Error(
              `unknown tool "${name}": only \`run_code\` is callable directly — call \`${name}\` from inside a \`run_code\` program instead`,
            ),
        },
      ),
      async execute(batch: ToolBatchInput): Promise<ToolBatchOutput> {
        return this.pipeline.execute(batch);
      },
    };

    const readyEmitter = new EventEmitter();
    const toolsReady = once(readyEmitter, 'ready');

    const toolsService = {
      register(def: RegisteredTool): () => void {
        registeredTools.set(def.name, def);
        if (def.name === 'branch') readyEmitter.emit('ready');
        return () => {
          registeredTools.delete(def.name);
        };
      },
      executable(name: string, scope?: unknown): RegisteredTool | undefined {
        if (scope !== null && typeof scope === 'object') {
          const scoped = perAgentTools.get(scope)?.get(name);
          if (scoped !== undefined) return scoped;
        }
        return registeredTools.get(name);
      },
      definitions(): readonly RegisteredTool[] {
        return [...registeredTools.values()];
      },
      selectExecutor(_scope: unknown): { execute: (batch: ToolBatchInput) => Promise<ToolBatchOutput> } {
        return ptcExecutor;
      },
      async execute(batch: ToolBatchInput): Promise<ToolBatchOutput> {
        const exec = this.selectExecutor(batch.agent);
        return exec.execute(batch);
      },
    };

    const agentsBySession = new Map<
      string,
      {
        readonly id: string;
        readonly session: {
          readonly id: string;
          readonly header: { readonly cwd: string };
          readonly log: Array<Record<string, unknown>>;
          readonly append: (ev: Record<string, unknown>) => void;
        };
        readonly ctx: {
          readonly tools: {
            readonly register: (def: RegisteredTool) => () => void;
          };
        };
      }
    >();

    const getOrCreateAgent = (sessionId: string) => {
      const existing = agentsBySession.get(sessionId);
      if (existing !== undefined) return existing;
      const log: Array<Record<string, unknown>> = [{ type: 'turn/start', data: { turn: 1 } }];
      const agentObj = {
        id: sessionId,
        session: {
          id: sessionId,
          header: { cwd: workspaceDir },
          log,
          append(ev: Record<string, unknown>) {
            log.push(ev);
          },
        },
        ctx: {
          tools: {
            register(def: RegisteredTool) {
              let map = perAgentTools.get(agentObj);
              if (map === undefined) {
                map = new Map<string, RegisteredTool>();
                perAgentTools.set(agentObj, map);
              }
              map.set(def.name, def);
              return () => {
                map?.delete(def.name);
              };
            },
          },
        },
      };
      agentsBySession.set(sessionId, agentObj);
      return agentObj;
    };

    const routes: MockRoute[] = [];
    const disposers: Array<() => void> = [];
    let streamInterceptor:
      | ((
          options: DshStreamOptions,
          next: () => AsyncIterable<DshStreamChunk>,
        ) => AsyncIterable<DshStreamChunk>)
      | undefined;

    let getActiveUsage: () => UsageTracker | undefined = () => undefined;

    const webServer = {
      register(route: MockRoute) {
        routes.push(route);
        return () => {
          const idx = routes.indexOf(route);
          if (idx >= 0) routes.splice(idx, 1);
        };
      },
    };

    const mockCtx = {
      tools: toolsService,
      webServer,
      llm: {
        listProviders() {
          return [
            { id: 'bench-root', name: 'Bench Root' },
            { id: 'bench-branch', name: 'Bench Branch' },
            { id: 'bench-query', name: 'Bench Query' },
          ];
        },
        async listModels(providerId: string) {
          if (providerId === 'bench-query') {
            return [{ id: queryModel, name: queryModel }];
          }
          if (providerId === 'bench-branch') {
            return [{ id: branchModel, name: branchModel }];
          }
          return [{ id: opts.root.profile.name, name: opts.root.profile.name }];
        },
        async resolveModelInfo() {
          return {};
        },
        async *stream(streamOpts: DshStreamOptions): AsyncIterable<DshStreamChunk> {
          const purpose = streamOpts.purpose ?? 'raf-root';
          const isQuery = streamOpts.provider === 'bench-query' || purpose === 'raf-llm_query';
          const isBranch = streamOpts.provider === 'bench-branch' || purpose === 'raf-branch';
          const targetClient: LLMClient = isQuery
            ? (opts.query ?? opts.root)
            : isBranch
              ? (opts.branch ?? opts.root)
              : opts.root;
          const role = isQuery ? 'llm_query' : isBranch ? 'branch' : 'root';
          const messages = dshMessagesToChatMessages(streamOpts.messages ?? []);
          const cleanPurpose = purpose.startsWith('raf-') ? purpose.slice(4) : purpose;
          const usageTracker = getActiveUsage();
          try {
            const res = await targetClient.complete({
              messages,
              temperature: streamOpts.temperature,
              maxTokens: streamOpts.maxTokens,
              signal: streamOpts.signal,
              purpose: cleanPurpose,
            });
            usageTracker?.record(role, res.usage, res.latencyMs);
            if (typeof res.reasoning === 'string' && res.reasoning !== '') {
              yield { type: 'reasoning-delta', text: res.reasoning };
            }
            yield { type: 'text-delta', text: res.text };
            const cached = Math.min(res.usage.promptTokens, res.usage.cachedTokens);
            yield {
              type: 'usage',
              usage: {
                inputTokens: Math.max(0, res.usage.promptTokens - cached),
                outputTokens: res.usage.completionTokens,
                cacheReadTokens: cached,
              },
            };
            yield {
              type: 'finish',
              reason: { kind: res.finishReason === 'length' ? 'max-tokens' : 'stop' },
            };
          } catch (err: unknown) {
            usageTracker?.recordError(role);
            const message = err instanceof Error ? err.message : String(err);
            yield {
              type: 'finish',
              reason: { kind: 'error', failure: { message } },
            };
          }
        },
      },
      get(service: string): unknown {
        if (service === 'tools') return toolsService;
        if (service === 'agents') {
          return {
            get: (sessionId: string) => getOrCreateAgent(sessionId),
            list: () => [...agentsBySession.values()],
          };
        }
        if (service === 'tokenMeter') {
          return {
            contextPressure: () => ({ contextWindow: opts.root.profile.contextWindow }),
          };
        }
        if (service === 'workingDirectory') {
          return {
            get: () => workspaceDir,
          };
        }
        if (service === 'webServer') return webServer;
        return undefined;
      },
      effect(fn: () => (() => void) | void) {
        const cleanup = fn();
        if (typeof cleanup === 'function') disposers.push(cleanup);
      },
      on(
        event: string,
        handler: (
          options: DshStreamOptions,
          next: () => AsyncIterable<DshStreamChunk>,
        ) => AsyncIterable<DshStreamChunk>,
      ) {
        if (event === 'llm/stream') {
          streamInterceptor = handler;
        }
        return () => {};
      },
      inject(_deps: readonly string[], callback: (subCtx: unknown) => void) {
        callback(mockCtx);
      },
    };

    try {
      // Dynamic import loads the untyped @raf/dsh-plugin ESM plugin outside packages/benchmarks rootDir.
      const dshPlugin = (await import('../../dsh-plugin/index.js' as string)) as {
        apply: (ctx: unknown) => void;
      };
      dshPlugin.apply(mockCtx);
      await toolsReady;
    } finally {
      if (prevProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfileDir;
    }

    return new DshBenchmarkGroupHost(
      hostId,
      profileDir,
      workspaceDir,
      opts,
      disposers,
      routes,
      agentsBySession,
      toolsService,
      streamInterceptor,
      (getter) => {
        getActiveUsage = getter;
      },
    );
  }

  async runTask(
    task: BenchTask,
    opts: Pick<DshRunOptions, 'onEvent' | 'usage' | 'rootMaxSteps'>,
  ): Promise<DshPluginTaskOutcome> {
    if (this.streamInterceptor === undefined) {
      throw new Error('DSH plugin did not register an llm/stream interceptor');
    }

    const sessionId =
      this.opts.shareQueryMemo !== false
        ? `bench-h${this.hostId}-${task.group}`
        : `bench-h${this.hostId}-${task.group}-${task.id}`;
    const agent =
      this.agentsBySession.get(sessionId) ??
      (() => {
        const log: Array<Record<string, unknown>> = [{ type: 'turn/start', data: { turn: 1 } }];
        const created = {
          id: sessionId,
          session: {
            id: sessionId,
            header: { cwd: this.workspaceDir },
            log,
            append(ev: Record<string, unknown>) {
              log.push(ev);
            },
          },
          ctx: {
            tools: {
              register: (def: RegisteredTool) => this.toolsService.register(def),
            },
          },
        };
        this.agentsBySession.set(sessionId, created);
        return created;
      })();

    // Configure session engine to RAF via the plugin's /engine HTTP route
    await callRouteJson(this.routes, 'POST', '/plugins/@raf/dsh-plugin/engine', {
      sessionId,
      engine: 'raf',
    });

    const messages: DshMessage[] = [
      {
        id: `user-${task.id}`,
        role: 'user',
        content: [{ type: 'text', text: task.question }],
        source: { kind: 'user' },
      },
    ];

    const maxSteps = opts.rootMaxSteps ?? this.opts.rootMaxSteps ?? 30;
    this.activeUsage = opts.usage;
    let finalAnswer: string | null = null;
    let nativeToolCalls = 0;

    try {
      for (let step = 0; step < maxSteps + 5; step++) {
        agent.session.append({ type: 'step/start', data: { turn: 1, step } });
        const stream = this.streamInterceptor(
          {
            sessionId,
            provider: 'bench-root',
            model: this.opts.root.profile.name,
            messages,
          },
          async function* fallbackNext(): AsyncIterable<DshStreamChunk> {
            throw new Error('DSH llm/stream unexpectedly fell through to default handler');
          },
        );

        let emittedToolCall: { readonly id: string; readonly name: string; readonly arguments: string } | undefined;
        for await (const chunk of stream) {
          if (chunk.type === 'block-end' && chunk.block !== undefined) {
            const b = chunk.block;
            if (b.type === 'tool-call' && typeof b.id === 'string' && typeof b.name === 'string') {
              emittedToolCall = {
                id: b.id,
                name: b.name,
                arguments: b.arguments ?? '{}',
              };
            } else if (b.type === 'text' && typeof b.text === 'string') {
              finalAnswer = b.text;
            }
          }
        }

        if (emittedToolCall === undefined) {
          break;
        }

        nativeToolCalls++;
        const batchOut = await this.toolsService.execute({
          calls: [
            {
              type: 'tool-call',
              id: emittedToolCall.id,
              name: emittedToolCall.name,
              arguments: emittedToolCall.arguments,
            },
          ],
          agent,
        });
        const first = batchOut.results[0];
        const firstText = first?.result.content[0]?.text ?? '';
        if (firstText.includes('only `run_code` is callable directly')) {
          throw new Error(`PTC lockout was not bypassed for tool "${emittedToolCall.name}"`);
        }

        messages.push({
          id: `tool-${step}`,
          role: 'tool',
          toolCallId: emittedToolCall.id,
          isError: first?.result.isError ?? false,
          content: first?.result.content ?? [{ type: 'text', text: '' }],
        });
      }
    } finally {
      this.activeUsage = undefined;
    }

    const listRes = await callRouteJson<{ readonly runs: readonly PluginRunSummary[] }>(
      this.routes,
      'GET',
      `/plugins/@raf/dsh-plugin/runs?sessionId=${encodeURIComponent(sessionId)}`,
    );
    const summary =
      listRes.data.runs.find((r) => !this.seenRunIds.has(r.id)) ?? listRes.data.runs[0];
    if (!summary) {
      throw new Error(`No run recorded in DSH plugin run registry for sessionId "${sessionId}"`);
    }
    this.seenRunIds.add(summary.id);
    const detailRes = await callRouteJson<PluginRunRecord>(
      this.routes,
      'GET',
      `/plugins/@raf/dsh-plugin/runs/${encodeURIComponent(summary.id)}`,
    );
    const runRecord = detailRes.data;

    let formatIssues = 0;
    let rootSteps = runRecord.stepCount;
    for (let i = 0; i < runRecord.events.length; i++) {
      const entry = runRecord.events[i];
      if (!entry) continue;
      const ev = entry.event;
      opts.onEvent?.(ev);
      if (ev.type === 'format_error') {
        formatIssues++;
      } else if (ev.type === 'run_end' && ev.agent === 'root') {
        rootSteps = ev.steps;
      }
    }

    const buildRunModel = loadClientBuildRunModel();
    const clientModel = buildRunModel(runRecord);
    const clientAgentCount = clientModel?.agents.length ?? 0;

    const output =
      typeof runRecord.answer === 'string' && runRecord.answer !== ''
        ? runRecord.answer
        : finalAnswer;
    const terminated = runRecord.termination ?? (runRecord.status === 'done' ? 'answer' : 'error');
    const errorMsg =
      typeof runRecord.error === 'string' && runRecord.error !== '' ? runRecord.error : undefined;

    return {
      output,
      steps: rootSteps,
      terminated,
      ...(errorMsg !== undefined ? { error: errorMsg } : {}),
      formatIssues,
      dshChecks: Object.freeze({
        runId: runRecord.id,
        runStatus: runRecord.status,
        runEventCount: runRecord.events.length,
        clientAgentCount,
        nativeToolCalls,
      }),
    };
  }

  async dispose(): Promise<void> {
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      try {
        this.disposers[i]?.();
      } catch {
        // Ignore teardown error.
      }
    }
    this.disposers.length = 0;
    await rm(this.profileDir, { recursive: true, force: true });
    await rm(this.workspaceDir, { recursive: true, force: true });
  }
}
