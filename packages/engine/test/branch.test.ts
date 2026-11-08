import { describe, expect, it } from 'vitest';
import { ResearchBoard } from '../src/context/board.js';
import { ContextStore } from '../src/context/store.js';
import { UsageTracker } from '../src/llm/usage.js';
import { BRANCH_REPORT_ID_PREFIX, createBranchTool, type BranchRunner, type BranchRunnerResult } from '../src/tools/branch.js';
import type { ToolContext } from '../src/tools/types.js';

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

describe('branch all-or-nothing results', () => {
  it('returns every subtask when all children answer', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async (task) => answer(`ok:${task}`);
    const tool = createBranchTool(run);
    const text = await tool.execute(
      {
        tasks: [
          { scope: 'alpha', task: 'inspect alpha' },
          { scope: 'beta', task: 'inspect beta' },
        ],
      },
      contextFor(store),
    );
    expect(text).toContain('[Subtask #1]');
    expect(text).toContain('[Subtask #2]');
    expect(text).toContain('ok:inspect alpha');
    expect(text).toContain('ok:inspect beta');
    expect(text).toContain('branch done: answer');
  });

  it('fails the whole call when one parallel child fails', async () => {
    const store = new ContextStore();
    const run: BranchRunner = async (task) => (task.includes('bad') ? failure('transport down') : answer('ok'));
    const tool = createBranchTool(run);
    await expect(
      tool.execute(
        {
          tasks: [
            { scope: 'alpha', task: 'inspect alpha' },
            { scope: 'beta', task: 'bad beta' },
          ],
        },
        contextFor(store),
      ),
    ).rejects.toThrow(/branch aborted: 1 of 2 subtasks failed.*beta: transport down/);
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
    await expect(tool.execute({ scope: 'alpha', task: 'inspect alpha' }, contextFor(store, board))).rejects.toThrow(
      /branch aborted/,
    );
    const text = await tool.execute({ scope: 'alpha', task: 'inspect alpha' }, contextFor(store, board));
    expect(text).toContain('recovered');
    expect(calls).toBe(2);
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
});
