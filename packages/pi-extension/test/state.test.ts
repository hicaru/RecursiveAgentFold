import { describe, expect, it } from 'vitest';
import { ResearchBoard } from '@raf/engine';
import {
  asPersistedState,
  contentText,
  ENTRY_STATE,
  messageText,
  renderTranscript,
  seedPriorTurns,
  SessionState,
} from '../src/state.js';

function user(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: 1 };
}
function assistant(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-completions',
    provider: 'p',
    model: 'm',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop' as const,
    timestamp: 2,
  };
}
function toolResult(text: string) {
  return { role: 'toolResult' as const, toolCallId: 'c', toolName: 'bash', content: [{ type: 'text' as const, text }], isError: false, timestamp: 3 };
}

describe('state', () => {
  it('reads text from content blocks and message objects', () => {
    expect(contentText('plain')).toBe('plain');
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image', data: '', mimeType: 'image/png' }])).toBe('a\n[image]');
    expect(messageText(user('hi'))).toBe('hi');
    expect(messageText(null)).toBe('');
  });

  it('renders a transcript with role labels', () => {
    const text = renderTranscript([user('q'), assistant('a'), toolResult('out')]);
    expect(text).toContain('## User\nq');
    expect(text).toContain('## Assistant\na');
    expect(text).toContain('## Tool result\nout');
  });

  it('seeds prior turns into a root fold state', () => {
    const seeded = seedPriorTurns([user('first'), assistant('answer one'), user('second'), assistant('answer two')]);
    expect(seeded?.initialQuestion).toBe('first');
    expect(seeded?.rootState.blocks).toHaveLength(2);
    expect(seeded?.rootState.blocks[0]?.summary).toContain('answer one');
    expect(seeded?.rootState.latest).toBeUndefined();
    expect(seedPriorTurns([user('only')])).toBeUndefined();
  });

  it('round-trips persisted state through snapshot and restore', () => {
    const first = new SessionState();
    first.rootState = { blocks: [{ from: 0, to: 0, summary: 's0' }] };
    first.initialQuestion = 'q';
    first.board.record({ agent: 'root', kind: 'tool', scope: 'doc', key: 'k', summary: 'found' });
    first.docs.set('branch_report_x', { title: 'report', text: 'body', persist: true });
    first.docs.set('packages/a', { title: 'a', text: 'code', persist: false });
    first.initialManifest = 'huge manifest that must stay out of jsonl';
    first.docSeq = 7;
    const saved = first.snapshot('done');
    expect(saved.initialManifest).toBeUndefined();
    expect(saved.docSeq).toBe(7);

    const second = new SessionState();
    second.restore(asPersistedState(saved));
    expect(second.rootState?.blocks[0]?.summary).toBe('s0');
    expect(second.initialQuestion).toBe('q');
    expect(second.board.entries()).toHaveLength(1);
    expect(second.docs.has('branch_report_x')).toBe(true);
    expect(second.docs.has('packages/a')).toBe(false);
    expect(second.workspaceIngested).toBe(false);
    expect(second.initialManifest).toBeUndefined();
    expect(second.initialDocIds).toBeUndefined();
    expect(second.docSeq).toBe(7);

    const withoutReports = new SessionState();
    withoutReports.restore(asPersistedState({ version: 1, status: 'aborted' }));
    expect(withoutReports.rootState).toBeUndefined();
    expect(withoutReports.board.entries()).toHaveLength(0);
  });

  it('keeps branch reports ahead of other docs under the size cap', () => {
    const state = new SessionState();
    state.docs.set('zzz_tool_read', { title: 'big', text: 'x'.repeat(600_000), persist: true });
    state.docs.set('branch_report_1', { title: 'report', text: 'r'.repeat(600_000), persist: true });
    const saved = state.snapshot('done');
    const ids = Object.keys(saved.docs ?? {});
    expect(ids[0]).toBe('branch_report_1');
    expect(ids).toHaveLength(1);
  });

  it('restores a research board snapshot', () => {
    const board = new ResearchBoard();
    board.record({ agent: 'root', kind: 'tally', scope: 'all', key: 'p', summary: 'n=3' });
    const state = new SessionState();
    state.restore(asPersistedState({ version: 1, status: 'done', board: board.snapshot() }));
    expect(state.board.entries()[0]?.summary).toBe('n=3');
  });

  it('rejects unknown entry data', () => {
    expect(asPersistedState(undefined)).toBeUndefined();
    expect(asPersistedState({ version: 2, status: 'done' })).toBeUndefined();
    expect(asPersistedState({ version: 1, status: 'nonsense' })).toBeUndefined();
  });

  it('exports stable entry type names', () => {
    expect(ENTRY_STATE).toBe('raf-state');
  });
});
