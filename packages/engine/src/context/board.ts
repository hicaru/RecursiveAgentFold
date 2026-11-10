import type { FoldStateSnapshot } from '../fold/state.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';

export interface BoardEntry {
  readonly id: number;
  readonly rev: number;
  readonly agent: string;
  readonly kind: 'llm_query' | 'tally' | 'grep' | 'branch' | 'tool';
  readonly scope: string;
  readonly key: string;
  readonly summary: string;
  readonly counts?: Readonly<Record<string, number>>;
  readonly inProgress?: boolean;
}

export interface SpecialistSession {
  readonly scope: string;
  readonly agentName: string;
  readonly depth: number;
  readonly parentAgent: string;
  readonly initialTask: string;
  readonly initialBoardRev: number;
  readonly initialBoardCount: number;
  readonly initialBoardSnapshot?: string;
  status: 'running' | 'ready';
  activeTask?: string;
  state: FoldStateSnapshot;
  latestSummary: string;
  readonly historySummaries: string[];
  readonly qaMemo: Map<string, string>;
  queue: Promise<void>;
}

/** JSON-safe specialist state. The queue is rebuilt on restore. */
export interface SpecialistSessionSnapshot {
  readonly scope: string;
  readonly agentName: string;
  readonly depth: number;
  readonly parentAgent: string;
  readonly initialTask: string;
  readonly initialBoardRev: number;
  readonly initialBoardCount: number;
  readonly initialBoardSnapshot?: string;
  readonly state: FoldStateSnapshot;
  readonly latestSummary: string;
  readonly historySummaries: readonly string[];
  readonly qaMemo: readonly (readonly [string, string])[];
}

/** JSON-safe board snapshot for host-side persistence. */
export interface ResearchBoardSnapshot {
  readonly rev: number;
  readonly specialistCounter: number;
  readonly entries: readonly BoardEntry[];
  readonly specialists: readonly SpecialistSessionSnapshot[];
}

export interface ScopedBranchRunInput {
  readonly isFollowUp: boolean;
  readonly initialTask: string;
  readonly followUpQuestion?: string;
  readonly previousState?: FoldStateSnapshot;
  readonly initialBoardRev: number;
  readonly initialBoardCount: number;
  readonly initialBoardSnapshot?: string;
  readonly agentName: string;
}
export interface ScopedBranchRunOutput {
  readonly resultText: string;
  readonly answer: string | null;
  readonly state: FoldStateSnapshot;
  /** A failed run is not cached as a specialist answer. */
  readonly failed?: boolean;
}

export function normalizeScopeKey(scope: string): string {
  return scope.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeTaskKey(task: string): string {
  return task.trim().replace(/\s+/g, ' ').toLowerCase();
}
export const ECHO_JACCARD = 0.8;

const TASK_NOISE_WORDS: Readonly<Record<string, true>> = Object.freeze({
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, by: true,
  for: true, from: true, has: true, in: true, is: true, it: true, of: true, on: true,
  or: true, that: true, the: true, to: true, was: true, were: true, will: true, with: true,
  please: true, find: true, determine: true, analyze: true, inspect: true, calculate: true,
  compute: true, what: true, which: true, how: true, document: true, module: true,
  file: true, scope: true, task: true, question: true,
});

const TASK_TOK_RE = /[a-z0-9_.\-/]{2,}|\p{Script=Han}{2,}/gu;
const TARGET_ID_RE =
  /\b(?:(?:lib|mod|dep|service|pkg|doc|app|spec)[_-][a-z0-9_-]+|[A-Z][A-Z0-9_]{2,}|doc[_-]?\d+|[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+)\b/g;

/** Extract normalized content tokens from a task string for echo detection. */
export function taskTokenSet(text: string): ReadonlySet<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const m of lower.matchAll(TASK_TOK_RE)) {
    const tok = m[0];
    if (tok && !TASK_NOISE_WORDS[tok]) {
      out.add(tok);
    }
  }
  return out;
}

/** Extract target module, document, or constant identifiers from a task string. */
export function targetTokenSet(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(TARGET_ID_RE)) {
    const tok = m[0];
    if (tok) out.add(tok.toLowerCase());
  }
  return out;
}

/** Compute Jaccard similarity between two token sets. */
export function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) inter++;
  }
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

