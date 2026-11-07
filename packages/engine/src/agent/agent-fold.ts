import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import { FoldState, fallbackSummary, type FoldDirective, type FoldStateSnapshot, type Interaction, type ToolAction } from '../fold/state.js';
import { UsageTracker } from '../llm/usage.js';
import { buildAgentSystemPrompt, FORCE_ANSWER, FORMAT_REMINDER, FORMAT_REPAIR, renderBlockLabel } from '../prompts/agent.js';
import { parseAgentResponse, type ParsedResponse } from '../protocol/parser.js';
import { defaultEstimator, truncateToTokens, type TokenEstimator } from '../tokens.js';
import { renderToolSchemas, type Tool } from '../tools/types.js';
import type { ChatMessage, LLMClient, LLMUsage } from '../types.js';
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
}

export type Termination = 'answer' | 'forced_answer' | 'max_steps' | 'error' | 'filtered';

/** Provider safety refusal (Z.ai 1301): no retry loop can repair the payload. */
const PROVIDER_REFUSAL = /\/1301\]|unsafe or sensitive/i;
/** Protocol tags belong outside the answer text. */
const PROTOCOL_TAG = /<\s*\/?\s*(?:think|folding|folded_output|fold|折叠|motivation|explanation|动机|tool_call|answer)\b[^>]*>/i;
export const DEFAULT_MAX_OBSERVATION_TOKENS = 3200;
export const DEFAULT_MIN_DEEP_FOLD_BLOCKS = 6;
export const DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS = 16;

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

/** Detect a long answer copied from the raw folding block. */
function isRawAnswerEcho(raw: string, answer: string): boolean {
  const a = echoText(answer);
  if (a.length < 160) return false;
  const match = /<\s*folding\b[^>]*>([\s\S]*?)<\s*\/\s*folding\s*>/i.exec(raw);
  return match !== null && echoText(match[1] ?? '').includes(a);
}

const PLACEHOLDER_ANSWER =
  /^(?:暂无(?:最终)?答案|还在验证|继续验证|尚无答案|未完待续|no final answer(?: yet)?|still verifying|continuing verification|verification in progress)(?:\b|[，。,.!！])/i;

function isPlaceholderAnswer(answer: string): boolean {
  const clean = echoText(answer);
  if (clean === '') return true;
  if (clean.length > 120) return false;
  return PLACEHOLDER_ANSWER.test(clean) || /(?:暂无最终答案|继续验证中|尚未确定最终答案|need more steps to verify)/i.test(clean);
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
  const marker = /(?:^|\n)\s*(\[(?:Answer|答案)\]\s*[\s\S]+|(?:Final\s+)?Answer\s*:\s*[^\n]+)$/i.exec(rawText);
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
      usage: LLMUsage;
    }
  | {
      kind: 'answer';
      step: number;
      answer: string;
      reasoning?: string;
      text: string;
      usage: LLMUsage;
      result: AgentRunResult;
    }
  | { kind: 'done'; result: AgentRunResult };

