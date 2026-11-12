import {
  AgentFoldAgent,
  type AgentFoldConfig,
  type AgentRunResult,
  type AgentStep,
  type PendingAgentStep,
} from './agent/agent-fold.js';
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
import type { ChatMessage, LLMClient } from './types.js';

export const DEFAULT_MAX_DEPTH = 2;
export const DEFAULT_BRANCH_MAX_STEPS = 30;

export interface RecursiveAgentFoldOptions {
  /** Root agent model. */
  readonly rootLLM: LLMClient;
  /** Specialist sub-agent model (defaults to rootLLM). */
  readonly branchLLM?: LLMClient;
  /** Non-thinking reader model for llm_query. Omit to disable llm_query. */
  readonly queryLLM?: LLMClient;
  /** Shared LLMQueryEngine across multiple runs on the same ContextStore. */
  readonly queryEngine?: LLMQueryEngine;
  readonly store: ContextStore;
  readonly llmQuery?: LLMQueryOptions;
  readonly documentTools?: DocumentToolOptions;
  /** Options for file and directory ingestion. */
  readonly ingest?: AddDocumentToolOptions;
  /** Maximum branch recursion depth (0 disables branching, default 2). */
  readonly maxDepth?: number;
  readonly rootMaxSteps?: number;
  readonly branchMaxSteps?: number;
  /** Maximum branch specialists that run concurrently per branch call. */
  readonly branchConcurrency?: number;
  /** Prefix applied to built-in tool names. */
  readonly toolNamePrefix?: string;
  /** Clear transient reports from prior runs before starting a fresh `run()` (default true). */
  readonly clearTransientOnRun?: boolean;
  /** Toggle individual built-in tools. */
  readonly enable?: Partial<
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
  readonly extraTools?: readonly Tool[] | ((depth: number) => readonly Tool[]);
  readonly agent?: Partial<Omit<AgentFoldConfig, 'llm' | 'tools' | 'store' | 'depth' | 'name' | 'usage' | 'onEvent'>>;
  readonly onEvent?: EventSink;
  readonly usage?: UsageTracker;
  readonly signal?: AbortSignal;
  readonly board?: ResearchBoard;
}

export interface RootBeginOptions {
  readonly initialState?: FoldStateSnapshot;
  readonly followUpQuestion?: string;
  readonly initialBoardRev?: number;
  readonly initialBoardCount?: number;
  readonly initialBoardSnapshot?: string;
  readonly initialManifest?: string;
  readonly initialDocIds?: Iterable<string>;
  readonly initialDocRevs?: Readonly<Record<string, number>>;
}

/**
 * Recursive AgentFold runtime.
 */
export class RecursiveAgentFold {
  readonly usage: UsageTracker;
  readonly queryEngine?: LLMQueryEngine;
  readonly board: ResearchBoard;
  private branchCounter = 0;
  private rootAgent?: AgentFoldAgent;

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

