/**
 * AgentFold context state (paper §3.2–3.3).
 *
 *   C_t = (Q, T, S_{t-2}, I_{t-1})
 *   S   = (s_{x1,y1}, ..., s_{xm,ym})  contiguous, gap-free partition of steps 0..t-2
 *   I   = (explanation, action, observation) of step t-1  (full fidelity)
 *
 * At step t the model emits a folding directive {"range": [k, t-1], "summary": σ}
 * which retracts every block inside [k, t-1] (including the latest interaction)
 * and replaces them with a single block s_{k,t-1} = σ.
 *   k == t-1  → granular condensation (append a fine-grained block)
 *   k <  t-1  → deep consolidation (merge a chain of blocks + latest)
 *
 * Steps are 0-based, matching the paper's case studies ("[Compressed Step 0]").
 */

export interface SummaryBlock {
  from: number;
  to: number;
  summary: string;
}

export interface ToolAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Interaction {
  step: number;
  /** The paper's "explanation" e_t (tagged <motivation> in the case studies). */
  motivation: string;
  action: ToolAction;
  observation: string;
}

export interface FoldDirective {
  range: [number, number];
  summary: string;
}

export interface FoldOutcome {
  directive: FoldDirective;
  kind: 'granular' | 'deep';
  /** Number of pre-existing summary blocks retracted (deep consolidation). */
  retractedBlocks: number;
  /** Normalizations applied to a non-conforming directive. */
  corrections: string[];
  /** Index of the first block whose rendering changed (cache invalidation point). */
  firstChangedBlock: number;
}

export interface FoldStateSnapshot {
  blocks: SummaryBlock[];
  latest?: Interaction;
}

export class FoldState {
  private _blocks: SummaryBlock[] = [];
  private _latest: Interaction | undefined;

  get blocks(): readonly SummaryBlock[] {
    return this._blocks;
  }

  get latest(): Interaction | undefined {
    return this._latest;
  }

  /** The step index the next model response belongs to. */
  get currentStep(): number {
    if (this._latest) return this._latest.step + 1;
    const last = this._blocks[this._blocks.length - 1];
    return last ? last.to + 1 : 0;
  }

  /**
   * Apply a folding directive. The range end is forced to the latest step and
   * the start is snapped down to a block boundary (summaries are atomic).
   */
  applyFold(directive: FoldDirective): FoldOutcome {
    const latest = this._latest;
    if (!latest) throw new Error('applyFold: there is no latest interaction to fold');
    const t1 = latest.step;
    const corrections: string[] = [];
    let [k, end] = directive.range;
    if (!Number.isFinite(k)) {
      corrections.push(`range start ${k} is not a number → ${t1}`);
      k = t1;
    }
    k = Math.floor(k);
    if (end !== t1) corrections.push(`range end ${end} → ${t1} (must be the latest step)`);
    if (k > t1) {
      corrections.push(`range start ${k} > latest step → ${t1}`);
      k = t1;
    }
    if (k < 0) {
      corrections.push(`range start ${k} < 0 → 0`);
      k = 0;
    }
    // Snap k down to the start of the block that contains it.
    const containing = this._blocks.find((b) => b.from <= k && k <= b.to);
    if (containing && containing.from !== k) {
      corrections.push(`range start ${k} is inside block [${containing.from}, ${containing.to}] → ${containing.from}`);
      k = containing.from;
    }
    const keep = this._blocks.filter((b) => b.to < k);
    const retracted = this._blocks.length - keep.length;
    const summary = directive.summary.trim() || fallbackSummary(latest);
    if (!directive.summary.trim()) corrections.push('empty summary → auto summary');
    this._blocks = [...keep, { from: k, to: t1, summary }];
    this._latest = undefined;
    return {
      directive: { range: [k, t1], summary },
      kind: k === t1 ? 'granular' : 'deep',
      retractedBlocks: retracted,
      corrections,
      firstChangedBlock: keep.length,
    };
  }

  /**
   * Merge a contiguous prefix of summary blocks without touching the latest
   * interaction. Hosts use this under a prompt budget; partition stays gap-free.
   */
  condensePrefix(blockCount: number, summary: string): SummaryBlock | undefined {
    const count = Math.max(0, Math.min(this._blocks.length, Math.floor(blockCount)));
    if (count < 2) return undefined;
    const prefix = this._blocks.slice(0, count);
    const first = prefix[0];
    const last = prefix[count - 1];
    if (first === undefined || last === undefined) return undefined;
    const merged: SummaryBlock = {
      from: first.from,
      to: last.to,
      summary: summary.trim() || prefix.map((b) => b.summary).join('\n'),
    };
    this._blocks = [merged, ...this._blocks.slice(count)];
    return merged;
  }

  /** Shorten the latest observation in place. Used only under a prompt budget. */
  trimLatestObservation(maxChars: number): boolean {
    const latest = this._latest;
    if (!latest || latest.observation.length <= maxChars) return false;
    latest.observation = `${latest.observation.slice(0, Math.max(0, maxChars))}\n…[observation shortened by prompt budget]`;
    return true;
  }

  setLatest(interaction: Interaction): void {
    if (this._latest) throw new Error('setLatest: previous interaction has not been folded');
    const expected = this.currentStep;
    if (interaction.step !== expected) throw new Error(`setLatest: expected step ${expected}, got ${interaction.step}`);
    this._latest = interaction;
  }

  snapshot(): FoldStateSnapshot {
    return { blocks: this._blocks.map((b) => ({ ...b })), latest: this._latest ? { ...this._latest } : undefined };
  }

  static restore(s: FoldStateSnapshot): FoldState {
    const st = new FoldState();
    st._blocks = s.blocks.map((b) => ({ ...b }));
    st._latest = s.latest ? { ...s.latest } : undefined;
    return st;
  }
}

/** Used when the model omits/garbles its folding directive. */
export function fallbackSummary(i: Interaction, maxObsChars = 600): string {
  const obs = i.observation.replace(/\s+/g, ' ').trim();
  return (
    `${i.motivation ? `${i.motivation.trim()} ` : ''}Called ${i.action.name}(${JSON.stringify(i.action.arguments)}). ` +
    `Result (truncated): ${obs.length > maxObsChars ? `${obs.slice(0, maxObsChars)}…` : obs}`
  );
}
