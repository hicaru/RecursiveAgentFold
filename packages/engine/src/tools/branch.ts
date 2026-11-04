import { truncateToTokens } from '../tokens.js';
import { argNumber, argString, type Tool } from './types.js';

export interface BranchRunner {
  (task: string, opts: { depth: number; maxSteps?: number; parent: string; signal?: AbortSignal }): Promise<{
    answer: string | null;
    steps: number;
    terminated: string;
    error?: string;
  }>;
}

export interface BranchToolOptions {
  maxBranchSteps?: number;
  maxResultTokens?: number;
}

/**
 * `branch` spawns a child AgentFold agent (depth + 1) with a fresh folded
 * context over the same document store. Only the child's final answer flows
 * back, so the parent's cached prefix is untouched and the child's
 * exploration never pollutes the parent context.
 */
export function createBranchTool(run: BranchRunner, opts: BranchToolOptions = {}): Tool {
  return {
    name: 'branch',
    description:
      'Delegate a self-contained sub-task to a sub-agent with its own fresh context and the same document tools (incl. llm_query). Returns only its final result. Give it everything it needs: goal, relevant document ids/line ranges, and the exact output format you want back.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete, self-contained instruction for the sub-agent.' },
        max_steps: { type: 'integer', description: `Step budget (default ${opts.maxBranchSteps ?? 20}).` },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      const task = argString(args, 'task')!;
      const maxSteps = Math.min(argNumber(args, 'max_steps') ?? opts.maxBranchSteps ?? 20, opts.maxBranchSteps ?? 20);
      const r = await run(task, { depth: ctx.depth + 1, maxSteps, parent: ctx.agentName, signal: ctx.signal });
      const status = `branch finished: ${r.terminated} after ${r.steps} step(s)${r.error ? ` (error: ${r.error})` : ''}`;
      const body = r.answer ?? '(no answer produced)';
      return truncateToTokens(`${status}\nResult:\n${body}`, opts.maxResultTokens ?? 3000).text;
    },
  };
}