/** Check whether childTask echoes any ancestor task with >= 0.8 Jaccard and identical target identifiers. */
export function isAncestorEcho(childTask: string, ancestorTasks: readonly string[]): boolean {
  const childTokens = taskTokenSet(childTask);
  if (childTokens.size === 0) return false;
  const childTargets = targetTokenSet(childTask);
  for (let i = 0; i < ancestorTasks.length; i++) {
    const anc = ancestorTasks[i];
    if (!anc) continue;
    const ancTokens = taskTokenSet(anc);
    if (jaccardSimilarity(childTokens, ancTokens) >= ECHO_JACCARD) {
      const ancTargets = targetTokenSet(anc);
      if (setsEqual(childTargets, ancTargets)) {
        return true;
      }
    }
  }
  return false;
}


function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether all code/constant identifiers requested in `taskText`
 * are already resolved as explicit `IDENT = <number>` facts in `summaryText`.
 */
export function canAnswerFromSummary(taskText: string, summaryText: string, scopeKey?: string): boolean {
  if (!summaryText) return false;
  const allCodeIds = taskText.match(/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g);
  if (!allCodeIds || allCodeIds.length === 0) return false;
  const filtered = allCodeIds.filter((id) => !scopeKey || id.toLowerCase() !== scopeKey.toLowerCase());
  if (filtered.length === 0) return false;
  for (const id of new Set(filtered)) {
    if (!/^[A-Z][A-Z0-9_]{3,}$/.test(id)) return false;
    const pat = new RegExp(`\\b${escapeRegExp(id)}\\s*=\\s*[-+]?\\d+`);
    if (!pat.test(summaryText)) return false;
  }
  return true;
}

/**
 * Shared, append-only research board across root, branch sub-agents,
 * and sequential tasks sharing an LLMQueryEngine or ContextStore.
 */
export class ResearchBoard {
  private readonly _entries: BoardEntry[] = [];
  private readonly _specialists = new Map<string, SpecialistSession>();
  private _specialistCounter = 0;
  private _rev = 0;

  currentRev(): number {
    return this._rev;
  }

  settledRev(): number {
    let max = 0;
    for (const e of this._entries) {
      if (!e.inProgress && e.rev > max) max = e.rev;
    }
    return max;
  }

  record(entry: Omit<BoardEntry, 'id' | 'rev'>): BoardEntry {
    const rev = ++this._rev;
    const dedupKey = `${entry.kind}|${entry.scope}|${entry.key}`;
    const idx = this._entries.findIndex((e) => `${e.kind}|${e.scope}|${e.key}` === dedupKey);
    if (idx >= 0) {
      const existing = this._entries[idx];
      if (existing) {
        const updated: BoardEntry = {
          id: existing.id,
          rev,
          agent: entry.agent,
          kind: entry.kind,
          scope: entry.scope,
          key: entry.key,
          summary: entry.summary,
          ...(entry.counts ? { counts: Object.freeze({ ...entry.counts }) } : {}),
          ...(entry.inProgress !== undefined ? { inProgress: entry.inProgress } : {}),
        };
        this._entries[idx] = updated;
        return updated;
      }
    }
    const created: BoardEntry = {
      id: this._entries.length + 1,
      rev,
      agent: entry.agent,
      kind: entry.kind,
      scope: entry.scope,
      key: entry.key,
      summary: entry.summary,
      ...(entry.counts ? { counts: Object.freeze({ ...entry.counts }) } : {}),
      ...(entry.inProgress !== undefined ? { inProgress: entry.inProgress } : {}),
    };
    this._entries.push(created);
    return created;
  }

  entries(): readonly BoardEntry[] {
    return this._entries;
  }

  hasSpecialist(scope: string): boolean {
    return this._specialists.has(normalizeScopeKey(scope));
  }

  getSpecialist(scope: string): SpecialistSession | undefined {
    return this._specialists.get(normalizeScopeKey(scope));
  }

  specialistCount(): number {
    return this._specialists.size;
  }

  /** Remove one branch entry. Used to roll back an unsuccessful new task. */
  removeBranchEntry(scope: string): boolean {
    const norm = normalizeScopeKey(scope);
    const index = this._entries.findIndex((entry) => entry.kind === 'branch' && normalizeScopeKey(entry.scope) === norm);
    if (index < 0) return false;
    this._entries.splice(index, 1);
    return true;
  }

