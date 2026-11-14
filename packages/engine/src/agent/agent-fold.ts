import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import {
  FoldState,
  fallbackSummary,
  type FoldDirective,
  type FoldStateSnapshot,
  type Interaction,
  type ToolAction,
} from '../fold/state.js';
import { UsageTracker } from '../llm/usage.js';
import { buildAgentSystemPrompt, FORCE_ANSWER, FORMAT_REMINDER, FORMAT_REPAIR, renderBlockLabel } from '../prompts/agent.js';
import { maskMarkdownCode, parseAgentResponse, type ParsedResponse } from '../protocol/parser.js';
import { defaultEstimator, truncateToTokens, type TokenEstimator } from '../tokens.js';
import { coerceToolArguments, formatToolCallsXml, renderToolSchemas, validateToolArguments, type Tool } from '../tools/types.js';
import type { ChatAttachment, ChatContentSegment, ChatMessage, LLMClient, LLMResponse, LLMUsage } from '../types.js';
import type { AgentEvent, EventSink } from './events.js';

export interface AgentFoldConfig {
  readonly llm: LLMClient;
  readonly tools: readonly Tool[];
  readonly store: ContextStore;
  /** Maximum tool-calling steps per run (default 100). */
  readonly maxSteps?: number;
  /** Maximum tokens kept inline for a tool observation. */
  readonly maxObservationTokens?: number;
  /** Minimum retracted blocks required for a mid-run deep fold. */
  readonly minDeepFoldBlocks?: number;
  /** Maximum format repair retries per step. */
  readonly maxFormatRetries?: number;
  /** Maximum consecutive invalid responses before the run stops (default 3). */
  readonly maxInvalidSteps?: number;
  /** Maximum total invalid responses across the run (default 6). */
  readonly maxInvalidTotal?: number;
  /** Soft cap on rendered prompt tokens. */
  readonly maxPromptTokens?: number;
  /** Maximum tool calls kept from one response. Hosts without batch support set 1. */
  readonly maxToolCallsPerStep?: number;
  /** Provider-reported reasoning token cap per call. */
  readonly maxReasoningTokens?: number;
  /** Ask once for a final answer when maxSteps is reached. */
  readonly forceAnswerOnLimit?: boolean;
  /** Recursion depth (root = 0). */
  readonly depth?: number;
  /** Agent identifier used in events and usage roles. */
  readonly name?: string;
  /** Usage role for LLM calls (defaults to "root" at depth 0, else "branch"). */
  readonly usageRole?: string;
  readonly usage?: UsageTracker;
  readonly onEvent?: EventSink;
  readonly estimator?: TokenEstimator;
  /** Static domain instructions appended to the system prompt. */
  readonly systemPromptExtra?: string;
  readonly systemPromptAddendum?: string;
  readonly initialAttachments?: readonly ChatAttachment[];
  readonly maxManifestTokens?: number;
  readonly maxGranularBlocks?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
  readonly board?: ResearchBoard;
  /** Pre-populated folded state for multi-turn or specialist continuation. */
  readonly initialState?: FoldStateSnapshot;
  /** Follow-up question posed in a continuation turn. */
  readonly followUpQuestion?: string;
  /** Active scope call stack for cycle prevention. */
  readonly callStack?: readonly string[];
  readonly ancestorTasks?: readonly string[];
  readonly parent?: string;
  readonly scope?: string;
  readonly cwd?: string;
  readonly maxDepth?: number;
  readonly initialBoardRev?: number;
  readonly initialBoardCount?: number;
  readonly initialBoardSnapshot?: string;
  /** Frozen initial manifest text for KV-cache preservation. */
  readonly initialManifest?: string;
  /** Initial document IDs paired with initialManifest. */
  readonly initialDocIds?: Iterable<string>;
  /** Initial document revisions paired with initialManifest. */
  readonly initialDocRevs?: Readonly<Record<string, number>>;
}

export type Termination = 'answer' | 'forced_answer' | 'max_steps' | 'error' | 'filtered';

/** Provider safety refusal (Z.ai 1301) cannot recover via format retry. */
const PROVIDER_REFUSAL = /\/1301\]|unsafe or sensitive/i;
/** Protocol tags must not appear inside final answer text. */
const PROTOCOL_TAG = /<\s*\/?\s*(?:think|folding|folded_output|fold|motivation|explanation|tool_call|answer)\b[^>]*>/i;
/** Store-backed tools already keep their underlying data in ContextStore. */
const STORE_BACKED_TOOLS = /^(?:(?:raf|ref)_)?(?:read|grep|search|outline|tally|list_documents|add_document|branch)$/;