  /** Return tools exposed to an agent at the given depth. */
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
    if (en.list_documents !== false) builtins.push(createListDocumentsTool(docToolOpts));
    if (en.calculator !== false) builtins.push(createCalculatorTool());
    if (en.branch !== false && maxDepth > 0 && depth <= maxDepth) {
      builtins.push(
        createBranchTool((task, o) => this.runAgent(task, o), {
          maxBranchSteps: this.opts.branchMaxSteps ?? DEFAULT_BRANCH_MAX_STEPS,
          consultOnly: depth === maxDepth,
          ...(ownScope !== undefined ? { ownScope } : {}),
          ...(this.opts.branchConcurrency !== undefined ? { concurrency: this.opts.branchConcurrency } : {}),
        }),
      );
    }
    const prefix = this.opts.toolNamePrefix ?? '';
    const tools =
      prefix === ''
        ? builtins
        : builtins.map((tool) => ({
            ...tool,
            name: `${prefix}${tool.name}`,
            execute: tool.execute.bind(tool),
            ...(tool.isConcurrencySafe !== undefined
              ? { isConcurrencySafe: tool.isConcurrencySafe.bind(tool) }
              : {}),
          }));
    if (this.opts.extraTools !== undefined) {
      const extra = typeof this.opts.extraTools === 'function' ? this.opts.extraTools(depth) : this.opts.extraTools;
      tools.push(...extra);
    }
    return tools;
  }

  private createAgent(
    opts: BranchRunnerOptions & {
      readonly initialBoardRev?: number;
      readonly initialManifest?: string;
      readonly initialDocIds?: Iterable<string>;
      readonly initialDocRevs?: Readonly<Record<string, number>>;
    },
  ): AgentFoldAgent {
    const {
      depth,
      maxSteps,
      parent,
      scope,
      initialState,
      followUpQuestion,
      initialBoardRev,
      initialBoardCount,
      initialBoardSnapshot,
      initialManifest,
      initialDocIds,
      initialDocRevs,
      agentName,
      callStack,
      ancestorTasks,
      signal,
    } = opts;
    const llm = depth === 0 ? this.opts.rootLLM : (this.opts.branchLLM ?? this.opts.rootLLM);
    const maxDepth = this.opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const resolvedMaxSteps =
      maxSteps ??
      (depth === 0 ? (this.opts.rootMaxSteps ?? 100) : (this.opts.branchMaxSteps ?? DEFAULT_BRANCH_MAX_STEPS));
    return new AgentFoldAgent({
      ...this.opts.agent,
      llm,
      tools: this.toolsFor(depth, scope),
      store: this.opts.store,
      depth,
      maxDepth,
      ...(parent !== undefined ? { parent } : {}),
      ...(scope !== undefined ? { scope } : {}),
      name: agentName ?? (depth === 0 ? 'root' : `branch#${++this.branchCounter}@${depth}`),
      maxSteps: resolvedMaxSteps,
      usage: this.usage,
      ...(this.opts.onEvent !== undefined ? { onEvent: this.opts.onEvent } : {}),
      ...(signal !== undefined ? { signal } : this.opts.signal !== undefined ? { signal: this.opts.signal } : {}),
      board: this.board,
      ...(initialState !== undefined ? { initialState } : {}),
      ...(followUpQuestion !== undefined ? { followUpQuestion } : {}),
      ...(initialBoardRev !== undefined ? { initialBoardRev } : {}),
      ...(initialBoardCount !== undefined ? { initialBoardCount } : {}),
      ...(initialBoardSnapshot !== undefined ? { initialBoardSnapshot } : {}),
      ...(initialManifest !== undefined ? { initialManifest } : {}),
      ...(initialDocIds !== undefined ? { initialDocIds } : {}),
      ...(initialDocRevs !== undefined ? { initialDocRevs } : {}),
      ...(callStack !== undefined ? { callStack } : {}),
      ...(ancestorTasks !== undefined ? { ancestorTasks } : {}),
    });
  }

  private runAgent(question: string, opts: BranchRunnerOptions): Promise<AgentRunResult> {
    return this.createAgent(opts).run(question);
  }

  /** Prepare the root agent for externally driven steps. */
  begin(question: string, opts?: RootBeginOptions): void {
    if (opts?.initialState === undefined && this.opts.clearTransientOnRun !== false) {
      this.opts.store.clearTransient();
    }
    this.rootAgent = this.createAgent({
      depth: 0,
      parent: 'user',
      ...(opts?.initialState !== undefined ? { initialState: opts.initialState } : {}),
      ...(opts?.followUpQuestion !== undefined ? { followUpQuestion: opts.followUpQuestion } : {}),
      ...(opts?.initialBoardRev !== undefined ? { initialBoardRev: opts.initialBoardRev } : {}),
      ...(opts?.initialBoardCount !== undefined ? { initialBoardCount: opts.initialBoardCount } : {}),
      ...(opts?.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: opts.initialBoardSnapshot } : {}),
      ...(opts?.initialManifest !== undefined ? { initialManifest: opts.initialManifest } : {}),
      ...(opts?.initialDocIds !== undefined ? { initialDocIds: opts.initialDocIds } : {}),
      ...(opts?.initialDocRevs !== undefined ? { initialDocRevs: opts.initialDocRevs } : {}),
    });
    this.rootAgent.begin(question);
  }

  /** Build and cache the root prompt messages for the next step. */
  prepareRootMessages(): ChatMessage[] {
    if (this.rootAgent === undefined) {
      throw new Error('RecursiveAgentFold.begin() must run before prepareRootMessages()');
    }
    return this.rootAgent.prepareMessages();
  }

  /** Produce one root step. */
  async next(): Promise<AgentStep> {
    if (this.rootAgent === undefined) throw new Error('RecursiveAgentFold.begin() must run before next()');
    return this.rootAgent.next();
  }

  /** Snapshot the root fold state. */
  snapshot(): FoldStateSnapshot | undefined {
    return this.rootAgent?.snapshot();
  }

  /** Snapshot any pending root tool step. */
  snapshotPending(): PendingAgentStep | undefined {
    return this.rootAgent?.snapshotPending();
  }

  /** Restore a pending root tool step after a crash. */
  restorePending(pending: PendingAgentStep): void {
    if (!this.rootAgent) throw new Error('restorePending() called before begin()');
    this.rootAgent.restorePending(pending);
  }

  /** Submit single or batched tool observations to the root agent. */
  submit(observation: string | readonly string[], meta?: { readonly error?: string }): void {
    if (this.rootAgent === undefined) throw new Error('RecursiveAgentFold.begin() must run before submit()');
    this.rootAgent.submit(observation, meta);
  }

  run(question: string): Promise<AgentRunResult> {
    if (this.opts.clearTransientOnRun !== false) {
      this.opts.store.clearTransient();
    }
    return this.runAgent(question, { depth: 0, parent: 'user' });
  }
}
