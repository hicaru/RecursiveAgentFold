import type { FoldDirective, FoldOutcome, ToolAction } from '../fold/state.js';
import type { LLMUsage } from '../types.js';

export type AgentEvent =
  | {
      type: 'run_start';
      agent: string;
      depth: number;
      question: string;
      parent?: string;
      scope?: string;
      isFollowUp?: boolean;
    }
  | { type: 'step_start'; agent: string; depth: number; step: number; contextTokens: number; blocks: number }
  | {
      type: 'llm_call';
      agent: string;
      step?: number;
      role: string;
      model: string;
      usage: LLMUsage;
      latencyMs: number;
      finishReason?: string;
      attempt?: number;
    }
  | { type: 'llm_response'; agent: string; step: number; text: string; reasoning?: string }
  | { type: 'format_error'; agent: string; step: number; errors: string[]; attempt: number; raw: string }
  | { type: 'fold'; agent: string; step: number; outcome: FoldOutcome; requested?: FoldDirective }
  | { type: 'tool_call'; agent: string; step: number; action: ToolAction; motivation: string }
  | { type: 'tool_result'; agent: string; step: number; name: string; observation: string; tokens: number; error?: string }
  | { type: 'answer'; agent: string; step: number; answer: string }
  | { type: 'run_end'; agent: string; depth: number; steps: number; terminated: string }
  | {
      type: 'branch_report';
      agent: string;
      step: number;
      scope: string;
      reportId: string;
      tokens: number;
      lines: number;
    }
  | {
      type: 'llm_query';
      agent: string;
      step?: number;
      query: string;
      mode: string;
      chunks: number;
      relevant: number;
      errors: number;
      memoHits: number;
      chunkTokens: number;
      calls?: number;
      usage?: LLMUsage;
    }
  | {
      type: 'context_budget';
      agent: string;
      step: number;
      beforeTokens: number;
      afterTokens: number;
      actions: string[];
    }
  | { type: 'error'; agent: string; step?: number; message: string };

export type EventSink = (e: AgentEvent) => void;