export const DEFAULT_MAX_OBSERVATION_TOKENS = 3200;
export const DEFAULT_MIN_DEEP_FOLD_BLOCKS = 6;
export const DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS = Number.POSITIVE_INFINITY;

function echoText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isSummaryEcho(answer: string, summary?: string): boolean {
  if (summary === undefined) return false;
  const a = echoText(answer);
  const s = echoText(summary);
  if (a.length < 80 || s.length < 80) return false;
  return a === s || s.endsWith(a) || s.startsWith(a);
}

function isFoldDirectiveAnswer(answer: string): boolean {
  const text = answer.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object') return false;
    const rec = value as Record<string, unknown>;
    return Array.isArray(rec.range) && typeof rec.summary === 'string';
  } catch {
    return /^\{\s*"range"\s*:/.test(text);
  }
}

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
    /(?:no final answer(?: yet)?|still verifying|continuing verification|verification in progress|pending verification|need more steps to verify|(?:;\s*|^)(?:proceeding to|continuing to)\s+[a-z])/i.test(
      clean,
    )
  );
}

/** Salvage a final answer from raw output when the forced final step exhausts retries. */
export function extractFallbackAnswer(rawText: string): string | undefined {
  const unclosed = /<\s*answer\b[^>]*>([\s\S]+)$/i.exec(rawText);
  if (unclosed?.[1]) {
    const cleaned = unclosed[1].replace(/<\s*\/?[a-z_]*$/i, '').trim();
    if (cleaned !== '' && !PROTOCOL_TAG.test(cleaned) && !isPlaceholderAnswer(cleaned)) {
      return cleaned;
    }
  }
  const marker = /(?:^|\n)\s*(\[Answer\]\s*[\s\S]+|\[答案\]\s*[\s\S]+|(?:Final\s+)?Answer\s*:\s*[^\n]+|答案\s*[:：]\s*[^\n]+)$/i.exec(
    rawText,
  );
  if (marker?.[1]) {
    const cleaned = marker[1].trim();
    if (cleaned !== '' && !PROTOCOL_TAG.test(cleaned) && !isPlaceholderAnswer(cleaned)) {
      return cleaned;
    }
  }
  return undefined;
}

export interface AgentRunResult {
  readonly answer: string | null;
  readonly steps: number;
  readonly terminated: Termination;
  readonly state: FoldStateSnapshot;
  readonly usage: UsageTracker;
  readonly error?: string;
  readonly formatIssues: number;
}

export type AgentStep =
  | {
      readonly kind: 'tool';
      readonly step: number;
      readonly action: ToolAction;
      readonly actions: readonly ToolAction[];
      readonly motivation: string;
      readonly reasoning?: string;
      readonly text: string;
      readonly usage: LLMUsage;
      readonly lastUsage?: LLMUsage;
    }
  | {
      readonly kind: 'answer';
      readonly step: number;
      readonly answer: string;
      readonly reasoning?: string;
      readonly text: string;
      readonly usage: LLMUsage;
      readonly lastUsage?: LLMUsage;
      readonly result: AgentRunResult;
    }
  | { readonly kind: 'done'; readonly result: AgentRunResult };

function isReadAction(name: string): boolean {
  return /(?:^|_)read$/.test(name);
}

export interface PendingAgentStep {
  readonly step: number;
  readonly motivation: string;
  readonly action: ToolAction;
  readonly actions?: readonly ToolAction[];
  readonly droppedActions?: readonly string[];
}

function cloneAction(action: ToolAction): ToolAction {
  return { name: action.name, arguments: { ...action.arguments } };
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  const reasonError = () =>
    signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? 'aborted'));
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(reasonError());
  }
  promise.catch(() => {});
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(reasonError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  });
}

function renderBoundedManifest(store: ContextStore, maxTokens: number, estimator: TokenEstimator): string {
  const docs = store.listManifest();
  if (docs.length === 0) return '(no documents loaded)';
  const rootDocs: typeof docs = [];
  const groups = new Map<string, { count: number; tokens: number }>();
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    if (!d) continue;
    const slash = d.id.indexOf('/');
    if (slash < 0) {
      rootDocs.push(d);
    } else {
      const prefix = d.id.slice(0, slash + 1);
      const g = groups.get(prefix);
      if (g) {
        g.count += 1;
        g.tokens += d.tokens;
      } else {
        groups.set(prefix, { count: 1, tokens: d.tokens });
      }
    }
  }
  const lines: string[] = [];
  const rootLimit = 20;
  for (let i = 0; i < Math.min(rootDocs.length, rootLimit); i++) {
    const d = rootDocs[i];
    if (!d) continue;
    lines.push(
      `- id: \`${d.id}\` — ${d.title} — ~${d.tokens.toLocaleString('en-US')} tokens, ${d.lines.length.toLocaleString('en-US')} lines`,
    );
  }
  if (rootDocs.length > rootLimit) {
    lines.push(`... and ${rootDocs.length - rootLimit} more root files (use list_documents)`);
  }
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  for (const [prefix, g] of sortedGroups) {
    lines.push(
      `- prefix \`${prefix}\`: ${g.count} document(s) (~${g.tokens.toLocaleString('en-US')} tokens) — use list_documents(prefix="${prefix}"), search, or grep`,
    );
  }
  return truncateToTokens(lines.join('\n'), maxTokens, estimator).text;
}

