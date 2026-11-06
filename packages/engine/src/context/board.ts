import type { FoldStateSnapshot } from '../fold/state.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';

export interface BoardEntry {
  readonly id: number;
  readonly agent: string;
  readonly kind: 'llm_query' | 'tally' | 'grep' | 'branch';
  readonly scope: string;
  readonly key: string;
  readonly summary: string;
  readonly counts?: Readonly<Record<string, number>>;
}

export interface SpecialistSession {
  readonly scope: string;
  readonly agentName: string;
  readonly initialTask: string;
  readonly initialBoardCount: number;
  readonly initialBoardSnapshot?: string;
  state: FoldStateSnapshot;
  latestSummary: string;
  readonly qaMemo: Map<string, string>;
  queue: Promise<void>;
}

export interface ScopedBranchRunInput {
  readonly isFollowUp: boolean;
  readonly initialTask: string;
  readonly followUpQuestion?: string;
  readonly previousState?: FoldStateSnapshot;
  readonly initialBoardCount: number;
  readonly initialBoardSnapshot?: string;
  readonly agentName: string;
}

export interface ScopedBranchRunOutput {
  readonly resultText: string;
  readonly answer: string | null;
  readonly state: FoldStateSnapshot;
}

export function normalizeScopeKey(scope: string): string {
  return scope.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function normalizeTaskKey(task: string): string {
  return task.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Shared, append-only research board across root, branch sub-agents,
 * and sequential tasks sharing an LLMQueryEngine or ContextStore.
 */
export class ResearchBoard {
  private readonly _entries: BoardEntry[] = [];
  private readonly _specialists = new Map<string, SpecialistSession>();
  private _specialistCounter = 0;

  record(entry: Omit<BoardEntry, 'id'>): BoardEntry {
    const dedupKey = `${entry.kind}|${entry.scope}|${entry.key}`;
    const idx = this._entries.findIndex((e) => `${e.kind}|${e.scope}|${e.key}` === dedupKey);
    if (idx >= 0) {
      const existing = this._entries[idx];
      if (existing) {
        const updated: BoardEntry = {
          id: existing.id,
          agent: entry.agent,
          kind: entry.kind,
          scope: entry.scope,
          key: entry.key,
          summary: entry.summary,
          ...(entry.counts ? { counts: Object.freeze({ ...entry.counts }) } : {}),
        };
        this._entries[idx] = updated;
        return updated;
      }
    }
    const created: BoardEntry = {
      id: this._entries.length + 1,
      agent: entry.agent,
      kind: entry.kind,
      scope: entry.scope,
      key: entry.key,
      summary: entry.summary,
      ...(entry.counts ? { counts: Object.freeze({ ...entry.counts }) } : {}),
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

  render(maxTokens = 1200): string {
    if (this._entries.length === 0) return '（暂无已共享的研究结论）';
    const lines = this._entries.map((e) => this.formatEntry(e));
    return truncateToTokens(lines.join('\n'), maxTokens, defaultEstimator).text;
  }

  renderSince(startIndex: number, maxTokens = 800): string | undefined {
    if (this._entries.length <= startIndex) return undefined;
    const lines = this._entries.slice(startIndex).map((e) => this.formatEntry(e));
    return truncateToTokens(lines.join('\n'), maxTokens, defaultEstimator).text;
  }

  async runScopedBranch(
    scope: string,
    task: string,
    fn: (input: ScopedBranchRunInput) => Promise<ScopedBranchRunOutput>,
  ): Promise<{ result: string; reused: boolean; scope: string }> {
    const normScope = normalizeScopeKey(scope);
    const normTask = normalizeTaskKey(task);
    const existingSession = this._specialists.get(normScope);
    const fastMemo = existingSession?.qaMemo.get(normTask);
    if (fastMemo !== undefined) {
      return { result: fastMemo, reused: true, scope: normScope };
    }
    let session = existingSession;
    if (!session) {
      const initCount = this._entries.length;
      session = {
        scope: normScope,
        agentName: `specialist#${++this._specialistCounter}[${normScope}]`,
        initialTask: task.trim(),
        initialBoardCount: initCount,
        ...(initCount > 0 ? { initialBoardSnapshot: this.render() } : {}),
        state: { blocks: [], latest: undefined },
        latestSummary: '',
        qaMemo: new Map<string, string>(),
        queue: Promise.resolve(),
      };
      this._specialists.set(normScope, session);
    }
    const targetSession = session;
    const runTask = async (): Promise<{ result: string; reused: boolean; scope: string }> => {
      const cached = targetSession.qaMemo.get(normTask);
      if (cached !== undefined) {
        return { result: cached, reused: true, scope: normScope };
      }
      if (
        targetSession.latestSummary !== '' &&
        normTask === normalizeTaskKey(targetSession.initialTask)
      ) {
        return { result: targetSession.latestSummary, reused: true, scope: normScope };
      }
      const isFollowUp = targetSession.state.blocks.length > 0 || targetSession.latestSummary !== '';
      const out = await fn({
        isFollowUp,
        initialTask: targetSession.initialTask,
        ...(isFollowUp ? { followUpQuestion: task.trim(), previousState: targetSession.state } : {}),
        initialBoardCount: targetSession.initialBoardCount,
        ...(targetSession.initialBoardSnapshot !== undefined
          ? { initialBoardSnapshot: targetSession.initialBoardSnapshot }
          : {}),
        agentName: targetSession.agentName,
      });
      targetSession.state = out.state;
      targetSession.latestSummary = out.resultText;
      targetSession.qaMemo.set(normTask, out.resultText);
      this.record({
        agent: targetSession.agentName,
        kind: 'branch',
        scope: normScope,
        key: normScope,
        summary: out.answer ? `${targetSession.agentName}: ${out.answer}` : out.resultText,
      });
      return { result: out.resultText, reused: false, scope: normScope };
    };
    const chained = targetSession.queue.then(runTask, runTask);
    targetSession.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  async runAtomicBranch(key: string, fn: () => Promise<string>): Promise<{ result: string; reused: boolean }> {
    const { result, reused } = await this.runScopedBranch(key, key, async () => {
      const r = await fn();
      return { resultText: r, answer: r, state: { blocks: [], latest: undefined } };
    });
    return { result, reused };
  }
}
