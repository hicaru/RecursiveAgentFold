import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '@raf/engine/source';
import { cacheRate, mergeTotals, emptyTotals, RunTracker } from '../src/tracker.js';

function applyAll(tracker: RunTracker, events: readonly AgentEvent[]): void {
  for (const event of events) tracker.apply(event);
}

/** A full root turn plus one branch specialist inside one root tool call. */
function scenario(): AgentEvent[] {
  return [
    { type: 'run_start', agent: 'root', depth: 0, question: 'Study the repo.' },
    { type: 'step_start', agent: 'root', depth: 0, step: 0, contextTokens: 4200, blocks: 0 },
    { type: 'llm_call', agent: 'root', step: 0, role: 'root', model: 'glm-5.3', usage: { promptTokens: 4000, completionTokens: 120, cachedTokens: 3200 }, latencyMs: 900 },
    { type: 'tool_call', agent: 'root', step: 0, action: { name: 'branch', arguments: { tasks: [{ scope: 'packages/engine', task: 'study' }] } }, motivation: 'delegate' },
    { type: 'run_start', agent: 'specialist#1@1', depth: 1, parent: 'root', scope: 'packages/engine', question: 'study engine' },
    { type: 'step_start', agent: 'specialist#1@1', depth: 1, step: 0, contextTokens: 900, blocks: 0 },
    {
      type: 'llm_call',
      agent: 'specialist#1@1',
      step: 0,
      role: 'branch',
      model: 'glm-5.3-flash',
      usage: { promptTokens: 800, completionTokens: 60, cachedTokens: 100 },
      latencyMs: 300,
    },
    { type: 'fold', agent: 'specialist#1@1', step: 0, outcome: { directive: { range: [0, 0], summary: 'read files' }, kind: 'granular', retractedBlocks: 0, corrections: [], firstChangedBlock: 0 } },
    { type: 'tool_result', agent: 'specialist#1@1', step: 0, name: 'read', observation: 'doc lines 1-40', tokens: 40 },
    { type: 'run_end', agent: 'specialist#1@1', depth: 1, steps: 1, terminated: 'answer' },
    { type: 'branch_report', agent: 'root', step: 0, scope: 'packages/engine', reportId: 'branch_report_x', tokens: 500, lines: 30 },
    { type: 'tool_result', agent: 'root', step: 0, name: 'branch', observation: '[Subtask #1] ok', tokens: 60 },
    { type: 'step_start', agent: 'root', depth: 0, step: 1, contextTokens: 5000, blocks: 1 },
    { type: 'llm_query', agent: 'root', step: 1, query: 'count entities', mode: 'extract', chunks: 6, relevant: 4, errors: 0, memoHits: 2, chunkTokens: 8192, calls: 4, usage: { promptTokens: 20_000, completionTokens: 200, cachedTokens: 1000 } },
    { type: 'format_error', agent: 'root', step: 1, errors: ['missing answer tag'], attempt: 0, raw: 'oops' },
    {
      type: 'fold',
      agent: 'root',
      step: 1,
      outcome: { directive: { range: [0, 1], summary: 'merged' }, kind: 'deep', retractedBlocks: 2, corrections: [], firstChangedBlock: 0 },
      requested: { range: [0, 1], summary: 'merged' },
    },
    { type: 'answer', agent: 'root', step: 1, answer: 'The repo has 3 packages.' },
    { type: 'run_end', agent: 'root', depth: 0, steps: 2, terminated: 'answer' },
  ];
}

describe('RunTracker', () => {
  it('folds a full scenario into an ordered agent tree with totals', () => {
    const tracker = new RunTracker();
    tracker.startRun();
    applyAll(tracker, scenario());
    const tree = tracker.agentTree();
    expect(tree.map((agent) => agent.name)).toEqual(['root', 'specialist#1@1']);
    expect(tree[0]?.steps).toBe(2);
    expect(tree[0]?.folds).toBe(1);
    expect(tree[0]?.deepFolds).toBe(1);
    expect(tree[0]?.status).toBe('done');
    expect(tree[1]?.parent).toBe('root');
    expect(tree[1]?.scope).toBe('packages/engine');

    const run = tracker.runTotals();
    expect(run.steps).toBe(2);
    expect(run.agents).toBe(2);
    expect(run.folds).toBe(2);
    expect(run.deepFolds).toBe(1);
    expect(run.formatErrors).toBe(1);
    expect(run.reports).toBe(1);
    expect(run.queries).toBe(1);
    expect(run.queryChunks).toBe(6);
    expect(run.roles.root).toEqual({ calls: 1, promptTokens: 4000, cachedTokens: 3200, completionTokens: 120, costUsd: 0 });
    expect(run.roles.branch.calls).toBe(1);
    expect(run.roles.llm_query.promptTokens).toBe(20_000);
  });

  it('attributes sub-agents to the root tool call that started them', () => {
    const tracker = new RunTracker();
    tracker.startRun();
    tracker.apply({ type: 'run_start', agent: 'root', depth: 0, question: 'q' });
    tracker.beginCall('call-1', 'branch');
    const events = scenario().slice(2, 12);
    applyAll(tracker, events);
    tracker.endCall('call-1');
    const call = tracker.callSnapshot('call-1');
    expect(call?.tool).toBe('branch');
    expect(call?.agents.map((agent) => agent.name)).toEqual(['specialist#1@1']);
    expect(call?.startedAt).toBeGreaterThan(0);
  });

  it('counts live reader chunk calls', () => {
    const tracker = new RunTracker();
    tracker.startRun();
    tracker.beginCall('c', 'llm_query');
    tracker.readerStarted();
    tracker.readerStarted();
    tracker.readerEnded();
    expect(tracker.callSnapshot('c')).toMatchObject({ readerDone: 1, readerActive: 1 });
  });

  it('merges finished runs into session totals', () => {
    const tracker = new RunTracker();
    tracker.startRun();
    applyAll(tracker, scenario());
    tracker.endRun();
    tracker.startRun();
    tracker.apply({ type: 'step_start', agent: 'root', depth: 0, step: 0, contextTokens: 10, blocks: 0 });
    const session = tracker.sessionTotals();
    expect(session.steps).toBe(3);
    expect(session.agents).toBe(2);
    expect(cacheRate([session.roles.root])).toBeCloseTo(3200 / 4000);
    expect(cacheRate([session.roles.branch])).toBeCloseTo(100 / 800);
  });

  it('computes undefined cache rate without prompt tokens', () => {
    expect(cacheRate([emptyTotals().roles.root])).toBeUndefined();
  });

  it('mergeTotals adds every counter', () => {
    const a = emptyTotals();
    const one = emptyTotals();
    one.steps = 1;
    one.folds = 2;
    one.deepFolds = 3;
    one.formatErrors = 4;
    one.budgetCondensations = 5;
    one.reports = 6;
    one.queries = 7;
    one.queryChunks = 8;
    one.agents = 9;
    one.errors = 10;
    one.roles.root.calls = 11;
    one.roles.branch.promptTokens = 12;
    one.roles.llm_query.costUsd = 0.5;
    mergeTotals(a, one);
    expect(a).toEqual(one);
  });

  it('tracks the provider rate-limit window', () => {
    const tracker = new RunTracker();
    expect(tracker.rateLimitRemaining()).toBe(0);
    tracker.setRateLimit(Date.now() + 5000);
    expect(tracker.rateLimitRemaining()).toBeGreaterThan(4000);
    expect(tracker.rateLimitRemaining(Date.now() + 10_000)).toBe(0);
  });
});
