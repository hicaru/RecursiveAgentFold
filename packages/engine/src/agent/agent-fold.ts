import type { ContextStore } from '../context/store.js';
import { FoldState, fallbackSummary, type FoldStateSnapshot, type Interaction } from '../fold/state.js';
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
}

export type Termination = 'answer' | 'forced_answer' | 'max_steps' | 'error' | 'filtered';

/** Provider safety refusal (Z.ai 1301): no retry loop can repair the payload. */
const PROVIDER_REFUSAL = /\/1301\]|unsafe or sensitive/i;

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

  constructor(private readonly cfg: AgentFoldConfig) {
    this.depth = cfg.depth ?? 0;
    this.name = cfg.name ?? (this.depth === 0 ? 'root' : `branch@${this.depth}`);
    this.usage = cfg.usage ?? new UsageTracker();
    this.estimator = cfg.estimator ?? defaultEstimator;
    this.toolMap = new Map(cfg.tools.map((t) => [t.name, t]));
    this.systemPrompt =
      `${buildAgentSystemPrompt(cfg.tools.map((t) => t.name))}\n\n# 可用工具\n${renderToolSchemas(cfg.tools)}` +
      (cfg.systemPromptExtra ? `\n\n# 附加说明\n${cfg.systemPromptExtra}` : '');
  }

  private emit(e: AgentEvent) {
    this.cfg.onEvent?.(e);
  }

  /** Build C_t = (Q, T, S, I). Exposed for tests and cache analysis. */
  buildMessages(question: string, state: FoldState, extraUserTail?: string): ChatMessage[] {
    const parts: string[] = [];
    parts.push(`### 任务\n${question.trim()}`);
    parts.push(`### 文档\n${this.cfg.store.manifest()}`);
    const blocks = state.blocks;
    const latest = state.latest;
    if (blocks.length || latest) {
      const prev: string[] = ['### 历史步骤'];
      for (const b of blocks) prev.push(`**${renderBlockLabel(b)}** ${b.summary}`);
      if (latest) prev.push(renderLatest(latest));
      parts.push(prev.join('\n'));
    }
    parts.push(FORMAT_REMINDER(state.currentStep, latest?.step));
    if (extraUserTail) parts.push(extraUserTail);
    return [
      { role: 'system', content: this.systemPrompt, cacheBreakpoint: true },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }

  async run(question: string): Promise<AgentRunResult> {
    const state = new FoldState();
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
        return finish({ answer: null, steps: step, terminated: 'max_steps' });
      }
      const expectFolding = state.latest !== undefined;
      let parsed: ParsedResponse | undefined;
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
        try {
          const res = await this.cfg.llm.complete({ messages, temperature: this.cfg.temperature, signal: this.cfg.signal, purpose: role });
          this.usage.record(role, res.usage, res.latencyMs);
          this.emit({ type: 'llm_call', agent: this.name, role, model: res.model, usage: res.usage, latencyMs: res.latencyMs, attempt });
          text = res.text;
          reasoning = res.reasoning;
          this.emit({ type: 'llm_response', agent: this.name, step, text: text.slice(0, 16_000), reasoning: reasoning?.slice(0, 16_000) });
        } catch (e) {
          this.usage.recordError(role);
          const message = (e as Error).message;
          this.emit({ type: 'error', agent: this.name, step, message });
          return finish({
            answer: null,
            steps: step,
            terminated: PROVIDER_REFUSAL.test(message) ? 'filtered' : 'error',
            error: message,
          });
        }
        const p = parseAgentResponse(text, { expectFolding, reasoning });
        if (forcing && !p.answer && p.errors.length === 0 && p.toolCall) p.errors.push('a final <answer> is required now');
        if (p.errors.length === 0) {
          parsed = p;
          break;
        }
        formatIssues++;
        this.emit({ type: 'format_error', agent: this.name, step, errors: p.errors, attempt, raw: text.slice(0, 4000) });
        tail = [forcing ? FORCE_ANSWER : undefined, FORMAT_REPAIR(p.errors, step, state.latest?.step)].filter(Boolean).join('\n\n');
        parsed = p;
      }
      if (!parsed || parsed.errors.length) {
        // Unrecoverable format failure: if there is any text-like answer, stop; else record a failed step.
        if (forcing) return finish({ answer: null, steps: step, terminated: 'max_steps', error: parsed?.errors.join('; ') });
        if (state.latest) state.applyFold({ range: [state.latest.step, state.latest.step], summary: fallbackSummary(state.latest) });
        state.setLatest({
          step,
          motivation: '（无效回复）',
          action: { name: 'none', arguments: {} },
          observation: `错误：你的回复无法解析（${parsed?.errors.join('；')}）。请严格遵循回复格式。`,
        });
        continue;
      }

      // FOLD
      if (state.latest) {
        if (!parsed.folding) formatIssues++;
        const requested = parsed.folding ?? { range: [state.latest.step, state.latest.step] as [number, number], summary: fallbackSummary(state.latest) };
        const outcome = state.applyFold(requested);
        this.emit({ type: 'fold', agent: this.name, step, outcome, requested: parsed.folding });
      }

      // ANSWER
      if (parsed.answer !== undefined) {
        this.emit({ type: 'answer', agent: this.name, step, answer: parsed.answer });
        return finish({ answer: parsed.answer, steps: step + 1, terminated: forcing ? 'forced_answer' : 'answer' });
      }

      // ACT
      const action = parsed.toolCall!;
      const motivation = parsed.motivation ?? '';
      this.emit({ type: 'tool_call', agent: this.name, step, action, motivation });
      const observation = await this.executeTool(action.name, action.arguments, step);
      state.setLatest({ step, motivation, action, observation });
    }
    return finish({ answer: null, steps: state.currentStep, terminated: 'max_steps' });
  }

  private async executeTool(name: string, args: Record<string, unknown>, step: number): Promise<string> {
    const tool = this.toolMap.get(name);
    let observation: string;
    let error: string | undefined;
    if (!tool) {
      error = `未知工具 "${name}"`;
      observation = `错误：未知工具 "${name}"。可用工具：${[...this.toolMap.keys()].join('、')}`;
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
        });
      } catch (e) {
        error = (e as Error).message;
        observation = `错误：${error}`;
      }
    }
    const { text } = truncateToTokens(observation, this.cfg.maxObservationTokens ?? 8000, this.estimator);
    this.emit({ type: 'tool_result', agent: this.name, step, name, observation: text, tokens: this.estimator.count(text), error });
    return text;
  }
}

export function renderLatest(i: Interaction): string {
  return [
    `**[步骤 ${i.step}]**`,
    `**动机：** ${i.motivation || '（无）'}`,
    `**工具调用：** ${JSON.stringify({ name: i.action.name, arguments: i.action.arguments })}`,
    `**工具结果：**\n${i.observation}`,
  ].join('\n');
}
