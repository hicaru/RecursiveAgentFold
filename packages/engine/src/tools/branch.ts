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
      '把自包含子任务交给拥有全新上下文和相同文档工具（含 llm_query）的子代理，只返回其最终结果。必须交代目标、相关文档 id/行区间和期望的输出格式。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '完整、自包含的子代理指令。' },
        max_steps: { type: 'integer', description: `步数预算（默认 ${opts.maxBranchSteps ?? 20}）。` },
      },
      required: ['task'],
    },
    async execute(args, ctx) {
      const task = argString(args, 'task')!;
      const maxSteps = Math.min(argNumber(args, 'max_steps') ?? opts.maxBranchSteps ?? 20, opts.maxBranchSteps ?? 20);
      const r = await run(task, { depth: ctx.depth + 1, maxSteps, parent: ctx.agentName, signal: ctx.signal });
      const status = `branch 完成：${r.terminated}，共 ${r.steps} 步${r.error ? `（错误：${r.error}）` : ''}`;
      const body = r.answer ?? '（未产生答案）';
      return truncateToTokens(`${status}\n结果：\n${body}`, opts.maxResultTokens ?? 3000).text;
    },
  };
}
