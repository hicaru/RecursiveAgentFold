import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import { FoldState, fallbackSummary, type FoldDirective, type FoldStateSnapshot, type Interaction, type ToolAction } from '../fold/state.js';
import { UsageTracker } from '../llm/usage.js';
import { buildAgentSystemPrompt, FORCE_ANSWER, FORMAT_REMINDER, FORMAT_REPAIR, renderBlockLabel } from '../prompts/agent.js';
import { parseAgentResponse, type ParsedResponse } from '../protocol/parser.js';
import { defaultEstimator, truncateToTokens, type TokenEstimator } from '../tokens.js';
import { coerceToolArguments, formatToolCallXml, renderToolSchemas, type Tool } from '../tools/types.js';
import type { ChatMessage, LLMClient, LLMResponse, LLMUsage } from '../types.js';
import type { AgentEvent, EventSink } from './events.js';

export interface AgentFoldConfig {
  llm: LLMClient;
  tools: Tool[];
  store: ContextStore;
  /** Max tool-calling steps (paper: 100). */
  maxSteps?: number;
  /** Tool observations longer than this are truncated (head+tail). */
  maxObservationTokens?: number;
  /** Minimum retracted blocks required for a mid-run deep fold (default 6). */
  readonly minDeepFoldBlocks?: number;
  /** Re-ask the model when its response cannot be parsed. */
  maxFormatRetries?: number;
  /** Maximum consecutive invalid responses before the step fails (default 3). */
  maxInvalidSteps?: number;
  /** Hard cap on invalid responses across the run (default 6). */
  maxInvalidTotal?: number;
  /** Wall-clock budget for one engine step. Omit to disable. */
  maxStepMs?: number;
  /** Wall-clock budget for one tool execution. Omit to disable. */
  maxToolMs?: number;
  /** Soft cap on rendered prompt tokens. Old summaries condense under pressure. */
  maxPromptTokens?: number;
  /** Provider-reported reasoning budget for one call. Omit to disable. */
  maxReasoningTokens?: number;
  /** After maxSteps, ask once more for a final answer instead of failing. */
  forceAnswerOnLimit?: boolean;
  /** Recursion depth (root = 0). */
  depth?: number;
  /** Agent name used in traces and as usage role ("root", "branch"). */
  name?: string;
  /** Usage role for LLM calls; defaults to depth 0 → "root", else "branch". */
  usageRole?: string;
  usage?: UsageTracker;
  onEvent?: EventSink;
  estimator?: TokenEstimator;
  /** Appended to the system prompt (e.g. domain hints). Keep static for caching. */
  systemPromptExtra?: string;
  temperature?: number;
  signal?: AbortSignal;
  board?: ResearchBoard;
  /** Pre-populated folded state when resuming a scoped specialist sub-agent. */
  readonly initialState?: FoldStateSnapshot;
  /** Follow-up question posed by a peer or parent agent to an existing specialist. */
  readonly followUpQuestion?: string;
  /** Active scope call stack for cycle prevention across inter-agent queries. */
  readonly callStack?: readonly string[];
  readonly ancestorTasks?: readonly string[];
  readonly parent?: string;
  readonly scope?: string;
  readonly maxDepth?: number;
  readonly initialBoardRev?: number;
  readonly initialBoardCount?: number;
  readonly initialBoardSnapshot?: string;
  /** Optional frozen initial manifest string to preserve KV cache across multi-turn continuations. */
  readonly initialManifest?: string;
  /** Optional initial document ID set paired with `initialManifest`. */
  readonly initialDocIds?: Iterable<string>;
}

export type Termination = 'answer' | 'forced_answer' | 'max_steps' | 'error' | 'filtered';

/** Provider safety refusal (Z.ai 1301): no retry loop can repair the payload. */
const PROVIDER_REFUSAL = /\/1301\]|unsafe or sensitive/i;
/** Protocol tags belong outside the answer text. */
const PROTOCOL_TAG = /<\s*\/?\s*(?:think|folding|folded_output|fold|motivation|explanation|tool_call|answer)\b[^>]*>/i;
export const DEFAULT_MAX_OBSERVATION_TOKENS = 3200;
export const DEFAULT_MIN_DEEP_FOLD_BLOCKS = 6;
export const DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS = Number.POSITIVE_INFINITY;

/** Normalize text for the answer-echo guard. */
function echoText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Detect an answer that copies a long part of a fold summary. */
function isSummaryEcho(answer: string, summary: string | undefined): boolean {
  if (summary === undefined) return false;
  const a = echoText(answer);
  const s = echoText(summary);
  if (a.length < 80 || s.length < 80) return false;
  return a === s || s.endsWith(a) || s.startsWith(a);
}

/** Detect a serialized folding directive used as the answer text. */
function isFoldDirectiveAnswer(answer: string): boolean {
  const text = answer.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && Array.isArray(value.range) && typeof value.summary === 'string';
  } catch {
    return /^\{\s*"range"\s*:/.test(text);
  }
}

/** Detect a long answer copied from the raw folding block. */
function isRawAnswerEcho(raw: string, answer: string): boolean {
  const a = echoText(answer);
  if (a.length < 160) return false;
  const match = /<\s*folding\b[^>]*>([\s\S]*?)<\s*\/\s*folding\s*>/i.exec(raw);
  return match !== null && echoText(match[1] ?? '').includes(a);
}

const PLACEHOLDER_ANSWER =
  /^(?:no final answer(?: yet)?|still verifying|continuing verification|verification in progress|pending verification|to be continued|placeholder|todo|tbd|wip)(?:\b|[,.!:;—\-])/i;