/** A read action, with or without a host tool-name prefix. */
function isReadAction(name: string): boolean {
  return /(?:^|_)read$/.test(name);
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
  private readonly initialDocIds: ReadonlySet<string>;
  private currentTaskQuestion = '';
  private state: FoldState = new FoldState();
  private startStep = 0;
  private runQuestion = '';
  private formatIssues = 0;
  private verificationNudged = false;
  private pending: { step: number; motivation: string; action: ToolAction } | undefined;
  private stepUsage: LLMUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  private started = false;
  private finished = false;
  private runResult: AgentRunResult | undefined;
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
    this.initialManifest = cfg.store.manifest();
    this.initialDocIds = new Set(cfg.store.list().map((d) => d.id));
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

  private addStepUsage(usage: LLMUsage): void {
    this.stepUsage = {
      promptTokens: this.stepUsage.promptTokens + usage.promptTokens,
      completionTokens: this.stepUsage.completionTokens + usage.completionTokens,
      cachedTokens: this.stepUsage.cachedTokens + usage.cachedTokens,
      ...(this.stepUsage.reasoningTokens !== undefined || usage.reasoningTokens !== undefined
        ? { reasoningTokens: (this.stepUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0) }
        : {}),
    };
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
    const allDocs = this.cfg.store.list();
    if (allDocs.length > this.initialDocIds.size) {
      const newDocIds: string[] = [];
      for (let i = 0; i < allDocs.length; i++) {
        const doc = allDocs[i];
        if (doc && !this.initialDocIds.has(doc.id)) {
          newDocIds.push(doc.id);
        }
      }
      if (newDocIds.length > 0) {
        parts.push(`### Newly Added Documents\n${this.cfg.store.manifestFor(newDocIds)}`);
      }
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
    this.finished = false;
    this.started = true;
    this.runResult = undefined;
    this.emit({
      type: 'run_start',
      agent: this.name,
      depth: this.depth,
      question,
      ...(this.cfg.parent !== undefined ? { parent: this.cfg.parent } : {}),
      ...(this.cfg.scope !== undefined ? { scope: this.cfg.scope } : {}),
      isFollowUp: this.cfg.followUpQuestion !== undefined,
    });
  }

  /**
   * Produce one step. A tool step stops before execution; the caller executes
   * the action and calls `submit()`, so a host can run the tool natively.
   */
  async next(keepStepUsage = false): Promise<AgentStep> {
    if (!this.started) throw new Error('AgentFoldAgent.next() called before begin()');
    if (this.finished && this.runResult !== undefined) return { kind: 'done', result: this.runResult };
    const step = this.state.currentStep;
    const forcing = step - this.startStep >= this.maxSteps;
    if (forcing && !(this.cfg.forceAnswerOnLimit ?? true)) {
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
    if (!keepStepUsage) this.stepUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const messages = this.buildMessages(this.runQuestion, this.state, tail);
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
      try {
        const res = await this.cfg.llm.complete({ messages, temperature: this.cfg.temperature, signal: this.cfg.signal, purpose: this.role });
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
        truncatedReasoning =
          text.trim() === '' &&
          (res.finishReason === 'length' || (res.usage.reasoningTokens ?? 0) >= 8000);
        if (text.trim() === '' && reasoning && /<\s*(?:answer|tool_call)\b/i.test(reasoning)) {
          const tagMatch = /<\s*(?:folding|folded_output|fold|motivation|tool_call|answer)\b/i.exec(reasoning);
          if (tagMatch) {
            text = reasoning.slice(tagMatch.index);
          }
        }
        this.emit({ type: 'llm_response', agent: this.name, step, text: text.slice(0, 16_000), reasoning: reasoning?.slice(0, 16_000) });
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
          this.cfg.store.totalTokens() >= 1000 &&
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
      tail = [forcing ? FORCE_ANSWER : undefined, FORMAT_REPAIR(p.errors, step, this.state.latest?.step, truncatedReasoning)].filter(Boolean).join('\n\n');
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
      if ((parsed.answer === undefined || this.isSpecialist) && requested.range[0] < latestStep && minDeep > 1) {
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
      if (this.isSpecialist) {
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
        result,
      };
    }

    // ACT
    const action = this.resolveToolAction(parsed.toolCall ?? { name: 'none', arguments: {} });
    const motivation = parsed.motivation ?? '';
    this.pending = { step, motivation, action };
    this.emit({ type: 'tool_call', agent: this.name, step, action, motivation });
    return {
      kind: 'tool',
      step,
      action,
      motivation,
      ...(stepReasoning !== undefined ? { reasoning: stepReasoning } : {}),
      text: lastRawText,
      usage: this.stepUsage,
    };
  }

  /** Feed the observation of the pending tool step back into the fold state. */
  submit(observation: string, meta?: { error?: string }): void {
    const pending = this.pending;
    if (pending === undefined) throw new Error('submit() without a pending tool call');
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
    for (;;) {
      const step = await this.next();
      if (step.kind !== 'tool') return step.result;
      const { text, error } = await this.executeTool(step.action.name, step.action.arguments, step.step);
      this.submit(text, error === undefined ? undefined : { error });
    }
  }

  private finalize(r: Omit<AgentRunResult, 'state' | 'usage' | 'formatIssues'>): AgentRunResult {
    if (this.finished && this.runResult !== undefined) return this.runResult;
    this.emit({ type: 'run_end', agent: this.name, depth: this.depth, steps: r.steps, terminated: r.terminated });
    this.finished = true;
    this.runResult = { ...r, state: this.state.snapshot(), usage: this.usage, formatIssues: this.formatIssues };
    return this.runResult;
  }

  /** Route an unprefixed model tool call to its prefixed twin when only that tool exists. */
  private resolveToolAction(action: ToolAction): ToolAction {
    if (!this.toolMap.has(action.name) && this.toolMap.has(`raf_${action.name}`)) {
      return { ...action, name: `raf_${action.name}` };
    }
    if (
      (action.name === 'read' || action.name === 'grep') &&
      this.toolMap.has(`raf_${action.name}`) &&
      'document' in action.arguments &&
      !('file_path' in action.arguments) &&
      !('path' in action.arguments)
    ) {
      return { ...action, name: `raf_${action.name}` };
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
      try {
        observation = await tool.execute(args, {
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
        });
      } catch (e) {
        error = (e as Error).message;
        observation = `Error: ${error}`;
      }
    }
    return { text: observation, ...(error !== undefined ? { error } : {}) };
  }
}


export function renderLatest(i: Interaction): string {
  return [
    `**[Step ${i.step}]**`,
    `**Motivation:** ${i.motivation || '(none)'}`,
    `**Tool Call:** ${JSON.stringify({ name: i.action.name, arguments: i.action.arguments })}`,
    `**Observation:**\n${i.observation}`,
  ].join('\n');
}