  findCounts(scope?: string, categories?: readonly string[]): Readonly<Record<string, number>> | undefined {
    if (!categories || !categories.length) return undefined;
    const normCats = categories.map((c) => c.trim().toLowerCase());
    for (const e of this._entries) {
      if (e.kind !== 'llm_query' || !e.counts) continue;
      if (scope && !e.scope.includes(scope)) continue;
      const hasAll = normCats.every((c) => Object.prototype.hasOwnProperty.call(e.counts, c));
      if (hasAll) return e.counts;
    }
    return undefined;
  }

  private formatEntry(e: BoardEntry): string {
    const scopeLabel = e.kind === 'branch' ? `scope=${e.scope}` : e.scope;
    return `- [#${e.id}][${e.kind}][${scopeLabel}] ${e.summary.replace(/\s+/g, ' ').trim()}`;
  }

  render(maxTokens = 2400): string {
    if (this._entries.length === 0) return '(no shared findings yet)';
    const lines = this._entries.map((e) => this.formatEntry(e));
    return truncateToTokens(lines.join('\n'), maxTokens, defaultEstimator).text;
  }

  renderSettled(maxTokens = 2400): string | undefined {
    const settled = this._entries.filter((e) => !e.inProgress);
    if (settled.length === 0) return undefined;
    const lines = settled.map((e) => this.formatEntry(e));
    return truncateToTokens(lines.join('\n'), maxTokens, defaultEstimator).text;
  }

  renderSince(
    sinceRev: number,
    excludeScopeOrMaxTokens?: string | number,
    maxTokens = 2400,
  ): string | undefined {
    const excludeScope =
      typeof excludeScopeOrMaxTokens === 'string' ? normalizeScopeKey(excludeScopeOrMaxTokens) : undefined;
    const budget = typeof excludeScopeOrMaxTokens === 'number' ? excludeScopeOrMaxTokens : maxTokens;
    const lines: string[] = [];
    for (const e of this._entries) {
      if (e.rev <= sinceRev && !e.inProgress) continue;
      if (excludeScope !== undefined && e.kind === 'branch' && normalizeScopeKey(e.scope) === excludeScope) {
        continue;
      }
      lines.push(this.formatEntry(e));
    }
    if (lines.length === 0) return undefined;
    return truncateToTokens(lines.join('\n'), budget, defaultEstimator).text;
  }

