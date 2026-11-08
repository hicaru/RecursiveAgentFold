import { isAncestorEcho, normalizeScopeKey, normalizeTaskKey } from '../context/board.js';
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
  readonly ancestorTasks?: readonly string[];
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
  readonly ownScope?: string;
  readonly maxSpecialists?: number;
}

export interface SubTaskSpec {
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
      const pat = new RegExp(`(?:^|[^a-z0-9_./-])${escapeRegExp(d.id)}(?:$|[^a-z0-9_./-])`, 'i');
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
        if (!t) throw new ToolArgumentError('tasks array cannot contain empty strings');
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
        if (!t) throw new ToolArgumentError('task objects in tasks array must contain a non-empty "task" string');
        const s = typeof rec.scope === 'string' && rec.scope.trim() !== '' ? rec.scope.trim() : fallbackScope;
        out[i] = s ? { scope: s, task: t } : { task: t };
      } else {
        throw new ToolArgumentError('elements of tasks array must be strings or {scope, task} objects');
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
  throw new ToolArgumentError('argument "tasks" must be a task list');
}

export function mergeSubTasksByScope(specs: readonly SubTaskSpec[], store: ContextStore): SubTaskSpec[] {
  if (specs.length <= 1) return [...specs];
  const groups = new Map<string, { firstScope: string | undefined; tasks: string[]; seenTasks: Set<string> }>();
  for (const spec of specs) {
    const scopeKey = inferScope(spec.scope, spec.task, store);
    const normT = normalizeTaskKey(spec.task);
    let g = groups.get(scopeKey);
    if (!g) {
      g = { firstScope: spec.scope, tasks: [], seenTasks: new Set<string>() };
      groups.set(scopeKey, g);
    } else if (!g.firstScope && spec.scope) {
      g.firstScope = spec.scope;
    }
    if (!g.seenTasks.has(normT)) {
      g.seenTasks.add(normT);
      g.tasks.push(spec.task);
    }
  }
  const merged: SubTaskSpec[] = new Array(groups.size);
  let idx = 0;
  for (const [scopeKey, g] of groups) {
    const combinedTask =
      g.tasks.length === 1 ? (g.tasks[0] ?? '') : g.tasks.map((t, i) => `(${i + 1}) ${t}`).join('; ');
    const finalScope = g.firstScope ?? (g.tasks.length > 1 ? scopeKey : undefined);
    merged[idx++] = finalScope ? { scope: finalScope, task: combinedTask } : { task: combinedTask };
  }
  return merged;
}

interface BranchSubtaskResult {
  readonly text: string;
  readonly failed: boolean;
  readonly scope: string;
  readonly error?: string;
}

