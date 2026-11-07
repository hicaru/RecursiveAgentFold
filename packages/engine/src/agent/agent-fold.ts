import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import { FoldState, fallbackSummary, type FoldDirective, type FoldStateSnapshot, type Interaction } from '../fold/state.js';
import { UsageTracker } from '../llm/usage.js';
import { buildAgentSystemPrompt, FORCE_ANSWER, FORMAT_REMINDER, FORMAT_REPAIR, renderBlockLabel } from '../prompts/agent.js';
import { parseAgentResponse, type ParsedResponse } from '../protocol/parser.js';
import { defaultEstimator, truncateToTokens, type TokenEstimator } from '../tokens.js';
import { renderToolSchemas, type Tool } from '../tools/types.js';
import type { ChatMessage, LLMClient } from '../types.js';
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
  }
  private emit(e: AgentEvent) {
    this.cfg.onEvent?.(e);
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
    const parts: string[] = [`### Documents\n${this.cfg.store.manifest()}`];
    if (this.initialBoardSnapshot) parts.push(`### Shared Research Board\n${this.initialBoardSnapshot}`);
    const isScopedSpecialist =
      this.name.startsWith('specialist#') || (this.depth > 0 && this.cfg.scope !== undefined);
    const scopeLabel = this.cfg.scope ?? this.name;
    const atMaxDepth = this.cfg.maxDepth !== undefined && this.depth >= this.cfg.maxDepth;
    const taskBlock = isScopedSpecialist
      ? atMaxDepth
        ? `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}] at max depth d=${this.depth}. Do NOT call branch on your own scope or unstudied scopes; use grep/read/tally on your scope document, or call branch ONLY to query an existing specialist [scope=...] already listed on the board.)`
        : `### Task\n${question.trim()}\n(Note: You are specialist sub-agent ${this.name} responsible ONLY for [scope=${scopeLabel}]. Use grep/read/tally directly on your scope document and NEVER call branch on your own scope; for cross-module dependencies, check the board first or call branch with the target [scope=...].)`
      : `### Task\n${question.trim()}`;
    parts.push(taskBlock, prev.join('\n'));
    const delta = this.cfg.board?.renderSince(this.initialBoardRev, this.cfg.scope);
    if (delta) parts.push(`### New Board Findings\n${delta}`);
    if (this.cfg.followUpQuestion) {
      parts.push(
        `### Follow-up Question\n${this.cfg.followUpQuestion.trim()}\n(Reuse exact key=value facts and formulas already recorded in Previous Steps above if sufficient; if the follow-up asks about a new identifier/index not yet recorded as an explicit key=value in your summaries, verify it with grep/read first.)`,
      );
    }
    parts.push(FORMAT_REMINDER(state.currentStep, latest?.step));
    if (extraUserTail) parts.push(extraUserTail);
    return [
      { role: 'system', content: this.systemPrompt, cacheBreakpoint: true },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }

  async run(question: string): Promise<AgentRunResult> {
    const state = this.cfg.initialState ? FoldState.restore(this.cfg.initialState) : new FoldState();
    const startStep = state.currentStep;
    const isSpecialist =
      this.depth > 0 ||
      this.cfg.initialState !== undefined ||
      this.cfg.followUpQuestion !== undefined ||
      (this.cfg.name !== undefined && this.cfg.name !== 'root');
    const maxSteps = this.cfg.maxSteps ?? 100;
    const role = this.cfg.usageRole ?? (this.depth === 0 ? 'root' : 'branch');
    let formatIssues = 0;
    this.emit({ type: 'run_start', agent: this.name, depth: this.depth, question });

    const finish = (r: Omit<AgentRunResult, 'state' | 'usage' | 'formatIssues'>): AgentRunResult => {
      this.emit({ type: 'run_end', agent: this.name, depth: this.depth, steps: r.steps, terminated: r.terminated });
      return { ...r, state: state.snapshot(), usage: this.usage, formatIssues };
    };

    for (let iter = 0; iter <= maxSteps; iter++) {
      const step = state.currentStep;
      const forcing = iter === maxSteps;
      if (forcing && !(this.cfg.forceAnswerOnLimit ?? true)) {
        return finish({ answer: null, steps: Math.max(0, step - startStep), terminated: 'max_steps' });
      }
      const expectFolding = state.latest !== undefined;
      let parsed: ParsedResponse | undefined;
      let outputTruncated = false;
      let tail: string | undefined = forcing ? FORCE_ANSWER : undefined;
      const maxRetries = this.cfg.maxFormatRetries ?? 2;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const messages = this.buildMessages(question, state, tail);
        if (attempt === 0) {
          this.emit({
            type: 'step_start',
            agent: this.name,
            depth: this.depth,
            step,
            contextTokens: this.estimator.count(messages.map((m) => m.content).join('')),
            blocks: state.blocks.length + (state.latest ? 1 : 0),
          });
        }
        let text: string;
        let reasoning: string | undefined;
        let truncatedReasoning = false;
        try {
          const res = await this.cfg.llm.complete({ messages, temperature: this.cfg.temperature, signal: this.cfg.signal, purpose: role });
          this.usage.record(role, res.usage, res.latencyMs);
          this.emit({
            type: 'llm_call',
            agent: this.name,
            role,
            model: res.model,
            usage: res.usage,
            latencyMs: res.latencyMs,
            ...(res.finishReason !== undefined ? { finishReason: res.finishReason } : {}),
            attempt,
          });
          text = res.text;
          reasoning = res.reasoning;
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
          this.usage.recordError(role);
          const message = (e as Error).message;
          this.emit({ type: 'error', agent: this.name, step, message });
          return finish({
            answer: null,
            steps: Math.max(0, step - startStep),
            terminated: PROVIDER_REFUSAL.test(message) ? 'filtered' : 'error',
            error: message,
          });
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
          const lastBlock = state.blocks[state.blocks.length - 1];
          const echo =
            [p.folding?.summary, lastBlock?.summary].some((summary) => isSummaryEcho(p.answer ?? '', summary)) ||
            isRawAnswerEcho(text, p.answer);
          if (echo) {
            p.errors.push('the <answer> repeats the folding summary; output a standalone final answer instead');
          }
        }
        if (p.errors.length === 0) {
          parsed = p;
          break;
        }
        formatIssues++;
        this.emit({ type: 'format_error', agent: this.name, step, errors: p.errors, attempt, raw: text.slice(0, 4000) });
        tail = [forcing ? FORCE_ANSWER : undefined, FORMAT_REPAIR(p.errors, step, state.latest?.step, truncatedReasoning)].filter(Boolean).join('\n\n');
        parsed = p;
      }
      if (!parsed || parsed.errors.length) {
        // Unrecoverable format failure: if there is any text-like answer, stop; else record a failed step.
        if (forcing) return finish({ answer: null, steps: Math.max(0, step - startStep), terminated: 'max_steps', error: parsed?.errors.join('; ') });
        if (state.latest) state.applyFold({ range: [state.latest.step, state.latest.step], summary: fallbackSummary(state.latest) });
        state.setLatest({
          step,
          motivation: '(invalid response)',
          action: { name: 'none', arguments: {} },
          observation: `Error: your response could not be parsed (${parsed?.errors.join('; ')}). Follow the required tag format.`,
        });
        continue;
      }

      // FOLD
      if (state.latest) {
        if (!parsed.folding) formatIssues++;
        const latestStep = state.latest.step;
        let requested: FoldDirective = parsed.folding ?? {
          range: [latestStep, latestStep],
          summary: fallbackSummary(state.latest),
        };
        let deferredDeep = false;
        const minDeep = this.cfg.minDeepFoldBlocks ?? DEFAULT_MIN_DEEP_FOLD_BLOCKS;
        if ((parsed.answer === undefined || isSpecialist) && requested.range[0] < latestStep && minDeep > 1) {
          const wouldRetract = state.blocks.filter((b) => b.to >= requested.range[0]).length;
          if (wouldRetract < minDeep) {
            requested = { range: [latestStep, latestStep], summary: requested.summary };
            deferredDeep = true;
          }
        }
        const outcome = state.applyFold(requested);
        if (deferredDeep) {
          outcome.corrections.push(`deep fold (< ${minDeep} blocks) deferred to granular [${latestStep}, ${latestStep}] to preserve cache`);
        }
        this.emit({ type: 'fold', agent: this.name, step, outcome, requested: parsed.folding });
      }

      // ANSWER
      if (parsed.answer !== undefined) {
        if (isSpecialist) {
          const answerStep = state.currentStep;
          const queryTag = this.cfg.followUpQuestion
            ? `follow-up "${this.cfg.followUpQuestion.replace(/\s+/g, ' ').slice(0, 60)}"`
            : 'initial task';
          const cleanAns = parsed.answer.replace(/\s+/g, ' ').trim().slice(0, 600);
          state.setLatest({
            step: answerStep,
            motivation: queryTag,
            action: { name: 'answer', arguments: {} },
            observation: cleanAns,
          });
          state.applyFold({
            range: [answerStep, answerStep],
            summary: `Completed ${queryTag}; result: ${cleanAns}`,
          });
        }
        this.emit({ type: 'answer', agent: this.name, step, answer: parsed.answer });
        return finish({ answer: parsed.answer, steps: step - startStep + 1, terminated: forcing ? 'forced_answer' : 'answer' });
      }
      // ACT
      const action = parsed.toolCall ?? { name: 'none', arguments: {} };
      const motivation = parsed.motivation ?? '';
      this.emit({ type: 'tool_call', agent: this.name, step, action, motivation });
      const observation = await this.executeTool(action.name, action.arguments, step);
      state.setLatest({ step, motivation, action, observation });
    }
    return finish({ answer: null, steps: Math.max(0, state.currentStep - startStep), terminated: 'max_steps' });
  }

  private async executeTool(name: string, args: Record<string, unknown>, step: number): Promise<string> {
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
        });
      } catch (e) {
        error = (e as Error).message;
        observation = `Error: ${error}`;
      }
    }
    const { text } = truncateToTokens(observation, this.cfg.maxObservationTokens ?? DEFAULT_MAX_OBSERVATION_TOKENS, this.estimator);
    this.emit({ type: 'tool_result', agent: this.name, step, name, observation: text, tokens: this.estimator.count(text), error });
    return text;
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