export function isPlaceholderAnswer(answer: string): boolean {
  const clean = echoText(answer);
  if (clean === '' || /^[\s.…\-—_]+$/u.test(clean)) return true;
  if (clean.length > 140) return false;
  return (
    PLACEHOLDER_ANSWER.test(clean) ||
    /(?:no final answer(?: yet)?|still verifying|continuing verification|verification in progress|pending verification|need more steps to verify|(?:;\s*|^)(?:proceeding to|continuing to)\s+[a-z])/i.test(clean)
  );
}

/** Salvage a final answer from raw model output when the forcing step exhausts format retries. */
export function extractFallbackAnswer(rawText: string): string | undefined {
  const unclosed = /<\s*answer\b[^>]*>([\s\S]+)$/i.exec(rawText);
  if (unclosed?.[1]) {
    const cleaned = unclosed[1].replace(/<\s*\/?[a-z_]*$/i, '').trim();
    if (cleaned !== '' && !PROTOCOL_TAG.test(cleaned) && !isPlaceholderAnswer(cleaned)) {
      return cleaned;
    }
  }
  const marker = /(?:^|\n)\s*(\[Answer\]\s*[\s\S]+|(?:Final\s+)?Answer\s*:\s*[^\n]+)$/i.exec(rawText);
  if (marker?.[1]) {
    const cleaned = marker[1].trim();
    if (cleaned !== '' && !PROTOCOL_TAG.test(cleaned) && !isPlaceholderAnswer(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}
export interface AgentRunResult {
  answer: string | null;
  steps: number;
  terminated: Termination;
  state: FoldStateSnapshot;
  usage: UsageTracker;
  error?: string;
  /** Count of responses that needed format repair / fallbacks. */
  formatIssues: number;
}

/** One externally driven AgentFold step. */
export type AgentStep =
  | {
      kind: 'tool';
      step: number;
      action: ToolAction;
      motivation: string;
      reasoning?: string;
      text: string;
      /** Sum over every attempt in this engine step. */
      usage: LLMUsage;
      /** Usage of the last completed attempt; use this for context pressure. */
      lastUsage?: LLMUsage;
    }
  | {
      kind: 'answer';
      step: number;
      answer: string;
      reasoning?: string;
      text: string;
      /** Sum over every attempt in this engine step. */
      usage: LLMUsage;
      /** Usage of the last completed attempt; use this for context pressure. */
      lastUsage?: LLMUsage;
      result: AgentRunResult;
    }
  | { kind: 'done'; result: AgentRunResult };

/** A read action, with or without a host tool-name prefix. */
function isReadAction(name: string): boolean {
  return /(?:^|_)read$/.test(name);
}

/** One parsed tool step that waits for the host to submit its observation. */
export interface PendingAgentStep {
  readonly step: number;
  readonly motivation: string;
  readonly action: ToolAction;
}

/**
 * The AgentFold loop (paper §3): perceive → reason → fold → act.
 * One LLM call per step; the context is rebuilt from the fold state each step.
 */
export class AgentFoldAgent {
  readonly name: string;
  readonly depth: number;
  private readonly usage: UsageTracker;
  private readonly estimator: TokenEstimator;
  private readonly toolMap: Map<string, Tool>;
  private readonly systemPrompt: string;
  private readonly initialBoardRev: number;
  private readonly initialBoardSnapshot: string | undefined;
  private readonly initialManifest: string;
  private readonly initialManifestDocIds: ReadonlySet<string>;
  private currentTaskQuestion = '';
  private state: FoldState = new FoldState();
  private startStep = 0;
  private runQuestion = '';
  private formatIssues = 0;
  private invalidSteps = 0;
  private invalidResponses = 0;
  private formatErrorHistory: boolean[] = [];
  private verificationNudged = false;
  private pending: PendingAgentStep | undefined;
  private stepUsage: LLMUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private stepLastUsage: LLMUsage | undefined;
  private stepTimer: ReturnType<typeof setTimeout> | undefined;
  private stepSignal: AbortSignal | undefined;
  private stepOuterAbort: (() => void) | undefined;
  private stepDeadlineStep: number | undefined;
  private started = false;
  private finished = false;
  private inProcessRun = false;
  private runResult: AgentRunResult | undefined;
  private preparedStep: { readonly step: number; readonly messages: ChatMessage[] } | undefined;
  constructor(private readonly cfg: AgentFoldConfig) {
    this.depth = cfg.depth ?? 0;
    this.name = cfg.name ?? (this.depth === 0 ? 'root' : `branch@${this.depth}`);
    this.usage = cfg.usage ?? new UsageTracker();
    this.estimator = cfg.estimator ?? defaultEstimator;
    this.toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
    this.systemPrompt =
      `${buildAgentSystemPrompt(cfg.tools.map((t) => t.name))}\n\n# Tools\n${renderToolSchemas(cfg.tools)}` +
      (cfg.systemPromptExtra ? `\n\n# Notes\n${cfg.systemPromptExtra}` : '');
    this.initialBoardRev =
      cfg.initialBoardRev ?? cfg.initialBoardCount ?? (cfg.board ? cfg.board.settledRev() : 0);
    this.initialBoardSnapshot =
      cfg.initialBoardSnapshot !== undefined
        ? cfg.initialBoardSnapshot
        : cfg.board && this.initialBoardRev > 0
          ? cfg.board.renderSettled()
          : undefined;
    this.initialManifest = cfg.initialManifest ?? cfg.store.manifest();
    const suppliedDocIds = cfg.initialDocIds === undefined ? undefined : new Set(cfg.initialDocIds);
    this.initialManifestDocIds = new Set(
      cfg.store
        .listManifest()
        .filter((doc) => suppliedDocIds === undefined || suppliedDocIds.has(doc.id))
        .map((doc) => doc.id),
    );
  }
  private emit(e: AgentEvent) {
    this.cfg.onEvent?.(e);
  }

  private get role(): string {
    return this.cfg.usageRole ?? (this.depth === 0 ? 'root' : 'branch');
  }

  private get isSpecialist(): boolean {
    return (
      this.depth > 0 ||
      this.cfg.initialState !== undefined ||
      this.cfg.followUpQuestion !== undefined ||
      (this.cfg.name !== undefined && this.cfg.name !== 'root')
    );
  }

  private get maxSteps(): number {
    return this.cfg.maxSteps ?? 100;
  }

  /** Race the provider call against the step abort signal, even if the provider ignores it. */
  private async completeWithSignal(request: Parameters<LLMClient['complete']>[0]): Promise<LLMResponse> {
    const signal = request.signal;
    if (signal === undefined) return this.cfg.llm.complete(request);
    const signalReason = () =>
      signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'));
    if (signal.aborted) throw signalReason();
    const completion = this.cfg.llm.complete(request);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signalReason());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([completion, aborted]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
    }
  }

  private clearStepTimer(): void {
    if (this.stepTimer !== undefined) {
      clearTimeout(this.stepTimer);
      this.stepTimer = undefined;
    }
    this.stepDeadlineStep = undefined;
    this.stepSignal = undefined;
    this.stepOuterAbort?.();
    this.stepOuterAbort = undefined;
  }

  /** Arm one wall-clock budget for the current engine step. */
  private armStepTimeout(step: number): AbortSignal | undefined {
    const maxStepMs = this.cfg.maxStepMs;
    if (maxStepMs === undefined || !Number.isFinite(maxStepMs) || maxStepMs <= 0) return this.cfg.signal;
    if (this.stepDeadlineStep === step && this.stepSignal !== undefined) return this.stepSignal;
    this.clearStepTimer();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`step timeout after ${maxStepMs} ms`));
    }, maxStepMs);
    timer.unref();
    this.stepTimer = timer;
    this.stepDeadlineStep = step;
    const outer = this.cfg.signal;
    if (outer === undefined) {
      this.stepSignal = controller.signal;
      return this.stepSignal;
    }
    if (outer.aborted) {
      controller.abort(outer.reason);
    } else {
      const onOuterAbort = () => controller.abort(outer.reason);
      outer.addEventListener('abort', onOuterAbort, { once: true });
      this.stepOuterAbort = () => outer.removeEventListener('abort', onOuterAbort);
    }
    this.stepSignal = controller.signal;
    return this.stepSignal;
  }

  private addStepUsage(usage: LLMUsage): void {
    this.stepLastUsage = usage;
    this.stepUsage = {
      promptTokens: this.stepUsage.promptTokens + usage.promptTokens,
      completionTokens: this.stepUsage.completionTokens + usage.completionTokens,
      cachedTokens: this.stepUsage.cachedTokens + usage.cachedTokens,
      ...(this.stepUsage.reasoningTokens !== undefined || usage.reasoningTokens !== undefined
        ? { reasoningTokens: (this.stepUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0) }
        : {}),
    };
  }

  /** Current fold state snapshot for host-side persistence. */
  snapshot(): FoldStateSnapshot | undefined {
    return this.started ? this.state.snapshot() : undefined;
  }

  /** Detached pending tool step for host-side crash recovery. */
  snapshotPending(): PendingAgentStep | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    return {
      step: pending.step,
      motivation: pending.motivation,
      action: { name: pending.action.name, arguments: { ...pending.action.arguments } },
    };
  }

  /** Reattach a pending tool step after restoring a snapshot. Never runs the tool. */
  restorePending(pending: PendingAgentStep): void {
    if (!this.started) throw new Error('restorePending() before begin()');
    if (this.finished) throw new Error('restorePending() after run finished');
    if (this.pending !== undefined) throw new Error('restorePending() while another tool step is pending');
    if (pending.step !== this.state.currentStep) {
      throw new Error(`restorePending: expected step ${this.state.currentStep}, got ${pending.step}`);
    }
    this.pending = {
      step: pending.step,
      motivation: pending.motivation,
      action: { name: pending.action.name, arguments: { ...pending.action.arguments } },
    };
    this.preparedStep = undefined;
  }

  private promptTokens(messages: readonly ChatMessage[]): number {
    return this.estimator.count(messages.map((m) => m.content).join('\n'));
  }

  /** Condense old summaries under a prompt budget. Returns diagnostics when it acted. */
  private enforcePromptBudget(
    budget: number,
    step: number,
    tail?: string,
  ): { beforeTokens: number; afterTokens: number; actions: string[] } | undefined {
    const initial = this.promptTokens(this.buildMessages(this.runQuestion, this.state, tail));
    if (initial <= budget) return undefined;
    const actions: string[] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const messages = this.buildMessages(this.runQuestion, this.state, tail);
      if (this.promptTokens(messages) <= budget) break;
      const blocks = this.state.blocks;
      if (blocks.length > 1) {
        const count = Math.max(2, Math.floor(blocks.length / 2));
        const merged = blocks
          .slice(0, count)
          .map((b) => b.summary)
          .join('\n');
        const summary = truncateToTokens(merged, Math.max(32, Math.floor(budget * 0.1)), this.estimator).text;
        if (this.state.condensePrefix(count, summary) !== undefined) {
          actions.push(`condensed ${count} old blocks`);
          continue;
        }
      }
      const latest = this.state.latest;
      if (latest !== undefined) {
        const observationChars = this.estimator.chars(Math.max(64, Math.floor(budget * 0.25)));
        if (this.state.trimLatestObservation(observationChars)) {
          actions.push('shortened latest observation');
          continue;
        }
        const summary = truncateToTokens(
          [...blocks.map((b) => b.summary), fallbackSummary(latest)].join('\n'),
          Math.max(32, Math.floor(budget * 0.15)),
          this.estimator,
        ).text;
        this.state.applyFold({ range: [blocks[0]?.from ?? latest.step, latest.step], summary });
        actions.push('folded latest interaction into a summary');
        continue;
      }
      break;
    }
    const after = this.promptTokens(this.buildMessages(this.runQuestion, this.state, tail));
    if (after > budget) actions.push('prompt still exceeds budget');
    this.emit({
      type: 'context_budget',
      agent: this.name,
      step,
      beforeTokens: initial,
      afterTokens: after,
      actions,
    });
    return { beforeTokens: initial, afterTokens: after, actions };
  }

  /** Build C_t = (Q, T, S, I). Exposed for tests and cache analysis. */
  buildMessages(question: string, state: FoldState, extraUserTail?: string): ChatMessage[] {
    const blocks = state.blocks;
    const latest = state.latest;
    const prev: string[] = ['### Previous Steps'];
    if (blocks.length === 0 && !latest) {
      prev.push('(none)');
    } else {
      for (const b of blocks) prev.push(`**${renderBlockLabel(b)}** ${b.summary}`);
      if (latest) prev.push(renderLatest(latest));
    }
    const parts: string[] = [`### Documents\n${this.initialManifest}`];
    if (this.initialBoardSnapshot) parts.push(`### Shared Research Board\n${this.initialBoardSnapshot}`);
    const isScopedSpecialist =
      this.name.startsWith('specialist#') || (this.depth > 0 && this.cfg.scope !== undefined);
    const scopeLabel = this.cfg.scope ?? this.name;
    const atMaxDepth = this.cfg.maxDepth !== undefined && this.depth >= this.cfg.maxDepth;
    const taskBlock = isScopedSpecialist
      ? atMaxDepth
        ? `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}] at max depth d=${this.depth}. Do NOT call branch on your own scope or unstudied scopes; use search/outline/grep/read/tally on your scope document, or call branch ONLY to query an existing specialist [scope=...] already listed on the board.)`
        : `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}]. Use search/outline/grep/read/tally directly on your scope document and NEVER call branch on your own scope; for cross-module dependencies, check the board first or call branch with the target [scope=...].)`
      : `### Task\n${question.trim()}`;
    parts.push(taskBlock, prev.join('\n'));
    const delta = this.cfg.board?.renderSince(this.initialBoardRev, this.cfg.scope);
    if (delta) parts.push(`### New Board Findings\n${delta}`);
    const allDocs = this.cfg.store.listManifest();
    if (allDocs.length > this.initialManifestDocIds.size) {
      const newDocIds: string[] = [];
      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i];
        if (doc && !this.initialManifestDocIds.has(doc.id)) {
          newDocIds.push(doc.id);
        }
      }
      if (newDocIds.length > 0) {
        parts.push(`### Newly Added Documents\n${this.cfg.store.manifestFor(newDocIds)}`);
      }
    }
    // Only the root owns the branch-report index. A specialist sees its own
    // branch result inline; advertising sibling reports leaks other scopes.
    const storedReports = this.depth === 0 ? this.cfg.store.list().filter((doc) => !doc.manifest) : [];
    if (storedReports.length > 0) {
      const lines = storedReports
        .slice(0, 50)
        .map(
          (doc) =>
            `- id: \`${doc.id}\` — ${doc.title} — ~${doc.tokens.toLocaleString('en-US')} tokens, ${doc.lines.length.toLocaleString('en-US')} lines`,
        );
      if (storedReports.length > 50) lines.push(`... and ${storedReports.length - 50} more stored reports`);
      parts.push(`### Stored Reports\n${lines.join('\n')}`);
    }
    if (this.cfg.followUpQuestion) {
      parts.push(
        `### Follow-up Question\n${this.cfg.followUpQuestion.trim()}\n(Reuse exact key=value facts and formulas already recorded in Previous Steps above if sufficient; if the follow-up asks about a new identifier/index not yet recorded as an explicit key=value in your summaries, verify it with search/outline/grep/read first.)`,
      );
    }
    parts.push(FORMAT_REMINDER(state.currentStep, latest?.step));
    if (extraUserTail) parts.push(extraUserTail);
    return [
      { role: 'system', content: this.systemPrompt, cacheBreakpoint: true },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }

  /** Prepare one run. Call once before `next()`. */
  begin(question: string): void {
    this.currentTaskQuestion = question;
    this.runQuestion = question;
    this.state = this.cfg.initialState ? FoldState.restore(this.cfg.initialState) : new FoldState();
    this.startStep = this.state.currentStep;
    this.formatIssues = 0;
    this.verificationNudged = false;
    this.pending = undefined;
    this.stepUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    this.stepLastUsage = undefined;
    this.invalidSteps = 0;
    this.invalidResponses = 0;
    this.formatErrorHistory = [];
    this.clearStepTimer();
    this.finished = false;
    this.started = true;
    this.inProcessRun = false;
    this.runResult = undefined;
    this.preparedStep = undefined;
    this.emit({
      type: 'run_start',
      agent: this.name,
      depth: this.depth,
      question: this.cfg.followUpQuestion ?? question,
      ...(this.cfg.parent !== undefined ? { parent: this.cfg.parent } : {}),
      ...(this.cfg.scope !== undefined ? { scope: this.cfg.scope } : {}),
      isFollowUp: this.cfg.followUpQuestion !== undefined,
    });
  }

  /**
   * Build and cache the prompt messages for attempt 0 of the current step.
   * Calling `next()` afterwards reuses the exact cached message array.
   */
  prepareMessages(): ChatMessage[] {
    if (!this.started) throw new Error('AgentFoldAgent.prepareMessages() called before begin()');
    const step = this.state.currentStep;
    if (this.preparedStep !== undefined && this.preparedStep.step === step) {
      return this.preparedStep.messages;
    }
    const forcing = step - this.startStep >= this.maxSteps;
    const tail = forcing ? FORCE_ANSWER : undefined;
    let messages = this.buildMessages(this.runQuestion, this.state, tail);
    if (this.cfg.maxPromptTokens !== undefined) {
      const adjusted = this.enforcePromptBudget(this.cfg.maxPromptTokens, step, tail);
      if (adjusted !== undefined) messages = this.buildMessages(this.runQuestion, this.state, tail);
    }
    this.preparedStep = { step, messages };
    return messages;
  }

  /**
   * Produce one step. A tool step stops before execution; the caller executes
   * the action and calls `submit()`, so a host can run the tool natively.
   */
  async next(keepStepUsage = false): Promise<AgentStep> {
    if (!this.started) throw new Error('AgentFoldAgent.next() called before begin()');
    if (this.finished && this.runResult !== undefined) return { kind: 'done', result: this.runResult };
    const step = this.state.currentStep;
    const stepSignal = this.armStepTimeout(step);
    const forcing = step - this.startStep >= this.maxSteps;
    if (forcing && !(this.cfg.forceAnswerOnLimit ?? true)) {
      this.preparedStep = undefined;
      return {
        kind: 'done',
        result: this.finalize({ answer: null, steps: Math.max(0, step - this.startStep), terminated: 'max_steps' }),
      };
    }
    const expectFolding = this.state.latest !== undefined;
    let parsed: ParsedResponse | undefined;
    let outputTruncated = false;
    let lastRawText = '';
    let stepReasoning: string | undefined;
    let tail: string | undefined = forcing ? FORCE_ANSWER : undefined;
    const maxRetries = this.cfg.maxFormatRetries ?? 2;
    if (!keepStepUsage) {
      this.stepUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
      this.stepLastUsage = undefined;
    }
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let messages: ChatMessage[];
      if (attempt === 0 && this.preparedStep !== undefined && this.preparedStep.step === step) {
        messages = this.preparedStep.messages;
        this.preparedStep = undefined;
      } else {
        messages = this.buildMessages(this.runQuestion, this.state, tail);
        if (this.cfg.maxPromptTokens !== undefined) {
          const adjusted = this.enforcePromptBudget(this.cfg.maxPromptTokens, step, tail);
          if (adjusted !== undefined) messages = this.buildMessages(this.runQuestion, this.state, tail);
        }
      }
      if (attempt === 0) {
        this.emit({
          type: 'step_start',
          agent: this.name,
          depth: this.depth,
          step,
          contextTokens: this.estimator.count(messages.map((m) => m.content).join('')),
          blocks: this.state.blocks.length + (this.state.latest ? 1 : 0),
        });
      }
      let text: string;
      let reasoning: string | undefined;
      let truncatedReasoning = false;
      let reasoningOverBudget = false;
      try {
        const res = await this.completeWithSignal({ messages, temperature: this.cfg.temperature, signal: stepSignal, purpose: this.role });
        this.usage.record(this.role, res.usage, res.latencyMs);
        this.addStepUsage(res.usage);
        this.emit({
          type: 'llm_call',
          agent: this.name,
          step,
          role: this.role,
          model: res.model,
          usage: res.usage,
          latencyMs: res.latencyMs,
          ...(res.finishReason !== undefined ? { finishReason: res.finishReason } : {}),
          attempt,
        });
        text = res.text;
        lastRawText = text;
        reasoning = res.reasoning;
        if (reasoning !== undefined) stepReasoning = reasoning;
        outputTruncated = res.finishReason === 'length' || res.finishReason === 'max-tokens';
        // Some OpenAI-compatible providers omit completion_tokens_details.
        // Fall back to the streamed reasoning text so the budget still applies.
        const reportedReasoningTokens = res.usage.reasoningTokens;
        const reasoningTokens =
          reportedReasoningTokens !== undefined && reportedReasoningTokens > 0
            ? reportedReasoningTokens
            : reasoning !== undefined && reasoning !== ''
              ? this.estimator.count(reasoning)
              : 0;
        reasoningOverBudget =
          this.cfg.maxReasoningTokens !== undefined && reasoningTokens > this.cfg.maxReasoningTokens;
        truncatedReasoning =
          text.trim() === '' &&
          (outputTruncated || reasoningTokens >= 8000 || reasoningOverBudget);
        if (text.trim() === '' && reasoning && /<\s*(?:answer|tool_call)\b/i.test(reasoning)) {
          const tagMatch = /<\s*(?:folding|folded_output|fold|motivation|tool_call|answer)\b/i.exec(reasoning);
          if (tagMatch) {
            text = reasoning.slice(tagMatch.index);
          }
        }
        this.emit({ type: 'llm_response', agent: this.name, step, text: text.slice(0, 16_000), ...(reasoning !== undefined ? { reasoning } : {}) });
      } catch (e) {
        this.usage.recordError(this.role);
        const message = (e as Error).message;
        this.emit({ type: 'error', agent: this.name, step, message });
        return {
          kind: 'done',
          result: this.finalize({
            answer: null,
            steps: Math.max(0, step - this.startStep),
            terminated: PROVIDER_REFUSAL.test(message) ? 'filtered' : 'error',
            error: message,
          }),
        };
      }
      const p = parseAgentResponse(text, { expectFolding, reasoning });
      if (outputTruncated && p.answer === undefined && p.toolCall !== undefined) {
        p.errors.push('the <tool_call> hit the output token limit; split it into smaller steps');
      }
      if (this.cfg.maxReasoningTokens !== undefined && reasoningOverBudget) {
        p.errors.push(`reasoning budget exceeded; keep internal thinking under ${this.cfg.maxReasoningTokens} tokens`);
      }
      if (forcing && !p.answer && p.errors.length === 0 && p.toolCall) p.errors.push('a final <answer> is required now');
      if (p.errors.length === 0 && p.answer !== undefined) {
        const answerOpen = /<\s*answer\b/i.test(text);
        const answerClosed = /<\s*\/\s*answer\s*>/i.test(text);
        if (outputTruncated) {
          p.errors.push('the <answer> hit the output token limit; produce a complete, shorter final answer');
        } else if (answerOpen && !answerClosed) {
          p.errors.push('the <answer> is not closed; produce a complete final answer');
        } else if (PROTOCOL_TAG.test(p.answer)) {
          p.errors.push('the <answer> contains a protocol tag; return only the answer text');
        } else if (isFoldDirectiveAnswer(p.answer)) {
          p.errors.push('the <answer> contains a folding directive; emit the fold in <folding> and answer with the actual result');
        }
      }
      if (!forcing && p.errors.length === 0 && p.answer !== undefined && isPlaceholderAnswer(p.answer)) {
        p.errors.push('the <answer> is empty or a verification placeholder; emit a <tool_call> to continue verifying, or output the actual final answer');
      }
      if (p.errors.length === 0 && p.answer !== undefined) {
        const lastBlock = this.state.blocks[this.state.blocks.length - 1];
        const echo =
          [p.folding?.summary, lastBlock?.summary].some((summary) => isSummaryEcho(p.answer ?? '', summary)) ||
          isRawAnswerEcho(text, p.answer);
        if (echo) {
          p.errors.push('the <answer> repeats the folding summary; output a standalone final answer instead');
        }
      }
      if (!forcing && !this.verificationNudged && p.errors.length === 0 && p.answer !== undefined) {
        if (
          this.state.latest !== undefined &&
          p.folding === undefined &&
          isReadAction(this.state.latest.action.name) &&
          this.state.latest.observation.includes('stopped at line ')
        ) {
          this.verificationNudged = true;
          p.errors.push(
            'your previous read stopped mid-window at the token limit and you omitted <folding>; emit <folding> for the previous step and read the remaining lines (or verify all options) before outputting <answer>',
          );
        } else if (
          step === 0 &&
          !this.isSpecialist &&
          p.motivation === undefined &&
          this.cfg.store.manifestTokens() >= 1000 &&
          (this.cfg.board === undefined || this.cfg.board.entries().length === 0)
        ) {
          this.verificationNudged = true;
          p.errors.push(
            'you emitted a bare <answer> at Step 0 without <motivation> or inspecting the documents; call a tool to inspect the documents first',
          );
        }
      }
      if (p.errors.length === 0) {
        parsed = p;
        break;
      }
      this.formatIssues++;
      this.emit({ type: 'format_error', agent: this.name, step, errors: p.errors, attempt, raw: text.slice(0, 4000) });
      tail = [forcing ? FORCE_ANSWER : undefined, FORMAT_REPAIR(p.errors, step, this.state.latest?.step, truncatedReasoning || reasoningOverBudget)].filter(Boolean).join('\n\n');
      parsed = p;
    }
    if (!parsed || parsed.errors.length) {
      // Unrecoverable format failure: if there is any text-like answer, stop; else record a failed step.
      if (forcing) {
        const fallback = extractFallbackAnswer(lastRawText);
        if (fallback !== undefined) {
          this.emit({ type: 'answer', agent: this.name, step, answer: fallback });
          const result = this.finalize({ answer: fallback, steps: step - this.startStep + 1, terminated: 'forced_answer' });
          return {
            kind: 'answer',
            step,
            answer: fallback,
            ...(stepReasoning !== undefined ? { reasoning: stepReasoning } : {}),
            text: lastRawText,
            usage: this.stepUsage,
            ...(this.stepLastUsage !== undefined ? { lastUsage: this.stepLastUsage } : {}),
            result,
          };
        }
        return {
          kind: 'done',
          result: this.finalize({
            answer: null,
            steps: Math.max(0, step - this.startStep),
            terminated: 'max_steps',
            error: parsed?.errors.join('; '),
          }),
        };
      }
      this.invalidSteps += 1;
      this.invalidResponses += 1;
      this.formatErrorHistory.push(true);
      if (this.formatErrorHistory.length > 6) this.formatErrorHistory.shift();
      const windowErrors = this.formatErrorHistory.filter(Boolean).length;
      const maxInvalidSteps = this.cfg.maxInvalidSteps ?? 3;
      const maxInvalidTotal = this.cfg.maxInvalidTotal ?? 6;
      if (
        this.invalidSteps > maxInvalidSteps ||
        this.invalidResponses > maxInvalidTotal ||
        (this.formatErrorHistory.length >= 6 && windowErrors >= Math.max(3, maxInvalidSteps))
      ) {
        return {
          kind: 'done',
          result: this.finalize({
            answer: null,
            steps: Math.max(0, step - this.startStep),
            terminated: 'error',
            error: `format failure limit reached: ${this.invalidResponses} invalid responses total, ${this.invalidSteps} consecutive, ${windowErrors} in last ${this.formatErrorHistory.length} steps (max ${maxInvalidTotal} total / ${maxInvalidSteps} consecutive)`,
          }),
        };
      }
      if (this.state.latest) {
        this.state.applyFold({ range: [this.state.latest.step, this.state.latest.step], summary: fallbackSummary(this.state.latest) });
      }
      this.state.setLatest({
        step,
        motivation: '(invalid response)',
        action: { name: 'none', arguments: {} },
        observation: `Error: your response could not be parsed (${parsed?.errors.join('; ')}). Follow the required tag format.`,
      });
      return this.next(true);
    }

    // A valid step breaks the consecutive-invalid counter.
    this.invalidSteps = 0;
    this.formatErrorHistory.push(false);
    if (this.formatErrorHistory.length > 6) this.formatErrorHistory.shift();
    // FOLD
    if (this.state.latest) {
      if (!parsed.folding) this.formatIssues++;
      const latestStep = this.state.latest.step;
      let requested: FoldDirective = parsed.folding ?? {
        range: [latestStep, latestStep],
        summary: fallbackSummary(this.state.latest),
      };
      let deferredDeep = false;
      const defaultMinDeep = this.depth === 0 ? DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS : DEFAULT_MIN_DEEP_FOLD_BLOCKS;
      const minDeep = this.cfg.minDeepFoldBlocks ?? defaultMinDeep;
      if (requested.range[0] < latestStep && minDeep > 1) {
        const wouldRetract = this.state.blocks.filter((b) => b.to >= requested.range[0]).length;
        if (wouldRetract < minDeep) {
          requested = { range: [latestStep, latestStep], summary: requested.summary };
          deferredDeep = true;
        }
      }
      const outcome = this.state.applyFold(requested);
      if (deferredDeep) {
        outcome.corrections.push(`deep fold (< ${minDeep} blocks) deferred to granular [${latestStep}, ${latestStep}] to preserve cache`);
      }
      this.emit({ type: 'fold', agent: this.name, step, outcome, requested: parsed.folding });
    }

    // ANSWER
    if (parsed.answer !== undefined) {
      if (this.isSpecialist || !this.inProcessRun) {
        const answerStep = this.state.currentStep;
        const queryTag = this.cfg.followUpQuestion
          ? `follow-up "${this.cfg.followUpQuestion.replace(/\s+/g, ' ').slice(0, 60)}"`
          : 'initial task';
        const cleanAns = parsed.answer.replace(/\s+/g, ' ').trim().slice(0, 600);
        this.state.setLatest({
          step: answerStep,
          motivation: queryTag,
          action: { name: 'answer', arguments: {} },
          observation: cleanAns,
        });
        this.state.applyFold({
          range: [answerStep, answerStep],
          summary: `Completed ${queryTag}; result: ${cleanAns}`,
        });
      }
      this.emit({ type: 'answer', agent: this.name, step, answer: parsed.answer });
      const result = this.finalize({ answer: parsed.answer, steps: step - this.startStep + 1, terminated: forcing ? 'forced_answer' : 'answer' });
      return {
        kind: 'answer',
        step,
        answer: parsed.answer,
        ...(stepReasoning !== undefined ? { reasoning: stepReasoning } : {}),
        text: lastRawText,
        usage: this.stepUsage,
        ...(this.stepLastUsage !== undefined ? { lastUsage: this.stepLastUsage } : {}),
        result,
      };
    }

    // ACT
    const action = this.resolveToolAction(parsed.toolCall ?? { name: 'none', arguments: {} });
    const motivation = parsed.motivation ?? '';
    this.pending = { step, motivation, action };
    this.emit({ type: 'tool_call', agent: this.name, step, action, motivation });
    this.clearStepTimer();
    return {
      kind: 'tool',
      step,
      action,
      motivation,
      ...(stepReasoning !== undefined ? { reasoning: stepReasoning } : {}),
      text: lastRawText,
      usage: this.stepUsage,
      ...(this.stepLastUsage !== undefined ? { lastUsage: this.stepLastUsage } : {}),
    };
  }

  /** Feed the observation of the pending tool step back into the fold state. */
  submit(observation: string, meta?: { error?: string }): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error('submit() without a pending tool call');
    this.preparedStep = undefined;
    const { text } = truncateToTokens(observation, this.cfg.maxObservationTokens ?? DEFAULT_MAX_OBSERVATION_TOKENS, this.estimator);
    this.state.setLatest({
      step: pending.step,
      motivation: pending.motivation,
      action: pending.action,
      observation: text,
    });
    this.emit({
      type: 'tool_result',
      agent: this.name,
      step: pending.step,
      name: pending.action.name,
      observation: text,
      tokens: this.estimator.count(text),
      ...(meta?.error !== undefined ? { error: meta.error } : {}),
    });
    this.pending = undefined;
  }

  /** Run the AgentFold loop to completion, executing tools in-process. */
  async run(question: string): Promise<AgentRunResult> {
    this.begin(question);
    this.inProcessRun = true;
    for (;;) {
      const step = await this.next();
      if (step.kind !== 'tool') return step.result;
      const { text, error } = await this.executeTool(step.action.name, step.action.arguments, step.step);
      this.submit(text, error === undefined ? undefined : { error });
    }
  }

  private finalize(r: Omit<AgentRunResult, 'state' | 'usage' | 'formatIssues'>): AgentRunResult {
    if (this.finished && this.runResult !== undefined) return this.runResult;
    this.clearStepTimer();
    this.emit({ type: 'run_end', agent: this.name, depth: this.depth, steps: r.steps, terminated: r.terminated });
    this.finished = true;
    this.runResult = { ...r, state: this.state.snapshot(), usage: this.usage, formatIssues: this.formatIssues };
    return this.runResult;
  }

  /** Route an unprefixed model tool call to its prefixed twin when only that tool exists. */
  private resolveToolAction(action: ToolAction): ToolAction {
    const finalize = (name: string, rawArgs: Record<string, unknown>): ToolAction => ({
      name,
      arguments: coerceToolArguments(rawArgs, this.toolMap.get(name)?.parameters),
    });
    if (
      (action.name === 'read' || action.name === 'grep') &&
      this.toolMap.has(`raf_${action.name}`) &&
      'document' in action.arguments &&
      !('file_path' in action.arguments) &&
      !('path' in action.arguments)
    ) {
      return finalize(`raf_${action.name}`, action.arguments);
    }
    if (this.toolMap.has(action.name)) {
      return finalize(action.name, action.arguments);
    }
    const stripped = action.name.replace(/^(?:raf|ref)_/, '');
    if (stripped !== action.name && this.toolMap.has(stripped)) {
      return finalize(stripped, action.arguments);
    }
    if (this.toolMap.has(`raf_${action.name}`)) {
      return finalize(`raf_${action.name}`, action.arguments);
    }
    for (const candidate of this.toolMap.keys()) {
      if (candidate.endsWith(`_${action.name}`)) {
        return finalize(candidate, action.arguments);
      }
    }
    if (action.name === 'subagent' || action.name === 'sub_agent' || action.name === 'task') {
      const branchTool = this.toolMap.get('branch') ?? [...this.toolMap.keys()].find((k) => k.endsWith('_branch'));
      const branchName = typeof branchTool === 'string' ? branchTool : branchTool?.name;
      if (branchName !== undefined) {
        const rawArgs = action.arguments ?? {};
        const mappedTask =
          typeof rawArgs.task === 'string'
            ? rawArgs.task
            : typeof rawArgs.prompt === 'string'
              ? rawArgs.prompt
              : typeof rawArgs.description === 'string'
                ? rawArgs.description
                : undefined;
        return finalize(branchName, {
          ...rawArgs,
          ...(mappedTask !== undefined && rawArgs.task === undefined ? { task: mappedTask } : {}),
        });
      }
    }
    return action;
  }
  private async executeTool(name: string, args: Record<string, unknown>, step: number): Promise<{ text: string; error?: string }> {
    const tool = this.toolMap.get(name);
    let observation: string;
    let error: string | undefined;
    if (!tool) {
      error = `Unknown tool "${name}"`;
      observation = `Error: unknown tool "${name}". Available tools: ${[...this.toolMap.keys()].join(', ')}`;
    } else {
      const maxToolMs = this.cfg.maxToolMs;
      const timed = maxToolMs !== undefined && Number.isFinite(maxToolMs) && maxToolMs > 0;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let rejectTimeout: ((reason: Error) => void) | undefined;
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        rejectTimeout = reject;
      });
      const outer = this.cfg.signal;
      const onAbort = () => controller.abort(outer?.reason);
      if (timed) {
        timer = setTimeout(() => {
          controller.abort(new Error(`tool timeout after ${maxToolMs} ms: ${name}`));
        }, maxToolMs);
        timer.unref();
        if (outer?.aborted) controller.abort(outer.reason);
        else outer?.addEventListener('abort', onAbort, { once: true });
        controller.signal.addEventListener(
          'abort',
          () => {
            const reason = controller.signal.reason;
            rejectTimeout?.(reason instanceof Error ? reason : new Error(String(reason)));
          },
          { once: true },
        );
        if (controller.signal.aborted) {
          const reason = controller.signal.reason;
          rejectTimeout?.(reason instanceof Error ? reason : new Error(String(reason)));
        }
      }
      try {
        const toolPromise = tool.execute(args, {
          store: this.cfg.store,
          usage: this.usage,
          depth: this.depth,
          agentName: this.name,
          step,
          emit: (e) => this.emit(e),
          signal: timed ? controller.signal : this.cfg.signal,
          board: this.cfg.board,
          callStack: this.cfg.callStack,
          ancestorTasks: [...(this.cfg.ancestorTasks ?? []), this.cfg.followUpQuestion ?? this.currentTaskQuestion],
        });
        observation = timed ? await Promise.race([toolPromise, timeoutPromise]) : await toolPromise;
      } catch (e) {
        error = (e as Error).message;
        observation = `Error: ${error}`;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        outer?.removeEventListener('abort', onAbort);
      }
    }
    return { text: observation, ...(error !== undefined ? { error } : {}) };
  }
}


export function renderLatest(i: Interaction): string {
  return [
    `**[Step ${i.step}]**`,
    `**Motivation:** ${i.motivation || '(none)'}`,
    `**Tool Call:** ${formatToolCallXml(i.action.name, i.action.arguments)}`,
    `**Observation:**\n${i.observation}`,
  ].join('\n');
}
