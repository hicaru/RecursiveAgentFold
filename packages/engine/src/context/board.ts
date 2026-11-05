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

/**
 * Shared, append-only research board across root, branch sub-agents,
 * and sequential tasks sharing an LLMQueryEngine or ContextStore.
 */
export class ResearchBoard {
  private readonly _entries: BoardEntry[] = [];
  private readonly inFlightBranches = new Map<string, Promise<string>>();

  record(entry: Omit<BoardEntry, 'id'>): BoardEntry {
    const dedupKey = `${entry.kind}|${entry.scope}|${entry.key}`;
    const idx = this._entries.findIndex((e) => `${e.kind}|${e.scope}|${e.key}` === dedupKey);
    if (idx >= 0) {
      const existing = this._entries[idx]!;
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

  render(maxTokens = 1200): string {
    if (this._entries.length === 0) return '（暂无已共享的研究结论）';
    const lines = this._entries.map(
      (e) => `- [#${e.id}][${e.kind}][${e.scope}] ${e.summary.replace(/\s+/g, ' ').trim()}`,
    );
    return truncateToTokens(lines.join('\n'), maxTokens, defaultEstimator).text;
  }

  async runAtomicBranch(key: string, fn: () => Promise<string>): Promise<{ result: string; reused: boolean }> {
    const normKey = key.trim().replace(/\s+/g, ' ').toLowerCase();
    const existing = this._entries.find((e) => e.kind === 'branch' && e.key === normKey);
    if (existing) return { result: existing.summary, reused: true };
    const running = this.inFlightBranches.get(normKey);
    if (running) {
      const res = await running;
      return { result: res, reused: true };
    }
    const p = (async () => {
      return await fn();
    })();
    this.inFlightBranches.set(normKey, p);
    try {
      const result = await p;
      this.record({
        agent: 'branch',
        kind: 'branch',
        scope: 'task',
        key: normKey,
        summary: result,
      });
      return { result, reused: false };
    } finally {
      this.inFlightBranches.delete(normKey);
    }
  }
}
