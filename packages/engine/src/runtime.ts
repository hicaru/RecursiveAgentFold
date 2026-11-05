import { AgentFoldAgent, type AgentFoldConfig, type AgentRunResult } from './agent/agent-fold.js';
import type { EventSink } from './agent/events.js';
import type { ContextStore } from './context/store.js';
import { ResearchBoard } from './context/board.js';
import { UsageTracker } from './llm/usage.js';
import { createBranchTool } from './tools/branch.js';
import { createCalculatorTool } from './tools/calculator.js';
import { createGrepTool, createListDocumentsTool, createReadTool, createTallyTool, type DocumentToolOptions } from './tools/document-tools.js';
import { createLLMQueryTool, LLMQueryEngine, type LLMQueryOptions } from './tools/llm-query.js';
import type { Tool } from './tools/types.js';
import type { LLMClient } from './types.js';

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
  /** Max branch recursion depth (0 disables branching). Default 1. */
  maxDepth?: number;
  rootMaxSteps?: number;
  branchMaxSteps?: number;
  /** Which tools to expose. Default: all available. */
  enable?: Partial<Record<'llm_query' | 'branch' | 'grep' | 'tally' | 'read' | 'list_documents' | 'calculator', boolean>>;
  /** Extra tools (plugins) appended after the built-ins. */
  extraTools?: Tool[];
  agent?: Partial<Omit<AgentFoldConfig, 'llm' | 'tools' | 'store' | 'depth' | 'name' | 'usage' | 'onEvent'>>;
  onEvent?: EventSink;
  usage?: UsageTracker;
  signal?: AbortSignal;
  board?: ResearchBoard;
}

/**
 * Recursive AgentFold runtime.
 *
 * - Root agent: the paper's AgentFold loop (fold every step).
 * - llm_query: a non-thinking reader fanned out over deterministic chunks
 *   (chunk = window × (1 − reserveRatio)), memoized and prefix-cache friendly.
 * - branch: recursive sub-agents with fresh folded contexts (depth ≤ maxDepth).
 * - grep/read: precise follow-up after llm_query located the evidence.
 */
export class RecursiveAgentFold {
  readonly usage: UsageTracker;
  readonly queryEngine?: LLMQueryEngine;
  readonly board: ResearchBoard;
  private branchCounter = 0;

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

  /** Tools for an agent at the given depth (branch tool only below maxDepth). */
  toolsFor(depth: number): Tool[] {
    const en = this.opts.enable ?? {};
    const tools: Tool[] = [];
    if (this.queryEngine) tools.push(createLLMQueryTool(this.queryEngine));
    if (en.grep !== false) tools.push(createGrepTool(this.opts.documentTools));
    if (en.tally !== false) tools.push(createTallyTool());
    if (en.read !== false) tools.push(createReadTool(this.opts.documentTools));
    if (en.list_documents === true) tools.push(createListDocumentsTool());
    if (en.calculator !== false) tools.push(createCalculatorTool());
    if (en.branch !== false && depth < (this.opts.maxDepth ?? 1)) {
      tools.push(
        createBranchTool((task, o) => this.runAgent(task, o.depth, o.maxSteps).then((r) => r), {
          maxBranchSteps: this.opts.branchMaxSteps ?? 20,
        }),
      );
    }
    if (this.opts.extraTools) tools.push(...this.opts.extraTools);
    return tools;
  }

  private runAgent(question: string, depth: number, maxSteps?: number): Promise<AgentRunResult> {
    const llm = depth === 0 ? this.opts.rootLLM : (this.opts.branchLLM ?? this.opts.rootLLM);
    const agent = new AgentFoldAgent({
      ...this.opts.agent,
      llm,
      tools: this.toolsFor(depth),
      store: this.opts.store,
      depth,
      name: depth === 0 ? 'root' : `branch#${++this.branchCounter}@${depth}`,
      maxSteps: maxSteps ?? (depth === 0 ? (this.opts.rootMaxSteps ?? 100) : (this.opts.branchMaxSteps ?? 20)),
      usage: this.usage,
      onEvent: this.opts.onEvent,
      signal: this.opts.signal,
      board: this.board,
    });
    return agent.run(question);
  }

  run(question: string): Promise<AgentRunResult> {
    return this.runAgent(question, 0);
  }
}