/**
 * The AgentFold loop: perceive, reason, fold, and act.
 * Context is rebuilt deterministically from the fold state on every step.
 */
export class AgentFoldAgent {
  readonly name: string;
  readonly depth: number;
  private readonly usage: UsageTracker;
  private readonly estimator: TokenEstimator;
  private readonly toolMap: Map<string, Tool>;
  private readonly systemPrompt: string;
  private readonly initialBoardRev: number;
  private readonly initialBoardSnapshot?: string;
  private readonly initialManifest: string;
  private readonly initialManifestDocRevs: ReadonlyMap<string, number>;
  private currentTaskQuestion = '';
  private state: FoldState = new FoldState();
  private startStep = 0;
  private runQuestion = '';
  private formatIssues = 0;
  private invalidSteps = 0;
  private invalidResponses = 0;
  private formatErrorHistory: boolean[] = [];
  private verificationNudged = false;
  private pending?: PendingAgentStep;
  private stepUsage: LLMUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private stepLastUsage?: LLMUsage;
  private started = false;
  private finished = false;
  private inProcessRun = false;
  private runResult?: AgentRunResult;
  private preparedStep?: { readonly step: number; readonly messages: ChatMessage[] };
  private tokenScale = 1;

  constructor(private readonly cfg: AgentFoldConfig) {
    this.depth = cfg.depth ?? 0;
    this.name = cfg.name ?? (this.depth === 0 ? 'root' : `branch@${this.depth}`);
    this.usage = cfg.usage ?? new UsageTracker();
    this.estimator = cfg.estimator ?? defaultEstimator;
    this.toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
    const defaultMinDeep = this.depth === 0 ? DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS : DEFAULT_MIN_DEEP_FOLD_BLOCKS;
    const minDeepFoldBlocks = cfg.minDeepFoldBlocks ?? defaultMinDeep;
    this.systemPrompt =
      `${buildAgentSystemPrompt(
        cfg.tools.map((t) => t.name),
        { minDeepFoldBlocks },
      )}\n\n# Tools\n${renderToolSchemas(cfg.tools)}` +
      (cfg.systemPromptExtra ? `\n\n# Notes\n${cfg.systemPromptExtra}` : '') +
      (cfg.systemPromptAddendum ? `\n\n${cfg.systemPromptAddendum}` : '');
    this.initialBoardRev =
      cfg.initialBoardRev ?? cfg.initialBoardCount ?? (cfg.board ? cfg.board.settledRev() : 0);
    const boardSnap =
      cfg.initialBoardSnapshot !== undefined
        ? cfg.initialBoardSnapshot
        : cfg.board && this.initialBoardRev > 0
          ? cfg.board.renderSettled()
          : undefined;
    if (boardSnap !== undefined) this.initialBoardSnapshot = boardSnap;
    const rawManifest = cfg.initialManifest ?? cfg.store.manifest();
    const maxManifestTokens = cfg.maxManifestTokens ?? 8_000;
    this.initialManifest =
      cfg.initialManifest === undefined && maxManifestTokens > 0 && this.estimator.count(rawManifest) > maxManifestTokens
        ? renderBoundedManifest(cfg.store, maxManifestTokens, this.estimator)
        : rawManifest;
    const suppliedDocIds = cfg.initialDocIds === undefined ? undefined : new Set(cfg.initialDocIds);
    const docRevs = new Map<string, number>();
    for (const doc of cfg.store.listManifest()) {
      if (suppliedDocIds === undefined || suppliedDocIds.has(doc.id)) {
        const baselineRev = cfg.initialDocRevs?.[doc.id] ?? doc.rev;
        docRevs.set(doc.id, baselineRev);
      }
    }
    this.initialManifestDocRevs = docRevs;
  }
  private emit(e: AgentEvent): void {
    this.cfg.onEvent?.(e);
  }

  private get role(): string {
    return this.cfg.usageRole ?? (this.depth === 0 ? 'root' : 'branch');
  }

