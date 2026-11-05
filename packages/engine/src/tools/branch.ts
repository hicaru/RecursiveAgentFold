import { truncateToTokens } from '../tokens.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

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
      '把自包含子任务交给拥有全新上下文和相同文档工具（含 llm_query）的子代理，只返回其最终结果。必须交代目标、相关文档 id/行区间和期望的输出格式。支持单个任务 "task" 或多个并行独立原子子任务 "tasks"。',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '单个自包含子代理指令。' },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：并行执行的多个独立原子子任务列表（每个子任务拥有独立上下文，互不干扰）。',
        },
        max_steps: { type: 'integer', description: `步数预算（默认 ${opts.maxBranchSteps ?? 20}）。` },
      },
      required: [],
    },
    async execute(args, ctx) {
      const task = argString(args, 'task', false);
      const tasks = argStringList(args, 'tasks');
      if (!task && (!tasks || tasks.length === 0)) {
        throw new ToolArgumentError('必须提供 "task" 或 "tasks"');
      }
      const maxSteps = Math.min(argNumber(args, 'max_steps') ?? opts.maxBranchSteps ?? 20, opts.maxBranchSteps ?? 20);

      const runSingle = async (subTask: string): Promise<string> => {
        const executeBranch = async () => {
          const r = await run(subTask, { depth: ctx.depth + 1, maxSteps, parent: ctx.agentName, signal: ctx.signal });
          const status = `branch 完成：${r.terminated}，共 ${r.steps} 步${r.error ? `（错误：${r.error}）` : ''}`;
          const body = r.answer ?? '（未产生答案）';
          return `${status}\n结果：\n${body}`;
        };
        const resultText = ctx.board
          ? (await ctx.board.runAtomicBranch(subTask, executeBranch)).result
          : await executeBranch();
        return resultText;
      };

      if (tasks && tasks.length > 0) {
        const results = await Promise.all(tasks.map((t) => runSingle(t)));
        const summary = results.map((r, i) => `[子任务 #${i + 1}] ${tasks[i]}\n${r}`).join('\n\n');
        return truncateToTokens(summary, opts.maxResultTokens ?? 6000).text;
      }

      return truncateToTokens(await runSingle(task!), opts.maxResultTokens ?? 3000).text;
    },
  };
}
