import { AgentFoldAgent, type AgentFoldConfig, type AgentRunResult, type AgentStep } from './agent/agent-fold.js';
import type { EventSink } from './agent/events.js';
import type { ContextStore } from './context/store.js';
import { ResearchBoard } from './context/board.js';
import type { FoldStateSnapshot } from './fold/state.js';
import { UsageTracker } from './llm/usage.js';
import { createBranchTool, type BranchRunnerOptions } from './tools/branch.js';
import { createCalculatorTool } from './tools/calculator.js';
import {
  createAddDocumentTool,
  createGrepTool,
  createListDocumentsTool,
  createOutlineTool,
  createReadTool,
  createSearchTool,
  createTallyTool,
  type AddDocumentToolOptions,
  type DocumentToolOptions,
} from './tools/document-tools.js';
import { createLLMQueryTool, LLMQueryEngine, type LLMQueryOptions } from './tools/llm-query.js';
import type { Tool } from './tools/types.js';
import type { LLMClient } from './types.js';

export const DEFAULT_MAX_DEPTH = 2;

export interface RecursiveAgentFoldOptions {
  /** Root agent model (e.g. a large thinking model). */
  rootLLM: LLMClient;
  /** Model for branch sub-agents (default: rootLLM). */
  branchLLM?: LLMClient;
  /** Non-thinking reader model for llm_query. Omit to disable llm_query. */
  queryLLM?: LLMClient;
  /**
   * Reuse an existing engine (shares the llm_query memo across runs over the
   * same store, e.g. several questions about one context window).
   */
  queryEngine?: LLMQueryEngine;
  store: ContextStore;
  llmQuery?: LLMQueryOptions;
  documentTools?: DocumentToolOptions;
  /** Options for `add_document` file/directory ingestion. */
  ingest?: AddDocumentToolOptions;
  /** Max branch recursion depth (0 disables branching). Default 2. */
  maxDepth?: number;
  rootMaxSteps?: number;
  branchMaxSteps?: number;
  /** Prefix applied to every agent's built-in tools (host-native tool names). */
  readonly toolNamePrefix?: string;
  /** Which tools to expose. Default: all available. */
  enable?: Partial<
    Record<
      | 'add_document'
      | 'llm_query'
      | 'branch'
      | 'search'
      | 'outline'
      | 'grep'
      | 'tally'
      | 'read'
      | 'list_documents'
      | 'calculator',
      boolean
    >
  >;
  extraTools?: Tool[];
  agent?: Partial<Omit<AgentFoldConfig, 'llm' | 'tools' | 'store' | 'depth' | 'name' | 'usage' | 'onEvent'>>;
  onEvent?: EventSink;
  usage?: UsageTracker;
  signal?: AbortSignal;
  board?: ResearchBoard;
}

export interface RootBeginOptions {
  readonly initialState?: FoldStateSnapshot;
  readonly followUpQuestion?: string;
  readonly initialBoardCount?: number;
  readonly initialBoardSnapshot?: string;
  readonly initialManifest?: string;
  readonly initialDocIds?: Iterable<string>;
}

/**
 * Recursive AgentFold runtime.
 *
 * - Root agent: the paper's AgentFold loop (fold every step).
 * - llm_query: a non-thinking reader fanned out over deterministic chunks
 *   (chunk = window × (1 − reserveRatio)), memoized and prefix-cache friendly.
 * - branch: recursive scoped specialist sub-agents with persistent folded
 *   contexts on ResearchBoard (depth ≤ maxDepth).
 * - grep/read: precise follow-up after llm_query located the evidence.
 */
export class RecursiveAgentFold {
  readonly usage: UsageTracker;
  readonly queryEngine?: LLMQueryEngine;
  readonly board: ResearchBoard;
  private branchCounter = 0;
  private rootAgent: AgentFoldAgent | undefined;

  constructor(readonly opts: RecursiveAgentFoldOptions) {
    this.usage = opts.usage ?? new UsageTracker();
    if (opts.enable?.llm_query !== false) {
      if (opts.queryEngine) {
        if (opts.queryEngine.store !== opts.store) throw new Error('queryEngine must use the same ContextStore');
        this.queryEngine = opts.queryEngine;
      } else if (opts.queryLLM) {
        this.queryEngine = new LLMQueryEngine(opts.queryLLM, opts.store, this.usage, {
          ...opts.llmQuery,
          board: opts.board,
        });
      }
    }
    this.board = opts.board ?? this.queryEngine?.board ?? new ResearchBoard();
  }