  private get isSpecialist(): boolean {
    return this.depth > 0;
  }

  private get maxSteps(): number {
    return this.cfg.maxSteps ?? 100;
  }

  private get priority(): number {
    return this.depth === 0 ? 0 : 1;
  }

  private completeWithSignal(request: Parameters<LLMClient['complete']>[0]): Promise<LLMResponse> {
    return raceAbort(this.cfg.llm.complete(request), request.signal);
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

  /** Return a snapshot of the current fold state. */
  snapshot(): FoldStateSnapshot | undefined {
    return this.started ? this.state.snapshot() : undefined;
  }

  /** Return a detached copy of the pending tool step. */
  snapshotPending(): PendingAgentStep | undefined {
    const pending = this.pending;
    if (pending === undefined) return undefined;
    const actions = pending.actions ? pending.actions.map(cloneAction) : [cloneAction(pending.action)];
    return {
      step: pending.step,
      motivation: pending.motivation,
      action: cloneAction(pending.action),
      actions,
      ...(pending.droppedActions !== undefined ? { droppedActions: [...pending.droppedActions] } : {}),
    };
  }

  /** Restore a detached pending tool step without re-running tools. */
  restorePending(pending: PendingAgentStep): void {
    if (!this.started) throw new Error('restorePending() before begin()');
    if (this.finished) throw new Error('restorePending() after run finished');
    if (this.pending !== undefined) throw new Error('restorePending() while another tool step is pending');
    if (pending.step !== this.state.currentStep) {
      throw new Error(`restorePending: expected step ${this.state.currentStep}, got ${pending.step}`);
    }
    const actions =
      pending.actions && pending.actions.length > 0
        ? pending.actions.map(cloneAction)
        : [cloneAction(pending.action)];
    const primary = actions[0] ?? cloneAction(pending.action);
    this.pending = {
      step: pending.step,
      motivation: pending.motivation,
      action: primary,
      actions,
      ...(pending.droppedActions !== undefined ? { droppedActions: [...pending.droppedActions] } : {}),
    };
    this.preparedStep = undefined;
  }

  private promptTokens(messages: readonly ChatMessage[]): number {
    return Math.ceil(this.estimator.count(messages.map((m) => m.content).join('\n')) * this.tokenScale);
  }

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

  /**
   * Build the 4-zone cache-optimal context:
   * - Zone 0 (system, cached): instructions + tool schemas
   * - Zone 1 (user seg 0, cached): frozen manifest + initial board + task + Previous Steps header
   * - Zone 2 (user seg 1, cached): append-only compressed fold blocks
   * - Zone 3a (user seg 2, cached): semi-static turn/session deltas (follow-up, added/updated docs, board delta, reports)
   * - Zone 3b (user seg 3, uncached): volatile latest step + current step reminder + repair tail
   */
  buildMessages(question: string, state: FoldState, extraUserTail?: string): ChatMessage[] {
    const blocks = state.blocks;
    const latest = state.latest;
    const isScopedSpecialist =
      this.name.startsWith('specialist#') || (this.depth > 0 && this.cfg.scope !== undefined);
    const scopeLabel = this.cfg.scope ?? this.name;
    const atMaxDepth = this.cfg.maxDepth !== undefined && this.depth >= this.cfg.maxDepth;
    const taskBlock = isScopedSpecialist
      ? atMaxDepth
        ? `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}] at max depth d=${this.depth}. Do not call branch on your own scope or unstudied scopes. Use search, outline, grep, read, or tally on your scope document, or consult an existing specialist on the board.)`
        : `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}]. Use search, outline, grep, read, or tally directly on your scope document. Never call branch on your own scope.)`
      : `### Task\n${question.trim()}`;

    const zone1Parts: string[] = [`### Documents\n${this.initialManifest}`];
    if (this.initialBoardSnapshot) {
      zone1Parts.push(`### Shared Research Board\n${this.initialBoardSnapshot}`);
    }
    zone1Parts.push(taskBlock);
    const zone1 = `${zone1Parts.join('\n\n')}\n\n### Previous Steps\n`;

    let zone2 = '';
    if (blocks.length === 0 && latest === undefined) {
      zone2 = '(none)';
    } else if (blocks.length > 0) {
      const blockLines: string[] = new Array(blocks.length);
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        blockLines[i] = b ? `**${renderBlockLabel(b)}** ${b.summary}` : '';
      }
      zone2 = blockLines.join('\n');
    }

    const zone3a = this.cfg.followUpQuestion
      ? `\n\n### Follow-up Question\n${this.cfg.followUpQuestion.trim()}\n(Reuse exact key=value facts and formulas already recorded in Previous Steps above if sufficient. Verify any new identifier or index with search, outline, grep, or read first.)`
      : '';

    const zone3bParts: string[] = [];
    const allDocs = this.cfg.store.listManifest();
    const changedDocIds: string[] = [];
    for (let i = 0; i < allDocs.length; i++) {
      const doc = allDocs[i];
      if (!doc) continue;
      const initialRev = this.initialManifestDocRevs.get(doc.id);
      if (initialRev === undefined || doc.rev > initialRev) {
        changedDocIds.push(doc.id);
      }
    }
    if (changedDocIds.length > 0) {
      zone3bParts.push(`\n\n### Newly Added Documents\n${this.cfg.store.manifestFor(changedDocIds)}`);
    }
    const delta = this.cfg.board?.renderSince(this.initialBoardRev, this.cfg.scope);
    if (delta) {
      zone3bParts.push(`\n\n### New Board Findings\n${delta}`);
    }
    const storedReports = this.depth === 0 ? this.cfg.store.list().filter((doc) => !doc.manifest) : [];
    if (storedReports.length > 0) {
      const lines = storedReports
        .slice(0, 50)
        .map(
          (doc) =>
            `- id: \`${doc.id}\` — ${doc.title} — ~${doc.tokens.toLocaleString('en-US')} tokens, ${doc.lines.length.toLocaleString('en-US')} lines`,
        );
      if (storedReports.length > 50) lines.push(`... and ${storedReports.length - 50} more stored reports`);
      zone3bParts.push(`\n\n### Stored Reports\n${lines.join('\n')}`);
    }
    if (latest !== undefined) {
      if (zone3bParts.length > 0 || zone3a !== '') {
        zone3bParts.push(`\n\n${renderLatest(latest)}`);
      } else if (blocks.length > 0) {
        zone3bParts.push(`\n${renderLatest(latest)}`);
      } else {
        zone3bParts.push(renderLatest(latest));
      }
    }
    zone3bParts.push(`\n\n${FORMAT_REMINDER(state.currentStep, latest?.step)}`);
    if (extraUserTail) zone3bParts.push(`\n\n${extraUserTail}`);
    const zone3b = zone3bParts.join('');

    const userSegments: ChatContentSegment[] = [{ text: zone1, cacheBreakpoint: true }];
    if (zone2 !== '') userSegments.push({ text: zone2, cacheBreakpoint: true });
    if (zone3a !== '') userSegments.push({ text: zone3a, cacheBreakpoint: true });
    userSegments.push({ text: zone3b });

    const userContent = `${zone1}${zone2}${zone3a}${zone3b}`;
    return [
      {
        role: 'system',
        content: this.systemPrompt,
        cacheBreakpoint: true,
        segments: [{ text: this.systemPrompt, cacheBreakpoint: true }],
      },
      {
        role: 'user',
        content: userContent,
        segments: userSegments,
        ...(this.cfg.initialAttachments !== undefined && this.cfg.initialAttachments.length > 0
          ? { attachments: this.cfg.initialAttachments }
          : {}),
      },
    ];
  }