/** A branch subtask is usable only when the child finished with a real answer and no error. */
function isCompleteBranchRun(result: BranchRunnerResult): boolean {
  if (typeof result.error === 'string' && result.error !== '') return false;
  if (result.terminated !== 'answer' && result.terminated !== 'forced_answer') return false;
  return typeof result.answer === 'string' && result.answer.trim() !== '';
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
      'Delegate deep document/module research to a persistent scoped specialist sub-agent, or ask a follow-up question to an existing specialist [scope=...]. Pass "scope" (e.g. doc id or module name) to reuse specialist state/cache and deduplicate; supports single "task" or parallel "tasks". Use a loaded document id or a directory/module prefix present in the manifest; load a filesystem path with add_document first if it is absent, otherwise the specialist has no document to inspect.',
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          description: 'Scope identifier for the specialist sub-agent (e.g. document id or module/library name such as "doc_a" or "lib_auth"). Reuses specialist state and cache.',
        },
        task: { type: 'string', description: 'Research instruction or follow-up question for the specialist.' },
        tasks: {
          type: 'array',
          items: {
            type: ['string', 'object'],
            properties: {
              scope: { type: 'string', description: 'Document id or module/library scope for this subtask.' },
              task: { type: 'string', description: 'Subtask instruction or follow-up question.' },
            },
          },
          description: 'Optional: dispatch multiple independent subtasks in parallel (strings or {scope, task} objects; same scope is merged and deduplicated).',
        },
        max_steps: { type: 'integer', description: `Step budget (default ${opts.maxBranchSteps ?? 20}).` },
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
        throw new ToolArgumentError('must provide "task" or "tasks"');
      }
      const maxSteps = Math.min(argNumber(args, 'max_steps') ?? opts.maxBranchSteps ?? 20, opts.maxBranchSteps ?? 20);

      const runSingle = async (subTask: string, subScope?: string): Promise<BranchSubtaskResult> => {
        const scopeKey = inferScope(subScope, subTask, ctx.store);
        const sameOrUnspecifiedScope =
          !subScope || !opts.ownScope || normalizeScopeKey(subScope) === normalizeScopeKey(opts.ownScope);
        if (ctx.depth > 0 && sameOrUnspecifiedScope && ctx.ancestorTasks && isAncestorEcho(subTask, ctx.ancestorTasks)) {
          return {
            text: `[scope=${scopeKey}] [ledger: ancestor echo rejected — do NOT call branch on your own scope or re-delegate your assigned task. Use search / grep / read / tally directly on your scope document.]`,
            failed: false,
            scope: scopeKey,
          };
        }
        if (opts.ownScope && scopeKey === normalizeScopeKey(opts.ownScope)) {
          return {
            text: `[scope=${scopeKey}] You are already the specialist responsible for [${scopeKey}]; do NOT call branch on your own scope! Use grep / read / tally directly on your document.`,
            failed: false,
            scope: scopeKey,
          };
        }
        const stack = ctx.callStack ?? [];
        if (stack.includes(scopeKey)) {
          const existingSummary = ctx.board?.getSpecialist(scopeKey)?.latestSummary;
          return {
            text: existingSummary
              ? `[scope=${scopeKey}] (cycle detected on scope; returning latest known specialist summary)\n${existingSummary}`
              : `[scope=${scopeKey}] (cycle detected on scope; use existing board findings or document tools directly)`,
            failed: false,
            scope: scopeKey,
          };
        }
        if (opts.consultOnly) {
          if (!ctx.board || !ctx.board.hasSpecialist(scopeKey)) {
            return {
              text: `[scope=${scopeKey}] At max depth you may only query existing specialists [scope=...] already listed on the board; specify an existing scope or use grep/read directly.`,
              failed: false,
              scope: scopeKey,
            };
          }
        }
        const nextStack = [...stack, scopeKey];
        const maxSpec = opts.maxSpecialists ?? 12;
        const demoted =
          ctx.board !== undefined && !ctx.board.hasSpecialist(scopeKey) && ctx.board.specialistCount() >= maxSpec;
        const childMaxSteps = demoted ? Math.min(maxSteps, 4) : maxSteps;
        const nextAncestors = ctx.ancestorTasks ? [...ctx.ancestorTasks, subTask] : [subTask];
        const outcomeOf = (r: BranchRunnerResult): BranchSubtaskResult => {
          const complete = isCompleteBranchRun(r);
          const status = `[scope=${scopeKey}] branch ${complete ? 'done' : 'failed'}: ${r.terminated}, ${r.steps} steps${r.error ? ` (error: ${r.error})` : ''}`;
          const body = r.answer ?? '(no answer produced)';
          return {
            text: `${status}\nResult:\n${body}`,
            failed: !complete,
            scope: scopeKey,
            ...(complete ? {} : { error: r.error ?? `terminated: ${r.terminated}` }),
          };
        };
        if (ctx.board) {
          let failure: string | undefined;
          const { result, failed } = await ctx.board.runScopedBranch(
            scopeKey,
            subTask,
            async (sInput) => {
              const r = await run(sInput.initialTask, {
                depth: ctx.depth + 1,
                maxSteps: childMaxSteps,
                parent: ctx.agentName,
                scope: scopeKey,
                initialState: sInput.previousState,
                followUpQuestion: sInput.followUpQuestion,
                initialBoardCount: sInput.initialBoardRev,
                initialBoardSnapshot: sInput.initialBoardSnapshot,
                agentName: sInput.agentName,
                callStack: nextStack,
                ancestorTasks: nextAncestors,
                signal: ctx.signal,
              });
              const outcome = outcomeOf(r);
              if (outcome.error !== undefined) failure = outcome.error;
              return {
                resultText: outcome.text,
                answer: r.answer,
                state: r.state ?? { blocks: [], latest: undefined },
                ...(outcome.failed ? { failed: true } : {}),
              };
            },
            { depth: ctx.depth + 1, parent: ctx.agentName },
          );
          return {
            text: result,
            failed: failed === true,
            scope: scopeKey,
            ...(failure !== undefined ? { error: failure } : {}),
          };
        }
        const r = await run(subTask, {
          depth: ctx.depth + 1,
          maxSteps: childMaxSteps,
          parent: ctx.agentName,
          scope: scopeKey,
          callStack: nextStack,
          ancestorTasks: nextAncestors,
          signal: ctx.signal,
        });
        return outcomeOf(r);
      };

      if (tasks.length > 0) {
        const mergedTasks = mergeSubTasksByScope(tasks, ctx.store);
        const outcomes = await Promise.all(mergedTasks.map((t) => runSingle(t.task, t.scope)));
        const failures = outcomes.filter((outcome) => outcome.failed);
        if (failures.length > 0) {
          const details = failures
            .map((outcome) => `${outcome.scope}: ${outcome.error ?? 'incomplete result'}`)
            .join('; ');
          throw new Error(`branch aborted: ${failures.length} of ${outcomes.length} subtasks failed (${details})`);
        }
        const summary = outcomes
          .map((outcome, i) => {
            const spec = mergedTasks[i];
            const label = spec?.scope ? `[scope=${spec.scope}] ${spec.task}` : (spec?.task ?? '');
            return `[Subtask #${i + 1}] ${label}\n${outcome.text}`;
          })
          .join('\n\n');
        return truncateToTokens(summary, opts.maxResultTokens ?? 6000).text;
      }
      const single = await runSingle(task ?? '', explicitScope);
      if (single.failed) {
        throw new Error(`branch aborted: ${single.scope}: ${single.error ?? 'incomplete result'}`);
      }
      return truncateToTokens(single.text, opts.maxResultTokens ?? 3000).text;
    },
  };
}
