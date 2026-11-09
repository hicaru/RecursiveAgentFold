import { describe, expect, it } from 'vitest';
import { ResearchBoard } from '../src/context/board.js';
import { ContextStore } from '../src/context/store.js';
import { UsageTracker } from '../src/llm/usage.js';
import { BRANCH_REPORT_ID_PREFIX, createBranchTool, type BranchRunner, type BranchRunnerResult } from '../src/tools/branch.js';
import type { ToolContext } from '../src/tools/types.js';
import { defaultEstimator } from '../src/tokens.js';

function contextFor(store: ContextStore, board?: ResearchBoard): ToolContext {
  return {
    store,
    usage: new UsageTracker(),
    depth: 0,
    agentName: 'root',
    step: 0,
    emit: () => {},
    ...(board !== undefined ? { board } : {}),
  };
}

function answer(text: string): BranchRunnerResult {
  return { answer: text, steps: 1, terminated: 'answer' };
}

function failure(reason: string): BranchRunnerResult {
  return { answer: null, steps: 2, terminated: 'error', error: reason };
}

describe('branch parallel results', () => {
  it('returns every subtask when all children answer', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async (task) => answer(`ok:${task}`);
    const tool = createBranchTool(run);
    const text = await tool.execute(
      {
        tasks: [
          { scope: 'alpha', task: 'alpha' },
          { scope: 'beta', task: 'beta' },
        ],
      },
      contextFor(store),
    );
    expect(text).toContain('[Subtask #1]');
    expect(text).toContain('[Subtask #2]');
    expect(text).toContain('ok:alpha');
    expect(text).toContain('ok:beta');
    expect(text).toContain('branch done: answer');
  });

  it('returns successful reports plus an explicit failure list', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async (task) => (task.includes('bad') ? failure('transport down') : answer('ok'));
    const tool = createBranchTool(run);
    const text = await tool.execute(
      {
        tasks: [
          { scope: 'alpha', task: 'alpha' },
          { scope: 'beta', task: 'bad beta' },
        ],
      },
      contextFor(store),
    );
    expect(text).toContain('[Subtask #1]');
    expect(text).toContain('[Subtask #2]');
    expect(text).toContain('ok');
    expect(text).toContain('FAILED: transport down');
  });

  it('returns an explicit failure index when every parallel child fails', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async () => failure('transport down');
    const tool = createBranchTool(run);
    const text = await tool.execute(
      {
        tasks: [
          { scope: 'alpha', task: 'alpha' },
          { scope: 'beta', task: 'beta' },
        ],
      },
      contextFor(store),
    );
    expect(text).toContain('[Subtask #1]');
    expect(text).toContain('[Subtask #2]');
    expect(text).toContain('FAILED: transport down');
  });

  it('keeps all 200 headers in a compact index', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async (task) => answer('ok:' + task);
    const tool = createBranchTool(run);
    const tasks = Array.from({ length: 200 }, (_, index) => ({
      scope: `scope_${index + 1}`,
      task: `audit scope ${index + 1}`,
    }));
    const text = await tool.execute({ tasks }, contextFor(store));
    expect(text).toContain('[Subtask #200]');
    expect(text).toContain('branch_report_');
    expect(defaultEstimator.count(text)).toBeLessThanOrEqual(6_000);
  });

  it('rejects a fan-out larger than maxSpecialists before running children', async () => {
    const store = new ContextStore();
    let calls = 0;
    const run: BranchRunner = async (task) => {
      calls += 1;
      return answer(`ok:${task}`);
    };
    const tool = createBranchTool(run, { maxSpecialists: 2 });
    await expect(
      tool.execute(
        {
          tasks: [
            { scope: 'alpha', task: 'inspect alpha' },
            { scope: 'beta', task: 'inspect beta' },
            { scope: 'gamma', task: 'inspect gamma' },
          ],
        },
        contextFor(store),
      ),
    ).rejects.toThrow(/too many branch tasks: 3 \(max 2\)/);
    expect(calls).toBe(0);
  });

  it('fails a single-child call when the child ends without an answer', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async () => ({ answer: null, steps: 3, terminated: 'max_steps' });
    const tool = createBranchTool(run);
    await expect(tool.execute({ scope: 'alpha', task: 'inspect alpha' }, contextFor(store))).rejects.toThrow(
      /branch aborted: alpha: terminated: max_steps/,
    );
  });

  it('does not cache a failed specialist run in the research board', async () => {
    const store = new ContextStore();
    const board = new ResearchBoard();
    let calls = 0;
    const run: BranchRunner = async () => {
      calls += 1;
      return calls === 1 ? failure('transport down') : answer('recovered');
    };
    const tool = createBranchTool(run);
    await expect(tool.execute({ scope: 'alpha', task: 'alpha' }, contextFor(store, board))).rejects.toThrow(
      /branch aborted/,
    );
    expect(board.entries()).toHaveLength(0);
    const text = await tool.execute({ scope: 'alpha', task: 'alpha' }, contextFor(store, board));
    expect(text).toContain('recovered');
    expect(calls).toBe(2);
  });
});