  /** Tools for an agent at the given depth. */
  toolsFor(depth: number, ownScope?: string): Tool[] {
    const en = this.opts.enable ?? {};
    const maxDepth = this.opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const docToolOpts: DocumentToolOptions = {
      ...this.opts.documentTools,
      ...(this.opts.ingest !== undefined ? { ingest: this.opts.ingest } : {}),
    };
    const builtins: Tool[] = [];
    if (this.queryEngine) builtins.push(createLLMQueryTool(this.queryEngine));
    if (en.add_document !== false) builtins.push(createAddDocumentTool(this.opts.ingest));
    if (en.search !== false) builtins.push(createSearchTool(docToolOpts));
    if (en.outline !== false) builtins.push(createOutlineTool(docToolOpts));
    if (en.grep !== false) builtins.push(createGrepTool(docToolOpts));
    if (en.tally !== false) builtins.push(createTallyTool(docToolOpts));
    if (en.read !== false) builtins.push(createReadTool(docToolOpts));
    if (en.list_documents !== false) {
      builtins.push(createListDocumentsTool(docToolOpts));
    }
    if (en.calculator !== false) builtins.push(createCalculatorTool());
    if (en.branch !== false && maxDepth > 0 && depth <= maxDepth) {
      builtins.push(
        createBranchTool((task, o) => this.runAgent(task, o), {
          maxBranchSteps: this.opts.branchMaxSteps ?? 20,
          consultOnly: depth === maxDepth,
          ...(ownScope !== undefined ? { ownScope } : {}),
        }),
      );
    }
    const prefix = this.opts.toolNamePrefix ?? '';
    const tools =
      prefix === ''
        ? builtins
        : builtins.map((tool) => ({ ...tool, name: `${prefix}${tool.name}`, execute: tool.execute.bind(tool) }));
    if (this.opts.extraTools) tools.push(...this.opts.extraTools);
    return tools;
  }

  private createAgent(
    opts: BranchRunnerOptions & {
      readonly initialManifest?: string;
      readonly initialDocIds?: Iterable<string>;
    },
  ): AgentFoldAgent {
    const {
      depth,
      maxSteps,
      parent,
      scope,
      initialState,
      followUpQuestion,
      initialBoardCount,
      initialBoardSnapshot,
      initialManifest,
      initialDocIds,
      agentName,
      callStack,
      ancestorTasks,
      signal,
    } = opts;
    const llm = depth === 0 ? this.opts.rootLLM : (this.opts.branchLLM ?? this.opts.rootLLM);
    const maxDepth = this.opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const agent = new AgentFoldAgent({
      ...this.opts.agent,
      llm,
      tools: this.toolsFor(depth, scope),
      store: this.opts.store,
      depth,
      maxDepth,
      parent,
      ...(scope !== undefined ? { scope } : {}),
      name: agentName ?? (depth === 0 ? 'root' : `branch#${++this.branchCounter}@${depth}`),
      maxSteps: maxSteps ?? (depth === 0 ? (this.opts.rootMaxSteps ?? 100) : (this.opts.branchMaxSteps ?? 20)),
      usage: this.usage,
      onEvent: this.opts.onEvent,
      signal: signal ?? this.opts.signal,
      board: this.board,
      initialState,
      followUpQuestion,
      initialBoardCount,
      initialBoardSnapshot,
      ...(initialManifest !== undefined ? { initialManifest } : {}),
      ...(initialDocIds !== undefined ? { initialDocIds } : {}),
      callStack,
      ancestorTasks,
    });
    return agent;
  }

  private runAgent(question: string, opts: BranchRunnerOptions): Promise<AgentRunResult> {
    return this.createAgent(opts).run(question);
  }

  /** Prepare the root agent for externally driven steps. */
  begin(question: string, opts?: RootBeginOptions): void {
    this.rootAgent = this.createAgent({
      depth: 0,
      parent: 'user',
      ...(opts?.initialState !== undefined ? { initialState: opts.initialState } : {}),
      ...(opts?.followUpQuestion !== undefined ? { followUpQuestion: opts.followUpQuestion } : {}),
      ...(opts?.initialBoardCount !== undefined ? { initialBoardCount: opts.initialBoardCount } : {}),
      ...(opts?.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: opts.initialBoardSnapshot } : {}),
      ...(opts?.initialManifest !== undefined ? { initialManifest: opts.initialManifest } : {}),
      ...(opts?.initialDocIds !== undefined ? { initialDocIds: opts.initialDocIds } : {}),
    });
    this.rootAgent.begin(question);
  }
  /** Produce one root step; a tool step waits for `submit()`. */
  async next(): Promise<AgentStep> {
    if (this.rootAgent === undefined) throw new Error('RecursiveAgentFold.begin() must run before next()');
    return this.rootAgent.next();
  }

  /** Current root fold state for host-side persistence. */
  snapshot(): FoldStateSnapshot | undefined {
    return this.rootAgent?.snapshot();
  }

  /** Feed the root tool observation back into the fold state. */
  submit(observation: string, meta?: { error?: string }): void {
    if (this.rootAgent === undefined) throw new Error('RecursiveAgentFold.begin() must run before submit()');
    this.rootAgent.submit(observation, meta);
  }

  run(question: string): Promise<AgentRunResult> {
    return this.runAgent(question, { depth: 0, parent: 'user' });
  }
}
