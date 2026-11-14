import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { isPlaceholderAnswer } from '../agent/agent-fold.js';
import { isAncestorEcho, normalizeScopeKey, normalizeTaskKey } from '../context/board.js';
import type { ContextStore } from '../context/store.js';
import type { FoldStateSnapshot } from '../fold/state.js';
import { defaultRateLimitGate } from '../llm/rate-limit-gate.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';
import { createLimiter } from '../util/concurrency.js';
import {
  normalizeBranchArguments,
  parseFlexibleBranchTasks,
  type NormalizedBranchArgs,
  type SubTaskSpec,
} from './branch-args.js';
import { argNumber, argString, ToolArgumentError, type Tool } from './types.js';

export { normalizeBranchArguments, parseFlexibleBranchTasks, type NormalizedBranchArgs, type SubTaskSpec };

/** Prefix for full branch reports stored in ContextStore. Hosts may persist these docs. */
export const BRANCH_REPORT_ID_PREFIX = 'branch_report_';

/** Store one complete subtask report; the caller gets a compact index entry. */
function storeReport(
  store: ContextStore,
  text: string,
  scope: string | undefined,
  task: string,
): { readonly id: string; readonly tokens: number; readonly lines: number } {
  const label = (scope !== undefined && scope !== '' ? scope : task).replace(/\s+/g, ' ').trim().slice(0, 120);
  const doc = store.add(text, {
    id: `${BRANCH_REPORT_ID_PREFIX}${randomUUID()}`,
    title: `branch report: ${label}`.slice(0, 160),
    manifest: false,
    transient: true,
  });
  return { id: doc.id, tokens: doc.tokens, lines: doc.lines.length };
}

/** Token-bounded excerpt. Returns whether truncation occurred. */
function excerptText(text: string, maxTokens: number): { readonly text: string; readonly truncated: boolean } {
  const res = truncateToTokens(text, Math.max(16, maxTokens), defaultEstimator);
  if (!res.truncated) return { text, truncated: false };
  const budget = Math.max(16, maxTokens);
  const chars = defaultEstimator.prefixChars(text, budget);
  return {
    text: `${text.slice(0, chars).trimEnd()}\n…[excerpt truncated; full report is stored]`,
    truncated: true,
  };
}

/**
 * Return a compact index that keeps every subtask header and stores each full
 * report as a document. The root can read the full text by its doc id.
 */