describe('branch answer quality', () => {
  it('rejects an obvious placeholder answer', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async () => answer('placeholder - final answer');
    const tool = createBranchTool(run);
    await expect(tool.execute({ scope: 'alpha', task: 'alpha' }, contextFor(store))).rejects.toThrow(
      /placeholder or too short/,
    );
  });

  it('rejects a short report for a research task', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async () => answer('ok');
    const tool = createBranchTool(run);
    await expect(
      tool.execute({ scope: 'alpha', task: 'deeply study alpha and list every exported symbol' }, contextFor(store)),
    ).rejects.toThrow(/placeholder or too short/);
  });
});

describe('branch full reports', () => {
  it('keeps every subtask header and stores full reports out of the manifest', async () => {
    const store = new ContextStore();
    const long = 'y'.repeat(3000);
    const run: BranchRunner = async (task) => answer(`report:${task}:${long}`);
    const tool = createBranchTool(run, { maxResultTokens: 1200 });
    const tasks = Array.from({ length: 5 }, (_, index) => ({
      scope: `scope_${index + 1}`,
      task: `inspect scope ${index + 1}`,
    }));
    const text = await tool.execute({ tasks }, contextFor(store));
    for (let index = 1; index <= 5; index += 1) {
      expect(text).toContain(`[Subtask #${index}]`);
      expect(text).toContain(`[scope=scope_${index}]`);
    }
    expect(text).toContain('Full report:');
    const reports = store.list().filter((doc) => doc.id.startsWith(BRANCH_REPORT_ID_PREFIX));
    expect(reports).toHaveLength(5);
    for (const report of reports) {
      expect(report.manifest).toBe(false);
      expect(report.chars).toBeGreaterThan(3000);
      expect(report.lines.join('\n')).toContain('report:');
    }
  });

  it('commits each branch_report_* immediately on completion, lists all 4 tasks, and preserves settled summaries on failed follow-ups', async () => {
    const store = new ContextStore();
    const board = new ResearchBoard();
    const emittedEvents: Array<Record<string, unknown>> = [];
    let reportsMidFlight = 0;
    let releasePq: (() => void) | undefined;
    const siblingsDone = new Promise<void>((resolve) => {
      releasePq = resolve;
    });
    const run: BranchRunner = async (task, opts) => {
      if (opts.scope === 'crates/session' && opts.followUpQuestion) {
        return failure('follow-up step timeout');
      }
      if (opts.scope === 'crates/pq') {
        await siblingsDone;
        reportsMidFlight = store.list().filter((d) => d.id.startsWith(BRANCH_REPORT_ID_PREFIX)).length;
        return failure('provider 429 error');
      }
      return answer(`Completed audit for ${opts.scope ?? task}: all invariants verified.`);
    };
    const tool = createBranchTool(run);
    const ctx: ToolContext = {
      ...contextFor(store, board),
      emit: (e) => {
        emittedEvents.push(e as unknown as Record<string, unknown>);
        if (emittedEvents.filter((ev) => ev.type === 'branch_report').length === 3) {
          releasePq?.();
        }
      },
    };
    const index = await tool.execute(
      {
        tasks: [
          { scope: 'crates/aead', task: 'Audit aead' },
          { scope: 'crates/kdf', task: 'Audit kdf' },
          { scope: 'crates/session', task: 'Audit session' },
          { scope: 'crates/pq', task: 'Audit pq' },
        ],
      },
      ctx,
    );
    // All 3 succeeded tasks were already committed to ContextStore before crates/pq finished
    expect(reportsMidFlight).toBe(3);
    const reportEvents = emittedEvents.filter((e) => e.type === 'branch_report');
    expect(reportEvents).toHaveLength(3);
    for (let i = 1; i <= 4; i++) {
      expect(index).toContain(`[Subtask #${i}]`);
    }
    expect(index).toContain('FAILED: provider 429 error');
    // Failed initial scope crates/pq was rolled back from specialists & board
    expect(board.hasSpecialist('crates/pq')).toBe(false);
    expect(board.entries().some((e) => e.scope === 'crates/pq')).toBe(false);
    expect(board.getSpecialist('crates/session')?.latestSummary).toContain('Completed audit for crates/session');

    // Follow-up on crates/session that fails preserves the original settled summary
    const followUpOut = await tool.execute(
      { scope: 'crates/session', task: 'Follow-up on crates/session' },
      ctx,
    );
    expect(followUpOut).toContain('preserved prior specialist report');
    expect(followUpOut).toContain('Completed audit for crates/session');
    expect(board.getSpecialist('crates/session')?.latestSummary).toContain('Completed audit for crates/session');
    expect(board.entries().find((e) => e.scope === 'crates/session')?.summary).toContain('Completed audit for crates/session');
  });
});
