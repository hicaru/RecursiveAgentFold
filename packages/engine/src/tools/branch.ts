import { normalizeScopeKey, normalizeTaskKey } from '../context/board.js';
import type { ContextStore } from '../context/store.js';
import type { FoldStateSnapshot } from '../fold/state.js';
import { truncateToTokens } from '../tokens.js';
import { argNumber, argString, ToolArgumentError, type Tool } from './types.js';

export interface BranchRunnerOptions {
  readonly depth: number;
  readonly maxSteps?: number;
  readonly parent: string;
  readonly scope?: string;
  readonly initialState?: FoldStateSnapshot;
  readonly followUpQuestion?: string;
  readonly initialBoardCount?: number;
  readonly initialBoardSnapshot?: string;
  readonly agentName?: string;
  readonly callStack?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface BranchRunnerResult {
  readonly answer: string | null;
  readonly steps: number;
  readonly terminated: string;
  readonly state?: FoldStateSnapshot;
  readonly error?: string;
}

export interface BranchRunner {
  (task: string, opts: BranchRunnerOptions): Promise<BranchRunnerResult>;
}

export interface BranchToolOptions {
  maxBranchSteps?: number;
  maxResultTokens?: number;
  consultOnly?: boolean;
}

interface SubTaskSpec {
  readonly scope?: string;
  readonly task: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferScope(explicitScope: string | undefined, taskText: string, store: ContextStore): string {
  if (explicitScope && explicitScope.trim() !== '') {
    return normalizeScopeKey(explicitScope);
  }
  const docs = store.list();
  if (docs.length > 1) {
    const matchedDocs = docs.filter((d) => {
      const pat = new RegExp(`(?:^|[^a-z0-9_-])${escapeRegExp(d.id)}(?:$|[^a-z0-9_-])`, 'i');
      return pat.test(taskText);
    });
    if (matchedDocs.length === 1 && matchedDocs[0]) {
      return normalizeScopeKey(matchedDocs[0].id);
    }
  }
  const modMatches = [...taskText.matchAll(/\b((?:lib|mod|dep|service|pkg|doc|app|spec)[_-][a-z0-9_-]+)\b/gi)];
  if (modMatches.length > 0) {
    const uniqueMods = new Set(modMatches.map((m) => normalizeScopeKey(m[1] ?? '')));
    uniqueMods.delete('');
    if (uniqueMods.size === 1) {
      const first = [...uniqueMods][0];
      if (first) return first;
    }
  }
  return normalizeTaskKey(taskText);
}

function parseSubTasks(raw: unknown, fallbackScope: string | undefined): SubTaskSpec[] {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) {
    const out: SubTaskSpec[] = new Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (typeof item === 'string') {
        const t = item.trim();
        if (!t) throw new ToolArgumentError('tasks 数组不能包含空字符串');
        out[i] = fallbackScope ? { scope: fallbackScope, task: t } : { task: t };
      } else if (typeof item === 'object' && item !== null) {
        const rec = item as Record<string, unknown>;
        const rawTask =
          typeof rec.task === 'string'
            ? rec.task
            : typeof rec.question === 'string'
              ? rec.question
              : typeof rec.query === 'string'
                ? rec.query
                : '';
        const t = rawTask.trim();
        if (!t) throw new ToolArgumentError('tasks 数组中的对象必须包含非空字符串 "task"');
        const s = typeof rec.scope === 'string' && rec.scope.trim() !== '' ? rec.scope.trim() : fallbackScope;
        out[i] = s ? { scope: s, task: t } : { task: t };
      } else {
        throw new ToolArgumentError('tasks 数组元素必须是字符串或 {scope, task} 对象');
      }
    }
    return out;
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((t) => (fallbackScope ? { scope: fallbackScope, task: t } : { task: t }));
  }
  throw new ToolArgumentError('参数 "tasks" 必须是任务列表');
}

/**
 * `branch` spawns or queries a scoped specialist child AgentFold agent (depth + 1)
 * over the same document store. Each `scope` preserves its folded state in
 * ResearchBoard so follow-up questions reuse the specialist's KV prefix cache
 * and folded memory without re-scanning raw documents.
 */