function buildReportIndex(
  outcomes: readonly BranchSubtaskResult[],
  specs: readonly SubTaskSpec[],
  store: ContextStore,
  maxTokens: number,
): string {
  const records = outcomes.map((outcome, index) => {
    const spec = specs[index];
    return {
      outcome,
      spec,
      report:
        outcome.report ??
        (outcome.failed ? undefined : storeReport(store, outcome.text, spec?.scope, spec?.task ?? 'branch task')),
    };
  });
  const formatHeaders = (useCompact: boolean): string[] => {
    const taskChars = useCompact ? 48 : Math.max(40, Math.min(320, Math.floor(12_000 / Math.max(1, records.length))));
    return records.map(({ outcome, spec, report }, index) => {
      const task = spec?.task ?? '';
      const shortTask = task.length > taskChars ? `${task.slice(0, taskChars - 1)}…` : task;
      const scope = spec?.scope !== undefined && spec.scope !== '' ? `[scope=${spec.scope}] ` : '';
      if (report === undefined) {
        const error = (outcome.error ?? 'incomplete result').replace(/\s+/g, ' ').slice(0, useCompact ? 40 : 120);
        return useCompact
          ? `[Subtask #${index + 1}] ${scope}${shortTask} FAILED: ${error}`
          : `[Subtask #${index + 1}] ${scope}${shortTask}\nFAILED: ${error}`;
      }
      return useCompact
        ? `[Subtask #${index + 1}] ${scope}${shortTask} → ${report.id}`
        : `[Subtask #${index + 1}] ${scope}${shortTask}\nFull report: \`${report.id}\` (${report.lines} lines, ~${report.tokens} tokens)`;
    });
  };
  let compact = records.length > 32;
  let headers = formatHeaders(compact);
  let headerTokens = defaultEstimator.count(headers.join('\n\n'));
  if (!compact && headerTokens > maxTokens) {
    compact = true;
    headers = formatHeaders(true);
    headerTokens = defaultEstimator.count(headers.join('\n\n'));
  }
  const successes = records.filter((record) => record.report !== undefined).length;
  let bodyBudget = compact
    ? 0
    : Math.max(0, Math.floor((maxTokens - headerTokens - 16) / Math.max(1, successes)));
  let index = '';
  for (let attempt = 0; attempt < 8; attempt++) {
    const effectiveBudget = attempt === 7 ? 0 : bodyBudget;
    index = records
      .map(({ outcome, report }, i) => {
        const header = headers[i] ?? '';
        if (report === undefined || effectiveBudget === 0) return header;
        const ex = excerptText(outcome.text, effectiveBudget);
        return ex.truncated ? `${header}\nExcerpt:\n${ex.text}` : `${header}\nComplete report:\n${ex.text}`;
      })
      .join('\n\n');
    if (defaultEstimator.count(index) <= maxTokens || effectiveBudget === 0) break;
    bodyBudget = Math.floor(bodyBudget * 0.65);
  }
  if (defaultEstimator.count(index) > maxTokens && !compact) {
    index = formatHeaders(true).join('\n\n');
  }
  return index;
}

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
  readonly cwd?: string;
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
  readonly maxBranchStepsCap?: number;
  maxResultTokens?: number;
  consultOnly?: boolean;
  readonly ownScope?: string;
  readonly defaultCwd?: string;
  /** Maximum independent tasks in one branch call. Default 200. */
  readonly maxSpecialists?: number;
  /** Maximum branch specialists that execute concurrently. Omit for unlimited. */
  readonly concurrency?: number;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function inferScope(explicitScope: string | undefined, taskText: string, store: ContextStore): string {
  if (explicitScope && explicitScope.trim() !== '') {
    const raw = explicitScope.trim();
    if (/[<>{}\[\]`]/.test(raw)) {
      const cleaned = raw.replace(/<[^>]*>/g, ' ').replace(/[{}\[\]"'`]+/g, ' ');
      const norm = normalizeScopeKey(cleaned).slice(0, 64).trim();
      if (norm !== '') return norm;
    }
    return normalizeScopeKey(raw);
  }
  const sanitizedTask = taskText
    .replace(/<[^>]*>/g, ' ')
    .replace(/[{}\[\]"'`]+/g, ' ');
  const docs = store.list();
  if (docs.length > 1) {
    const matchedDocs = docs.filter((d) => {
      const pat = new RegExp(`(?:^|[^a-z0-9_./-])${escapeRegExp(d.id)}(?:$|[^a-z0-9_./-])`, 'i');
      return pat.test(sanitizedTask);
    });
    if (matchedDocs.length === 1 && matchedDocs[0]) {
      return normalizeScopeKey(matchedDocs[0].id);
    }
  }
  const structMatches = [...sanitizedTask.matchAll(/\b([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./-]+|[a-z][a-z0-9]*_[a-z0-9_-]+)\b/g)];
  if (structMatches.length > 0) {
    const uniqueIds = new Set(structMatches.map((m) => normalizeScopeKey(m[1] ?? '')));
    uniqueIds.delete('');
    if (uniqueIds.size === 1) {
      const first = [...uniqueIds][0];
      if (first) return first.slice(0, 64).trim();
    }
  }
  return normalizeTaskKey(sanitizedTask).slice(0, 64).trim();
}

export function mergeSubTasksByScope(specs: readonly SubTaskSpec[], store: ContextStore): SubTaskSpec[] {
  if (specs.length <= 1) return [...specs];
  const groups = new Map<
    string,
    { firstScope: string | undefined; firstCwd: string | undefined; tasks: string[]; seenTasks: Set<string> }
  >();
  for (const spec of specs) {
    const scopeKey = inferScope(spec.scope, spec.task, store);
    const normT = normalizeTaskKey(spec.task);
    let g = groups.get(scopeKey);
    if (!g) {
      g = { firstScope: spec.scope, firstCwd: spec.cwd, tasks: [], seenTasks: new Set<string>() };
      groups.set(scopeKey, g);
    } else {
      if (!g.firstScope && spec.scope) g.firstScope = spec.scope;
      if (!g.firstCwd && spec.cwd) g.firstCwd = spec.cwd;
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
    merged[idx++] = {
      ...(finalScope !== undefined ? { scope: finalScope } : {}),
      task: combinedTask,
      ...(g.firstCwd !== undefined ? { cwd: g.firstCwd } : {}),
    };
  }
  return merged;
}

async function resolveSubtaskCwd(
  subCwd: string | undefined,
  subScope: string | undefined,
  baseCwd: string | undefined,
): Promise<string | undefined> {
  if (subCwd !== undefined && subCwd.trim() !== '') {
    const trimmed = subCwd.trim();
    return baseCwd !== undefined ? resolve(baseCwd, trimmed) : resolve(trimmed);
  }
  if (subScope !== undefined && subScope.trim() !== '') {
    const trimmed = subScope.trim();
    if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.startsWith('.')) {
      const candidate = baseCwd !== undefined ? resolve(baseCwd, trimmed) : isAbsolute(trimmed) ? trimmed : undefined;
      if (candidate !== undefined) {
        try {
          if ((await stat(candidate)).isDirectory()) return candidate;
        } catch {
          // Not an existing directory on disk; keep baseCwd.
        }
      }
    }
  }
  return baseCwd;
}

interface BranchSubtaskResult {
  readonly text: string;
  readonly failed: boolean;
  readonly scope: string;
  readonly error?: string;
  readonly report?: { readonly id: string; readonly tokens: number; readonly lines: number };
}

const RESEARCH_TASK =
  /\b(?:deeply|study|analy[sz]e|research|report|extract|list every|enumerate|summari[sz]e|compare|include|cite|citations|key facts|architecture|components?|tests?|benchmarks?|risks?)\b/i;
const MIN_RESEARCH_ANSWER_CHARS = 12;

/** A branch subtask is usable only when the child finished with a real answer and no error. */
function isCompleteBranchRun(result: BranchRunnerResult, task: string): boolean {
  if (typeof result.error === 'string' && result.error !== '') return false;
  if (result.terminated !== 'answer' && result.terminated !== 'forced_answer') return false;
  const answer = typeof result.answer === 'string' ? result.answer.trim() : '';
  if (answer === '' || isPlaceholderAnswer(answer)) return false;
  if (RESEARCH_TASK.test(task) && answer.length < MIN_RESEARCH_ANSWER_CHARS) return false;
  return true;
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
      'Delegate deep document, module, or external-tool research to a persistent scoped specialist sub-agent, or ask a follow-up question to an existing specialist [scope=...]. Pass "scope" (e.g. doc id, module name, or research topic) to reuse specialist state/cache and deduplicate; supports single "task" or up to 200 parallel "tasks". For document/file scopes, load unindexed filesystem paths with add_document first; specialists can also call any available external/host tools and nested sub-agents.',
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
            type: 'object',
            properties: {
              scope: { type: 'string', description: 'Document id or module/library scope for this subtask.' },
              task: { type: 'string', description: 'Subtask instruction or follow-up question.' },
              cwd: { type: 'string', description: 'Optional working directory for this subtask.' },
            },
          },
          description: 'Optional: dispatch multiple independent subtasks in parallel ({scope, task} objects or task strings; same scope is merged and deduplicated).',
        },
        cwd: { type: 'string', description: 'Optional working directory for the specialist sub-agent.' },
        max_steps: {
          type: 'integer',
          description: `Step budget (default ${opts.maxBranchSteps ?? 30}, max ${Math.max(opts.maxBranchSteps ?? 30, opts.maxBranchStepsCap ?? 100)}).`,
        },
      },
      required: [],
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, ctx) {
      const rawScope = argString(rawArgs, 'scope', false);
      if (rawArgs.tasks !== undefined && rawArgs.tasks !== null && rawArgs.tasks !== '') {
        parseFlexibleBranchTasks(rawArgs.tasks, rawScope);
      }
      const args = normalizeBranchArguments(rawArgs);
      const explicitScope = argString(args, 'scope', false);
      const task =
        argString(args, 'task', false) ??
        argString(args, 'question', false) ??
        argString(args, 'query', false);
      const tasks = parseFlexibleBranchTasks(args.tasks, explicitScope);
      if (!task && tasks.length === 0) {
        throw new ToolArgumentError('must provide "task" or "tasks"');
      }
      const defaultSteps = opts.maxBranchSteps ?? 30;
      const stepCap = Math.max(defaultSteps, opts.maxBranchStepsCap ?? 100);
      const requestedSteps = argNumber(args, 'max_steps');
      const maxSteps = Math.max(
        1,
        Math.min(requestedSteps !== undefined ? Math.floor(requestedSteps) : defaultSteps, stepCap),
      );
      const explicitCwd =
        argString(args, 'cwd', false) ??
        argString(args, 'workdir', false) ??
        argString(args, 'working_directory', false) ??
        argString(args, 'workingDirectory', false);

      const runSingle = async (subTask: string, subScope?: string, subCwd?: string): Promise<BranchSubtaskResult> => {
        const scopeKey = inferScope(subScope, subTask, ctx.store);
        const effectiveCwd = await resolveSubtaskCwd(subCwd, subScope, ctx.cwd ?? opts.defaultCwd);
        const leaveWorker = defaultRateLimitGate.enterWorker();
        const childController = new AbortController();
        const outerSignal = ctx.signal;
        const onOuterAbort = () => childController.abort(outerSignal?.reason);
        if (outerSignal?.aborted) {
          childController.abort(outerSignal.reason);
        } else if (outerSignal) {
          outerSignal.addEventListener('abort', onOuterAbort, { once: true });
        }
        const commitIfComplete = (outcome: BranchSubtaskResult): BranchSubtaskResult => {
          if (outcome.failed || outcome.report !== undefined) return outcome;
          const report = storeReport(ctx.store, outcome.text, subScope ?? outcome.scope, subTask);
          ctx.emit({
            type: 'branch_report',
            agent: ctx.agentName,
            step: ctx.step,
            scope: outcome.scope,
            reportId: report.id,
            tokens: report.tokens,
            lines: report.lines,
          });
          return { ...outcome, report };
        };
        try {
          const sameOrUnspecifiedScope =
            !subScope || !opts.ownScope || normalizeScopeKey(subScope) === normalizeScopeKey(opts.ownScope);
          if (ctx.depth > 0 && sameOrUnspecifiedScope && ctx.ancestorTasks && isAncestorEcho(subTask, ctx.ancestorTasks)) {
            return commitIfComplete({
              text: `[scope=${scopeKey}] [ledger: ancestor echo rejected — do NOT call branch on your own scope or re-delegate your assigned task. Use search / grep / read / tally directly on your scope document.]`,
              failed: false,
              scope: scopeKey,
            });
          }
          if (opts.ownScope && scopeKey === normalizeScopeKey(opts.ownScope)) {
            return commitIfComplete({
              text: `[scope=${scopeKey}] You are already the specialist responsible for [${scopeKey}]; do NOT call branch on your own scope! Use grep / read / tally directly on your document.`,
              failed: false,
              scope: scopeKey,
            });
          }
          const stack = ctx.callStack ?? [];
          if (stack.includes(scopeKey)) {
            const existingSummary = ctx.board?.getSpecialist(scopeKey)?.latestSummary;
            return commitIfComplete({
              text: existingSummary
                ? `[scope=${scopeKey}] (cycle detected on scope; returning latest known specialist summary)\n${existingSummary}`
                : `[scope=${scopeKey}] (cycle detected on scope; use existing board findings or document tools directly)`,
              failed: false,
              scope: scopeKey,
            });
          }
          if (opts.consultOnly) {
            if (!ctx.board || !ctx.board.hasSpecialist(scopeKey)) {
              return commitIfComplete({
                text: `[scope=${scopeKey}] At max depth you may only query existing specialists [scope=...] already listed on the board; specify an existing scope or use grep/read directly.`,
                failed: false,
                scope: scopeKey,
              });
            }
          }
          const nextStack = [...stack, scopeKey];
          const maxSpec = opts.maxSpecialists ?? 200;
          const demoted =
            ctx.board !== undefined && !ctx.board.hasSpecialist(scopeKey) && ctx.board.specialistCount() >= maxSpec;
          const childMaxSteps = demoted ? Math.min(maxSteps, 4) : maxSteps;
          const nextAncestors = ctx.ancestorTasks ? [...ctx.ancestorTasks, subTask] : [subTask];
          const outcomeOf = (r: BranchRunnerResult): BranchSubtaskResult => {
            const complete = isCompleteBranchRun(r, subTask);
            const rejectReason =
              r.error ??
              (r.terminated !== 'answer' && r.terminated !== 'forced_answer'
                ? `terminated: ${r.terminated}`
                : 'answer is a placeholder or too short for a research task');
            const status = `[scope=${scopeKey}] branch ${complete ? 'done' : 'failed'}: ${r.terminated}, ${r.steps} steps${complete ? '' : ` (${rejectReason})`}`;
            const body = r.answer ?? '(no answer produced)';
            return {
              text: `${status}\nResult:\n${body}`,
              failed: !complete,
              scope: scopeKey,
              ...(complete ? {} : { error: rejectReason }),
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
                  ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
                  signal: childController.signal,
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
            return commitIfComplete({
              text: result,
              failed: failed === true,
              scope: scopeKey,
              ...(failure !== undefined ? { error: failure } : {}),
            });
          }
          const r = await run(subTask, {
            depth: ctx.depth + 1,
            maxSteps: childMaxSteps,
            parent: ctx.agentName,
            scope: scopeKey,
            callStack: nextStack,
            ancestorTasks: nextAncestors,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            signal: childController.signal,
          });
          return commitIfComplete(outcomeOf(r));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            text: `[scope=${scopeKey}] branch failed: ${errMsg}`,
            failed: true,
            scope: scopeKey,
            error: errMsg,
          };
        } finally {
          outerSignal?.removeEventListener('abort', onOuterAbort);
          leaveWorker();
        }
      };

      if (tasks.length > 0) {
        const mergedTasks = mergeSubTasksByScope(tasks, ctx.store);
        const maxTasks = opts.maxSpecialists ?? 200;
        if (mergedTasks.length > maxTasks) {
          throw new ToolArgumentError(
            `too many branch tasks: ${mergedTasks.length} (max ${maxTasks}); split the call into smaller batches`,
          );
        }
        const effectiveConcurrency = opts.concurrency ?? 8;
        const limit =
          Number.isFinite(effectiveConcurrency) && effectiveConcurrency >= 1
            ? createLimiter(Math.floor(effectiveConcurrency))
            : undefined;
        const outcomes = await Promise.all(
          mergedTasks.map((t) =>
            limit !== undefined ? limit(() => runSingle(t.task, t.scope, t.cwd)) : runSingle(t.task, t.scope, t.cwd),
          ),
        );
        return buildReportIndex(outcomes, mergedTasks, ctx.store, opts.maxResultTokens ?? 6000);
      }
      const single = await runSingle(task ?? '', explicitScope, explicitCwd);
      if (single.failed) {
        const priorSummary = ctx.board?.getSpecialist(single.scope)?.latestSummary;
        if (priorSummary !== undefined && priorSummary !== '') {
          return `[scope=${single.scope}] follow-up failed (${single.error ?? 'incomplete result'}); preserved prior specialist report:\n${priorSummary}`;
        }
        throw new Error(`branch aborted: ${single.scope}: ${single.error ?? 'incomplete result'}`);
      }
      const maxTokens = opts.maxResultTokens ?? 6000;
      const report =
        single.report ?? storeReport(ctx.store, single.text, explicitScope ?? single.scope, task ?? 'branch task');
      const ex = excerptText(single.text, maxTokens);
      return `${ex.text}\n\nFull report: \`${report.id}\` (${report.lines} lines, ~${report.tokens} tokens)`;
    },
  };
}