  /** Initialize a new run before calling `next()`. */
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

  /** Build and cache attempt-0 prompt messages for the current step. */
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

  /** Advance one step. A tool step pauses so a host can execute tool calls natively. */
  async next(keepStepUsage = false): Promise<AgentStep> {
    if (!this.started) throw new Error('AgentFoldAgent.next() called before begin()');
    if (this.finished && this.runResult !== undefined) return { kind: 'done', result: this.runResult };

    for (let preserveUsage = keepStepUsage; ; preserveUsage = true) {
      const step = this.state.currentStep;
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
      if (!preserveUsage) {
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
          const rawEst = Math.max(1, this.estimator.count(messages.map((m) => m.content).join('\n')));
          const res = await this.completeWithSignal({
            messages,
            temperature: this.cfg.temperature,
            signal: this.cfg.signal,
            purpose: this.role,
            cacheKey: `${this.name}:d${this.depth}`,
            priority: this.priority,
          });
          if (res.usage.promptTokens > 0) {
            this.tokenScale = Math.min(2.5, Math.max(0.8, res.usage.promptTokens / rawEst));
          }
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
            text.trim() === '' && (outputTruncated || reasoningTokens >= 8000 || reasoningOverBudget);
          if (text.trim() === '' && reasoning && /<\s*\/\s*(?:answer|tool_call)\s*>/i.test(reasoning)) {
            const tagMatch = /<\s*(?:folding|folded_output|fold|motivation|tool_call|answer)\b/i.exec(reasoning);
            if (tagMatch) {
              text = reasoning.slice(tagMatch.index);
            }
          }
          this.emit({
            type: 'llm_response',
            agent: this.name,
            step,
            text: text.slice(0, 16_000),
            ...(reasoning !== undefined ? { reasoning } : {}),
          });
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
          p.errors.push(
            `reasoning budget exceeded; keep internal thinking under ${this.cfg.maxReasoningTokens} tokens`,
          );
        }
        if (forcing && !p.answer && p.errors.length === 0 && p.toolCall) {
          p.errors.push('a final <answer> is required now');
        }
        if (p.errors.length === 0 && p.answer !== undefined) {
          const maskedText = maskMarkdownCode(text);
          const answerOpen = /<\s*answer\b/i.test(maskedText);
          const answerClosed = /<\s*\/\s*answer\s*>/i.test(maskedText);
          if (outputTruncated) {
            p.errors.push('the <answer> hit the output token limit; produce a complete, shorter final answer');
          } else if (answerOpen && !answerClosed) {
            p.errors.push('the <answer> is not closed; produce a complete final answer');
          } else if (PROTOCOL_TAG.test(maskMarkdownCode(p.answer))) {
            p.errors.push('the <answer> contains a protocol tag; return only the answer text');
          } else if (isFoldDirectiveAnswer(p.answer)) {
            p.errors.push(
              'the <answer> contains a folding directive; emit the fold in <folding> and answer with the actual result',
            );
          }
        }
        if (!forcing && p.errors.length === 0 && p.answer !== undefined && isPlaceholderAnswer(p.answer)) {
          p.errors.push(
            'the <answer> is empty or a verification placeholder; emit a <tool_call> to continue verifying, or output the actual final answer',
          );
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
        if (
          !forcing &&
          !this.verificationNudged &&
          p.errors.length === 0 &&
          p.answer !== undefined &&
          this.state.latest !== undefined &&
          p.folding === undefined &&
          isReadAction(this.state.latest.action.name) &&
          this.state.latest.observation.includes('stopped at line ')
        ) {
          this.verificationNudged = true;
          p.errors.push(
            'your previous read stopped mid-window at the token limit and you omitted <folding>; emit <folding> for the previous step and read the remaining lines before outputting <answer>',
          );
        }
        if (p.errors.length === 0 && p.answer === undefined) {
          const candidateActions = p.toolCalls && p.toolCalls.length > 0 ? p.toolCalls : p.toolCall ? [p.toolCall] : [];
          for (const rawAct of candidateActions) {
            const resolved = this.resolveToolAction(rawAct);
            const tool = this.toolMap.get(resolved.name);
            const validationErrors = validateToolArguments(resolved.name, resolved.arguments, tool?.parameters);
            if (validationErrors.length > 0) p.errors.push(...validationErrors);
          }
        }
        if (p.errors.length === 0) {
          parsed = p;
          break;
        }
        this.formatIssues++;
        this.emit({ type: 'format_error', agent: this.name, step, errors: p.errors, attempt, raw: text.slice(0, 4000) });
        tail = [
          forcing ? FORCE_ANSWER : undefined,
          FORMAT_REPAIR(p.errors, step, this.state.latest?.step, truncatedReasoning || reasoningOverBudget),
        ]
          .filter(Boolean)
          .join('\n\n');
        parsed = p;
      }

      if (!parsed || parsed.errors.length > 0) {
        if (forcing) {
          const fallback = extractFallbackAnswer(lastRawText);
          if (fallback !== undefined) {
            this.emit({ type: 'answer', agent: this.name, step, answer: fallback });
            const result = this.finalize({
              answer: fallback,
              steps: step - this.startStep + 1,
              terminated: 'forced_answer',
            });
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
          this.state.applyFold({
            range: [this.state.latest.step, this.state.latest.step],
            summary: fallbackSummary(this.state.latest),
          });
        }
        this.state.setLatest({
          step,
          motivation: '(invalid response)',
          action: { name: 'none', arguments: {} },
          observation: `Error: your response could not be parsed (${parsed?.errors.join('; ')}). Follow the required tag format.`,
        });
        continue;
      }

      this.invalidSteps = 0;
      this.formatErrorHistory.push(false);
      if (this.formatErrorHistory.length > 6) this.formatErrorHistory.shift();

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
          outcome.corrections.push(
            `deep fold (< ${minDeep} blocks) deferred to granular [${latestStep}, ${latestStep}] to preserve cache`,
          );
        }
        this.emit({ type: 'fold', agent: this.name, step, outcome, requested: parsed.folding });
        const maxGranular = this.cfg.maxGranularBlocks ?? 48;
        if (maxGranular > 2 && this.state.blocks.length > maxGranular) {
          const epochSize = Math.min(24, Math.max(2, Math.floor(maxGranular / 2)));
          const oldest = this.state.blocks.slice(0, epochSize);
          const joined = oldest
            .map((b) => `[${b.from === b.to ? b.from : `${b.from}-${b.to}`}] ${b.summary}`)
            .join(' | ');
          const compactSummary = truncateToTokens(joined, 1200, this.estimator).text;
          this.state.condensePrefix(epochSize, compactSummary);
        }
      }
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
        const result = this.finalize({
          answer: parsed.answer,
          steps: step - this.startStep + 1,
          terminated: forcing ? 'forced_answer' : 'answer',
        });
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

      const allParsedActions =
        parsed.toolCalls && parsed.toolCalls.length > 0
          ? parsed.toolCalls
          : [parsed.toolCall ?? { name: 'none', arguments: {} }];
      const toolCallLimit = Math.max(1, this.cfg.maxToolCallsPerStep ?? Number.POSITIVE_INFINITY);
      const rawActions = allParsedActions.slice(0, toolCallLimit);
      const droppedActions =
        allParsedActions.length > rawActions.length
          ? allParsedActions.slice(rawActions.length).map((a) => a.name)
          : undefined;
      const actions = rawActions.map((a) => this.resolveToolAction(a));
      const action = actions[0] ?? { name: 'none', arguments: {} };
      const motivation = parsed.motivation ?? '';
      this.pending = {
        step,
        motivation,
        action,
        actions,
        ...(droppedActions !== undefined ? { droppedActions } : {}),
      };
      this.emit({ type: 'tool_call', agent: this.name, step, action, actions, motivation });
      return {
        kind: 'tool',
        step,
        action,
        actions,
        motivation,
        ...(stepReasoning !== undefined ? { reasoning: stepReasoning } : {}),
        text: lastRawText,
        usage: this.stepUsage,
        ...(this.stepLastUsage !== undefined ? { lastUsage: this.stepLastUsage } : {}),
      };
    }
  }

  /** Submit single or batched tool observations for the pending step. */
  submit(observation: string | readonly string[], meta?: { readonly error?: string }): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error('submit() without a pending tool call');
    this.preparedStep = undefined;
    const actions = pending.actions && pending.actions.length > 0 ? pending.actions : [pending.action];
    let rawObservation: string;
    if (typeof observation === 'string') {
      rawObservation = observation;
    } else if (actions.length <= 1) {
      rawObservation = observation[0] ?? '';
    } else {
      const parts: string[] = new Array(actions.length);
      for (let i = 0; i < actions.length; i++) {
        const act = actions[i];
        parts[i] = `[Tool ${i + 1}/${actions.length}: ${act?.name ?? 'unknown'}]\n${observation[i] ?? ''}`;
      }
      rawObservation = parts.join('\n\n');
    }
    if (pending.droppedActions && pending.droppedActions.length > 0) {
      const limit = Math.max(1, this.cfg.maxToolCallsPerStep ?? 1);
      rawObservation =
        `[Note: ${pending.droppedActions.length} additional <tool_call> block(s) (${pending.droppedActions.join(', ')}) exceeded maxToolCallsPerStep=${limit} and were NOT executed; re-emit them in the next step if still needed.]\n\n` +
        rawObservation;
    }
    const maxTokens = this.cfg.maxObservationTokens ?? DEFAULT_MAX_OBSERVATION_TOKENS;
    const { text: truncatedText, truncated } = truncateToTokens(rawObservation, maxTokens, this.estimator);
    let finalObservation = truncatedText;
    if (truncated && actions.some((a) => !STORE_BACKED_TOOLS.test(a.name))) {
      const safeName = this.name.replace(/[^a-zA-Z0-9_-]+/g, '_');
      const obsDoc = this.cfg.store.add(rawObservation, {
        id: `tool_obs_${safeName}_s${pending.step}`,
        title: `Tool output at step ${pending.step} (${actions.map((a) => a.name).join(', ')})`,
        manifest: false,
        transient: true,
      });
      finalObservation = `${truncatedText}\n[Full untruncated output stored as document "${obsDoc.id}" (${obsDoc.lines.length} lines) — use read or grep if needed]`;
    }

    this.state.setLatest({
      step: pending.step,
      motivation: pending.motivation,
      action: pending.action,
      ...(actions.length > 1 ? { actions } : {}),
      observation: finalObservation,
    });
    const combinedName = actions.length > 1 ? actions.map((a) => a.name).join('+') : pending.action.name;
    this.emit({
      type: 'tool_result',
      agent: this.name,
      step: pending.step,
      name: combinedName,
      observation: finalObservation,
      tokens: this.estimator.count(finalObservation),
      ...(meta?.error !== undefined ? { error: meta.error } : {}),
    });
    this.pending = undefined;
  }

  /** Run the AgentFold loop in-process with wave-parallel tool execution. */
  async run(question: string): Promise<AgentRunResult> {
    this.begin(question);
    this.inProcessRun = true;
    for (;;) {
      const step = await this.next();
      if (step.kind !== 'tool') return step.result;
      const actions = step.actions;
      if (actions.length <= 1) {
        const { text, error } = await this.executeTool(step.action.name, step.action.arguments, step.step);
        this.submit(text, error === undefined ? undefined : { error });
        continue;
      }
      const observations: string[] = new Array(actions.length);
      const errors: string[] = [];
      let idx = 0;
      while (idx < actions.length) {
        const first = actions[idx];
        if (!first) {
          observations[idx] = '';
          idx++;
          continue;
        }
        const firstSafe = this.isActionConcurrencySafe(first);
        if (!firstSafe) {
          const res = await this.executeTool(first.name, first.arguments, step.step);
          observations[idx] = res.text;
          if (res.error !== undefined) errors.push(res.error);
          idx++;
          continue;
        }
        let end = idx + 1;
        while (end < actions.length) {
          const nextAct = actions[end];
          if (!nextAct || !this.isActionConcurrencySafe(nextAct)) break;
          end++;
        }
        const waveLen = end - idx;
        const wavePromises: Array<Promise<{ text: string; error?: string }>> = new Array(waveLen);
        for (let w = 0; w < waveLen; w++) {
          const act = actions[idx + w];
          wavePromises[w] = act
            ? this.executeTool(act.name, act.arguments, step.step)
            : Promise.resolve({ text: '' });
        }
        const waveResults = await Promise.all(wavePromises);
        for (let w = 0; w < waveLen; w++) {
          const res = waveResults[w];
          observations[idx + w] = res?.text ?? '';
          if (res?.error !== undefined) errors.push(res.error);
        }
        idx = end;
      }
      this.submit(observations, errors.length > 0 ? { error: errors.join('; ') } : undefined);
    }
  }

  private isActionConcurrencySafe(action: ToolAction): boolean {
    const tool = this.toolMap.get(action.name);
    if (!tool?.isConcurrencySafe) return false;
    try {
      return tool.isConcurrencySafe(action.arguments);
    } catch {
      return false;
    }
  }

  private finalize(r: Omit<AgentRunResult, 'state' | 'usage' | 'formatIssues'>): AgentRunResult {
    if (this.finished && this.runResult !== undefined) return this.runResult;
    this.emit({ type: 'run_end', agent: this.name, depth: this.depth, steps: r.steps, terminated: r.terminated });
    this.finished = true;
    this.runResult = { ...r, state: this.state.snapshot(), usage: this.usage, formatIssues: this.formatIssues };
    return this.runResult;
  }

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

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    step: number,
  ): Promise<{ text: string; error?: string }> {
    const tool = this.toolMap.get(name);
    if (!tool) {
      const error = `Unknown tool "${name}"`;
      return {
        text: `Error: unknown tool "${name}". Available tools: ${[...this.toolMap.keys()].join(', ')}`,
        error,
      };
    }
    try {
      const toolPromise = tool.execute(args, {
        store: this.cfg.store,
        usage: this.usage,
        depth: this.depth,
        agentName: this.name,
        step,
        emit: (e) => this.emit(e),
        signal: this.cfg.signal,
        board: this.cfg.board,
        callStack: this.cfg.callStack,
        ancestorTasks: [...(this.cfg.ancestorTasks ?? []), this.cfg.followUpQuestion ?? this.currentTaskQuestion],
        ...(this.cfg.cwd !== undefined ? { cwd: this.cfg.cwd } : {}),
      });
      const observation = await raceAbort(toolPromise, this.cfg.signal);
      return { text: observation };
    } catch (e) {
      const error = (e as Error).message;
      return { text: `Error: ${error}`, error };
    }
  }
}

export function renderLatest(i: Interaction): string {
  const actions = i.actions && i.actions.length > 0 ? i.actions : [i.action];
  const label = actions.length > 1 ? '**Tool Calls:**\n' : '**Tool Call:** ';
  return [
    `**[Step ${i.step}]**`,
    `**Motivation:** ${i.motivation || '(none)'}`,
    `${label}${formatToolCallsXml(actions)}`,
    `**Observation:**\n${i.observation}`,
  ].join('\n');
}