export function createBranchTool(run: BranchRunner, opts: BranchToolOptions = {}): Tool {
  return {
    name: 'branch',
    description:
      '把模块/文档研究任务交给带持久折叠记忆的专家子代理，或向已有专家子代理 [scope=...] 追问细节。传入 "scope"（如文档 id 或依赖模块名）以复用该专家上下文并自动去重；支持单个 "task" 或并行 "tasks"。',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: '专家子代理负责的域标识（如文档 id、模块/依赖库名，如 "doc_a" 或 "lib_auth"）。相同 scope 自动复用该专家上下文与缓存并去重。',
        },
        task: { type: 'string', description: '向该专家子代理布置的研究指令或追问问题。' },
        tasks: {
          type: 'array',
          items: {
            type: ['string', 'object'],
            properties: {
              scope: { type: 'string', description: '子任务对应的文档 id 或模块/依赖名。' },
              task: { type: 'string', description: '独立子任务指令或追问。' },
            },
          },
          description: '可选：并行派发多个独立子任务（支持字符串或 {scope, task} 对象；相同 scope 自动合并去重）。',
        },
        max_steps: { type: 'integer', description: `步数预算（默认 ${opts.maxBranchSteps ?? 20}）。` },
      },
      required: [],
    },
    async execute(args, ctx) {
      const explicitScope = argString(args, 'scope', false);
      const task =
        argString(args, 'task', false) ??
        argString(args, 'question', false) ??
        argString(args, 'query', false);
      const tasks = parseSubTasks(args.tasks, explicitScope);
      if (!task && tasks.length === 0) {
        throw new ToolArgumentError('必须提供 "task" 或 "tasks"');
      }
      const maxSteps = Math.min(argNumber(args, 'max_steps') ?? opts.maxBranchSteps ?? 20, opts.maxBranchSteps ?? 20);

      const runSingle = async (subTask: string, subScope?: string): Promise<string> => {
        const scopeKey = inferScope(subScope, subTask, ctx.store);
        const stack = ctx.callStack ?? [];
        if (stack.includes(scopeKey)) {
          const existingSummary = ctx.board?.getSpecialist(scopeKey)?.latestSummary;
          return existingSummary
            ? `[scope=${scopeKey}]（检测到循环调用，返回该专家最新已知结论）\n${existingSummary}`
            : `[scope=${scopeKey}]（检测到循环调用同一专家 scope，请直接利用已有看板信息或文档工具完成当前子任务）`;
        }
        if (opts.consultOnly) {
          if (!ctx.board || !ctx.board.hasSpecialist(scopeKey)) {
            return `[scope=${scopeKey}] 该深度仅允许向看板上已有的专家子代理 [scope=...] 追问，请指定已存在的 scope 或直接使用 grep/read。`;
          }
        }
        const nextStack = [...stack, scopeKey];
        if (ctx.board) {
          const { result } = await ctx.board.runScopedBranch(scopeKey, subTask, async (sInput) => {
            const r = await run(sInput.initialTask, {
              depth: ctx.depth + 1,
              maxSteps,
              parent: ctx.agentName,
              scope: scopeKey,
              initialState: sInput.previousState,
              followUpQuestion: sInput.followUpQuestion,
              initialBoardCount: sInput.initialBoardCount,
              initialBoardSnapshot: sInput.initialBoardSnapshot,
              agentName: sInput.agentName,
              callStack: nextStack,
              signal: ctx.signal,
            });
            const status = `[scope=${scopeKey}] branch 完成：${r.terminated}，共 ${r.steps} 步${r.error ? `（错误：${r.error}）` : ''}`;
            const body = r.answer ?? '（未产生答案）';
            const resultText = `${status}\n结果：\n${body}`;
            return {
              resultText,
              answer: r.answer,
              state: r.state ?? { blocks: [], latest: undefined },
            };
          });
          return result;
        }
        const r = await run(subTask, {
          depth: ctx.depth + 1,
          maxSteps,
          parent: ctx.agentName,
          scope: scopeKey,
          callStack: nextStack,
          signal: ctx.signal,
        });
        const status = `[scope=${scopeKey}] branch 完成：${r.terminated}，共 ${r.steps} 步${r.error ? `（错误：${r.error}）` : ''}`;
        const body = r.answer ?? '（未产生答案）';
        return `${status}\n结果：\n${body}`;
      };

      if (tasks.length > 0) {
        const results = await Promise.all(tasks.map((t) => runSingle(t.task, t.scope)));
        const summary = results
          .map((r, i) => {
            const spec = tasks[i];
            const label = spec?.scope ? `[scope=${spec.scope}] ${spec.task}` : (spec?.task ?? '');
            return `[子任务 #${i + 1}] ${label}\n${r}`;
          })
          .join('\n\n');
        return truncateToTokens(summary, opts.maxResultTokens ?? 6000).text;
      }

      return truncateToTokens(await runSingle(task ?? '', explicitScope), opts.maxResultTokens ?? 3000).text;
    },
  };
}