  async runScopedBranch(
    scope: string,
    task: string,
    fn: (input: ScopedBranchRunInput) => Promise<ScopedBranchRunOutput>,
    meta?: { readonly depth?: number; readonly parent?: string },
  ): Promise<{ result: string; reused: boolean; scope: string; failed?: boolean }> {
    const normScope = normalizeScopeKey(scope);
    const normTask = normalizeTaskKey(task);
    const existingSession = this._specialists.get(normScope);
    const fastMemo = existingSession?.qaMemo.get(normTask);
    if (fastMemo !== undefined) {
      return { result: fastMemo, reused: true, scope: normScope };
    }
    if (
      existingSession &&
      existingSession.status === 'ready' &&
      existingSession.latestSummary !== '' &&
      canAnswerFromSummary(task, existingSession.latestSummary)
    ) {
      return { result: existingSession.latestSummary, reused: true, scope: normScope };
    }
    let session = existingSession;
    if (!session) {
      const initRev = this.settledRev();
      const initSnap = this.renderSettled();
      const depth = meta?.depth ?? 1;
      const parentAgent = meta?.parent ?? 'root';
      const idx = ++this._specialistCounter;
      const agentName =
        depth > 1 ? `specialist#${idx}@d${depth}[${normScope}]` : `specialist#${idx}[${normScope}]`;
      session = {
        scope: normScope,
        agentName,
        depth,
        parentAgent,
        initialTask: task.trim(),
        initialBoardRev: initRev,
        initialBoardCount: initRev,
        ...(initSnap !== undefined ? { initialBoardSnapshot: initSnap } : {}),
        status: 'running',
        activeTask: task.trim(),
        state: { blocks: [], latest: undefined },
        latestSummary: '',
        historySummaries: [],
        qaMemo: new Map<string, string>(),
        queue: Promise.resolve(),
      };
      this._specialists.set(normScope, session);
      this.record({
        agent: session.agentName,
        kind: 'branch',
        scope: normScope,
        key: normScope,
        summary: `[in-progress] ${session.agentName} (parent=${session.parentAgent}) analyzing scope "${normScope}": ${task.trim().slice(0, 140)}`,
        inProgress: true,
      });
    }
    const targetSession = session;
    const runTask = async (): Promise<{ result: string; reused: boolean; scope: string; failed?: boolean }> => {
      const cached = targetSession.qaMemo.get(normTask);
      if (cached !== undefined) {
        return { result: cached, reused: true, scope: normScope };
      }
      if (
        targetSession.latestSummary !== '' &&
        (normTask === normalizeTaskKey(targetSession.initialTask) ||
          canAnswerFromSummary(task, targetSession.latestSummary, normScope))
      ) {
        return { result: targetSession.latestSummary, reused: true, scope: normScope };
      }
      const hasPriorState = targetSession.state.blocks.length > 0;
      const isFollowUp =
        targetSession.latestSummary !== '' ||
        (hasPriorState && normTask !== normalizeTaskKey(targetSession.initialTask));
      targetSession.status = 'running';
      targetSession.activeTask = task.trim();
      try {
        let out: ScopedBranchRunOutput;
        try {
          out = await fn({
            isFollowUp,
            initialTask: targetSession.initialTask,
            ...(isFollowUp ? { followUpQuestion: task.trim() } : {}),
            ...(hasPriorState || isFollowUp ? { previousState: targetSession.state } : {}),
            initialBoardRev: targetSession.initialBoardRev,
            initialBoardCount: targetSession.initialBoardRev,
            ...(targetSession.initialBoardSnapshot !== undefined
              ? { initialBoardSnapshot: targetSession.initialBoardSnapshot }
              : {}),
            agentName: targetSession.agentName,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          out = {
            resultText: `[scope=${normScope}] branch failed: ${msg}`,
            answer: null,
            state: targetSession.state,
            failed: true,
          };
        }
        if (out.failed === true) {
          // Remove any in-progress board entry on failure. Preserve partial folded blocks
          // when an interrupted multi-step specialist already condensed work; otherwise roll back.
          if (targetSession.latestSummary === '') {
            this.removeBranchEntry(normScope);
            if (out.state.blocks.length > 0) {
              targetSession.state = out.state;
            } else {
              this._specialists.delete(normScope);
            }
          }
          return { result: out.resultText, reused: false, scope: normScope, failed: true };
        }
        const previousState = targetSession.state;
        const previousLatest = targetSession.latestSummary;
        const previousHistory = [...targetSession.historySummaries];
        const previousMemo = new Map(targetSession.qaMemo);
        const entryIndex = this._entries.findIndex(
          (entry) => entry.kind === 'branch' && normalizeScopeKey(entry.scope) === normScope,
        );
        const previousEntry = entryIndex >= 0 ? this._entries[entryIndex] : undefined;
        try {
          targetSession.state = out.state;
          const cleanAns = (out.answer ?? out.resultText).replace(/\s+/g, ' ').trim().slice(0, 500);
          if (cleanAns && !targetSession.historySummaries.includes(cleanAns)) {
            targetSession.historySummaries.push(cleanAns);
          }
          const combinedSummary = targetSession.historySummaries.join(' | ');
          targetSession.latestSummary =
            isFollowUp && targetSession.latestSummary !== '' && !targetSession.latestSummary.includes(out.resultText)
              ? `${targetSession.latestSummary}\n\n[follow-up] ${out.resultText}`
              : out.resultText;
          targetSession.qaMemo.set(normTask, out.resultText);
          this.record({
            agent: targetSession.agentName,
            kind: 'branch',
            scope: normScope,
            key: normScope,
            summary: `${targetSession.agentName}: ${combinedSummary}`,
            inProgress: false,
          });
        } catch (error) {
          targetSession.state = previousState;
          targetSession.latestSummary = previousLatest;
          targetSession.historySummaries.length = 0;
          targetSession.historySummaries.push(...previousHistory);
          targetSession.qaMemo.clear();
          for (const [key, value] of previousMemo) targetSession.qaMemo.set(key, value);
          if (previousEntry !== undefined) this._entries[entryIndex] = previousEntry;
          else this.removeBranchEntry(normScope);
          throw error;
        }
        return { result: out.resultText, reused: false, scope: normScope };
      } finally {
        targetSession.status = 'ready';
        targetSession.activeTask = undefined;
      }
    };
    const chained = targetSession.queue.then(runTask, runTask);
    targetSession.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  /** Detached JSON-safe state. Restored specialists are ready, never running. */
  snapshot(): ResearchBoardSnapshot {
    const specialists: SpecialistSessionSnapshot[] = [];
    for (const s of this._specialists.values()) {
      specialists.push({
        scope: s.scope,
        agentName: s.agentName,
        depth: s.depth,
        parentAgent: s.parentAgent,
        initialTask: s.initialTask,
        initialBoardRev: s.initialBoardRev,
        initialBoardCount: s.initialBoardCount,
        ...(s.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: s.initialBoardSnapshot } : {}),
        state: {
          blocks: s.state.blocks.map((b) => ({ from: b.from, to: b.to, summary: b.summary })),
          ...(s.state.latest !== undefined
            ? {
                latest: {
                  step: s.state.latest.step,
                  motivation: s.state.latest.motivation,
                  action: { name: s.state.latest.action.name, arguments: { ...s.state.latest.action.arguments } },
                  observation: s.state.latest.observation,
                },
              }
            : {}),
        },
        latestSummary: s.latestSummary,
        historySummaries: [...s.historySummaries],
        qaMemo: [...s.qaMemo.entries()],
      });
    }
    return {
      rev: this._rev,
      specialistCounter: this._specialistCounter,
      entries: this._entries.map((e) => ({ ...e, ...(e.counts !== undefined ? { counts: { ...e.counts } } : {}) })),
      specialists,
    };
  }

  static restore(snapshot: ResearchBoardSnapshot): ResearchBoard {
    if (snapshot === null || typeof snapshot !== 'object') throw new Error('invalid research board snapshot');
    const board = new ResearchBoard();
    let rev = Number.isInteger(snapshot.rev) && snapshot.rev >= 0 ? snapshot.rev : 0;
    for (const e of snapshot.entries) {
      const entry: BoardEntry = {
        id: e.id,
        rev: e.rev,
        agent: e.agent,
        kind: e.kind,
        scope: e.scope,
        key: e.key,
        summary: e.summary,
        ...(e.counts !== undefined ? { counts: Object.freeze({ ...e.counts }) } : {}),
        ...(e.inProgress !== undefined ? { inProgress: e.inProgress } : {}),
      };
      board._entries.push(entry);
      if (entry.rev > rev) rev = entry.rev;
    }
    board._rev = rev;
    board._specialistCounter = Number.isInteger(snapshot.specialistCounter) && snapshot.specialistCounter >= 0 ? snapshot.specialistCounter : 0;
    for (const s of snapshot.specialists) {
      const scope = normalizeScopeKey(s.scope);
      if (scope === '' || board._specialists.has(scope)) continue;
      board._specialists.set(scope, {
        scope,
        agentName: s.agentName,
        depth: s.depth,
        parentAgent: s.parentAgent,
        initialTask: s.initialTask,
        initialBoardRev: s.initialBoardRev,
        initialBoardCount: s.initialBoardCount,
        ...(s.initialBoardSnapshot !== undefined ? { initialBoardSnapshot: s.initialBoardSnapshot } : {}),
        status: 'ready',
        state: {
          blocks: s.state.blocks.map((b) => ({ from: b.from, to: b.to, summary: b.summary })),
          ...(s.state.latest !== undefined
            ? {
                latest: {
                  step: s.state.latest.step,
                  motivation: s.state.latest.motivation,
                  action: { name: s.state.latest.action.name, arguments: { ...s.state.latest.action.arguments } },
                  observation: s.state.latest.observation,
                },
              }
            : {}),
        },
        latestSummary: s.latestSummary,
        historySummaries: [...s.historySummaries],
        qaMemo: new Map(s.qaMemo.map(([k, v]) => [k, v])),
        queue: Promise.resolve(),
      });
    }
    return board;
  }

  async runAtomicBranch(key: string, fn: () => Promise<string>): Promise<{ result: string; reused: boolean }> {
    const { result, reused } = await this.runScopedBranch(key, key, async () => {
      const r = await fn();
      return { resultText: r, answer: r, state: { blocks: [], latest: undefined } };
    });
    return { result, reused };
  }
}
