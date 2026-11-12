import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setAnydocForTest } from '../src/context/anydoc.js';
import { extractPromptPaths } from '../src/context/ingest.js';
import { ContextStore } from '../src/context/store.js';
import { isAncestorEcho, ResearchBoard } from '../src/context/board.js';
import { ScriptedLLM } from '../src/llm/mock.js';
import { RecursiveAgentFold } from '../src/runtime.js';
import { computeChunkTokens, formatMarginNote, LLMQueryEngine } from '../src/tools/llm-query.js';
import { UsageTracker } from '../src/llm/usage.js';
import { defaultEstimator } from '../src/tokens.js';
import type { AgentEvent } from '../src/agent/events.js';
import type { ChatMessage, LLMClient } from '../src/types.js';
import { AgentFoldAgent, extractFallbackAnswer } from '../src/agent/agent-fold.js';
import { FoldState } from '../src/fold/state.js';
import {
  createAddDocumentTool,
  createGrepTool,
  createListDocumentsTool,
  createOutlineTool,
  createReadTool,
  createSearchTool,
  createTallyTool,
} from '../src/tools/document-tools.js';
function haystack(lines: number, needleAt: number): string {
  const out: string[] = [];
  for (let i = 1; i <= lines; i++) {
    out.push(i === needleAt ? 'The vault passcode for project Orion is 7341.' : `Filler line ${i}: the quick brown fox jumps over the lazy dog again and again.`);
  }
  return out.join('\n');
}

/** Query model: "reads" the chunk and reports lines containing "passcode". */
function scriptedReader() {
  return new ScriptedLLM(
    (req) => {
      const chunk = req.messages[1]!.content;
      const hit = chunk.split('\n').find((l) => /passcode/.test(l));
      if (!hit) return '{"relevant": false, "answer": "", "evidence": []}';
      const line = Number(hit.split('|')[0]);
      return JSON.stringify({ relevant: true, answer: 'passcode statement found', evidence: [{ line, quote: hit.split('| ')[1] }] });
    },
    { name: 'reader', contextWindow: 32_000, maxOutputTokens: 512 },
  );
}

/** Evaluate dsh-plugin client.js in a minimal window sandbox and return its buildRunModel hook. */
async function loadClientBuildRunModel() {
  type BuiltModel = {
    agents: Array<{
      id: string;
      name: string;
      depth: number;
      parentId: string | null;
      scope: string | null;
      childAgentIds: string[];
      steps: Array<{ index: number; tools: Array<{ name: string; childAgentIds: string[] }> }>;
    }>;
  };
  const fakeWindow: {
    __ModuleLoader__: { load: (spec: { factory: (req: (id: string) => unknown) => void }) => void };
    localStorage: { getItem: () => null; setItem: () => void };
    __RAF_BUILD_RUN_MODEL__?: ((run: unknown) => BuiltModel) & { runHasBranch?: (run: unknown, args: unknown) => boolean };
    __RAF_RUN_HAS_BRANCH__?: (run: unknown, args: unknown) => boolean;
  } = {
    __ModuleLoader__: {
      load(spec) {
        spec.factory(() => ({
          createElement: () => null,
          Fragment: 'Fragment',
          useState: (init: unknown) => [typeof init === 'function' ? init() : init, () => {}],
          useEffect: () => {},
          useRef: (init: unknown) => ({ current: init }),
          useMemo: (fn: () => unknown) => fn(),
          useSyncExternalStore: () => ({}),
        }));
      },
    },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  const clientJsPath = new URL('../../dsh-plugin/client.js', import.meta.url);
  const clientCode = await readFile(clientJsPath, 'utf-8');
  new Function('window', clientCode)(fakeWindow);
  const buildRunModel = fakeWindow.__RAF_BUILD_RUN_MODEL__;
  if (typeof buildRunModel !== 'function') throw new Error('missing buildRunModel');
  buildRunModel.runHasBranch = fakeWindow.__RAF_RUN_HAS_BRANCH__;
  return buildRunModel;
}

describe('chunking', () => {
  it('chunk = window * (1 - reserve), deterministic and line aligned', () => {
    expect(computeChunkTokens({ name: 'm', contextWindow: 128_000, maxOutputTokens: 1024 }, { lineNumbers: false })).toBe(89_600);
    expect(computeChunkTokens({ name: 'm', contextWindow: 128_000, maxOutputTokens: 1024 }, { lineNumbers: false, reserveRatio: 0.5 })).toBe(64_000);
    const store = new ContextStore();
    store.add(haystack(5000, 10), { id: 'h' });
    const a = store.chunks('h', 8000);
    const b = store.chunks('h', 8000);
    expect(a).toBe(b);
    expect(a[0]!.startLine).toBe(1);
    for (let i = 1; i < a.length; i++) expect(a[i]!.startLine).toBe(a[i - 1]!.endLine + 1);
    expect(a[a.length - 1]!.endLine).toBe(5000);
    expect(a.every((c) => c.tokens <= 8000)).toBe(true);
  });
});

describe('LLMQueryEngine cache behaviour', () => {
  it('memoizes repeated queries and reuses the chunk prefix for new queries', async () => {
    const store = new ContextStore();
    store.add(haystack(20_000, 15_123), { id: 'big' });
    const reader = scriptedReader();
    const usage = new UsageTracker();
    const engine = new LLMQueryEngine(reader, store, usage, { concurrency: 2 });
    const r1 = await engine.query({ query: 'Where is the passcode?' });
    const n = r1.findings.length;
    expect(n).toBeGreaterThan(1);
    expect(r1.findings.filter((f) => f.relevant).map((f) => f.evidence[0]?.line)).toEqual([15_123]);
    expect(r1.report).toContain('L15123');
    // identical query → memo, no new calls
    await engine.query({ query: 'Where is the passcode?' });
    expect(reader.calls.length).toBe(n);
    // new query over the same chunks → prompt prefix (system + chunk) is cached
    await engine.query({ query: 'Is project Orion mentioned?' });
    const u = usage.byRole().llm_query!;
    expect(u.calls).toBe(2 * n);
    const secondPassCacheRate = u.cachedTokens / (u.promptTokens / 2);
    expect(secondPassCacheRate).toBeGreaterThan(0.9);
  });
});

describe('RecursiveAgentFold end-to-end (scripted)', () => {
  it('root locates with llm_query, reads, folds, answers; branch works', async () => {
    const store = new ContextStore();
    store.add(haystack(30_000, 21_007), { id: 'ctx', title: 'haystack' });
    const reader = scriptedReader();
    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]!.content;
      const step = Number(/Step (\d+)\./.exec(user)![1]);
      switch (step) {
        case 0:
          return '<motivation>Locate first.</motivation><tool_call>{"name":"llm_query","arguments":{"query":"Find the vault passcode for project Orion","mode":"locate"}}</tool_call>';
        case 1: {
          const line = /L(\d+) "The vault/.exec(user)![1];
          return `<folding>{"range":[0,0],"summary":"llm_query located passcode at ctx L${line}."}</folding><motivation>Read it.</motivation><tool_call>{"name":"read","arguments":{"document":"ctx","start_line":${line},"end_line":${line}}}</tool_call>`;
        }
        case 2:
          return '<folding>{"range":[1,1],"summary":"Read line: passcode 7341."}</folding><motivation>Double-check via branch.</motivation><tool_call>{"name":"branch","arguments":{"task":"Confirm the passcode with grep"}}</tool_call>';
        default:
          return '<folding>{"range":[0,3],"summary":"Passcode confirmed 7341."}</folding><answer>7341</answer>';
      }
    }, { name: 'root', contextWindow: 64_000 });
    const branch = new ScriptedLLM((req) => {
      const user = req.messages[1]!.content;
      return /Step 0\./.test(user)
        ? '<motivation>grep</motivation><tool_call>{"name":"grep","arguments":{"pattern":"passcode"}}</tool_call>'
        : '<folding>{"range":[0,0],"summary":"grep found 1 line"}</folding><answer>7341 (ctx:21007)</answer>';
    });
    const events: AgentEvent[] = [];
    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, queryLLM: reader, store, onEvent: (e) => events.push(e) });
    const res = await raf.run('What is the vault passcode for project Orion?');
    expect(res.answer).toBe('7341');
    expect(res.terminated).toBe('answer');
    // Root defers deep folds to granular [2, 2] to preserve append-only prefix cache across turns
    expect(res.state.blocks).toEqual([
      { from: 0, to: 0, summary: 'llm_query located passcode at ctx L21007.' },
      { from: 1, to: 1, summary: 'Read line: passcode 7341.' },
      { from: 2, to: 2, summary: 'Passcode confirmed 7341.' },
    ]);
    const folds = events.filter((e) => e.type === 'fold' && e.agent === 'root');
    expect(folds.map((f) => (f.type === 'fold' ? f.outcome.kind : ''))).toEqual(['granular', 'granular', 'granular']);
    const toolResults = events.filter((e) => e.type === 'tool_result');
    expect(toolResults.some((e) => e.type === 'tool_result' && e.name === 'branch' && e.observation.includes('7341 (ctx:21007)'))).toBe(true);
    // the big document never entered the root context
    for (const c of root.calls) expect(c.messages[1]!.content.length).toBeLessThan(20_000);
    // root prompts share the static system prefix → cached
    const usage = res.usage.byRole();
    expect(usage.root!.cachedTokens).toBeGreaterThan(0);
    expect(usage.llm_query!.calls).toBeGreaterThan(1);
    expect(usage.branch!.calls).toBe(2);
  });

  it('recovers from format errors and forces an answer at the step limit', async () => {
    const store = new ContextStore();
    store.add('alpha\nbeta', { id: 'd' });
    let n = 0;
    const root = new ScriptedLLM((req) => {
      n++;
      const user = req.messages[1]!.content;
      if (n === 1) return 'I forgot the format';
      if (/Step limit reached/.test(user)) return '<answer>beta</answer>';
      const step = Number(/Step (\d+)\./.exec(user)![1]);
      return step === 0
        ? '<motivation>x</motivation><tool_call>{"name":"grep","arguments":{"pattern":"beta"}}</tool_call>'
        : '<motivation>again</motivation><tool_call>{"name":"grep","arguments":{"pattern":"beta"}}</tool_call>'; // missing folding → auto fold
    });
    const raf = new RecursiveAgentFold({ rootLLM: root, store, rootMaxSteps: 2, maxDepth: 0 });
    const res = await raf.run('Which line mentions beta?');
    expect(res.answer).toBe('beta');
    expect(res.terminated).toBe('forced_answer');
    expect(res.formatIssues).toBeGreaterThanOrEqual(2);
  });
  it('places document manifest with sample preview before question and stabilizes history header across steps', () => {
    const store = new ContextStore();
    store.add(haystack(30, 5), { id: 'ctx', title: 'haystack' });
    const llm = new ScriptedLLM(() => '<answer>done</answer>');
    const agent = new AgentFoldAgent({ llm, tools: [], store });
    const state0 = new FoldState();
    const msgQ1Step0 = agent.buildMessages('Question A?', state0)[1]?.content ?? '';
    const msgQ2Step0 = agent.buildMessages('Question B?', state0)[1]?.content ?? '';
    const taskIdx1 = msgQ1Step0.indexOf('\n\n### Task\n');
    const taskIdx2 = msgQ2Step0.indexOf('\n\n### Task\n');
    expect(taskIdx1).toBeGreaterThan(0);
    expect(taskIdx1).toBe(taskIdx2);
    expect(msgQ1Step0.slice(0, taskIdx1)).toBe(msgQ2Step0.slice(0, taskIdx2));
    expect(msgQ1Step0.slice(0, taskIdx1)).toContain('Sample lines:');
    expect(msgQ1Step0.slice(0, taskIdx1)).toContain('1| Filler line 1:');
    expect(msgQ1Step0.slice(0, taskIdx1)).toContain('2| Filler line 2:');

    const state1 = new FoldState();
    state1.setLatest({
      step: 0,
      motivation: 'probe',
      action: { name: 'grep', arguments: { pattern: 'passcode' } },
      observation: 'found 1',
    });
    const msgQ1Step1 = agent.buildMessages('Question A?', state1)[1]?.content ?? '';
    const histHeader = '\n\n### Previous Steps\n';
    const histIdx0 = msgQ1Step0.indexOf(histHeader);
    const histIdx1 = msgQ1Step1.indexOf(histHeader);
    expect(histIdx0).toBeGreaterThan(0);
    expect(histIdx0).toBe(histIdx1);
    expect(msgQ1Step0.slice(0, histIdx0 + histHeader.length)).toBe(msgQ1Step1.slice(0, histIdx1 + histHeader.length));
  });

  it('defers premature mid-run deep folds to granular to preserve cache, while allowing final-turn or threshold-met deep folds', async () => {
    const store = new ContextStore();
    store.add(haystack(40, 10), { id: 'ctx', title: 'haystack' });
    const events: AgentEvent[] = [];
    const llm = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      switch (step) {
        case 0:
          return '<motivation>step 0</motivation><tool_call>{"name":"grep","arguments":{"pattern":"passcode","max_matches":5}}</tool_call>';
        case 1:
          return '<folding>{"range":[0,0],"summary":"s0"}</folding><motivation>step 1</motivation><tool_call>{"name":"read","arguments":{"document":"ctx","start_line":10,"end_line":10}}</tool_call>';
        case 2:
          // Mid-run deep fold across only 1 existing block (< minDeepFoldBlocks=3): should be deferred to granular [1,1]
          return '<folding>{"range":[0,1],"summary":"premature merge"}</folding><motivation>step 2</motivation><tool_call>{"name":"read","arguments":{"document":"ctx","start_line":10,"end_line":10}}</tool_call>';
        case 3:
          // Mid-run deep fold across 2 existing blocks (< minDeepFoldBlocks=3): should be deferred to granular [2,2]
          return '<folding>{"range":[0,2],"summary":"still premature"}</folding><motivation>step 3</motivation><tool_call>{"name":"read","arguments":{"document":"ctx","start_line":10,"end_line":10}}</tool_call>';
        case 4:
          // Mid-run deep fold across 3 existing blocks (>= minDeepFoldBlocks=3): should execute as deep [0,3]
          return '<folding>{"range":[0,3],"summary":"merged 0..3"}</folding><motivation>step 4</motivation><tool_call>{"name":"read","arguments":{"document":"ctx","start_line":10,"end_line":10}}</tool_call>';
        default:
          // Final-turn deep fold (with <answer>) is always allowed even with 1 block
          return '<folding>{"range":[0,4],"summary":"final summary"}</folding><answer>7341</answer>';
      }
    });
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool(), createReadTool()],
      store,
      minDeepFoldBlocks: 3,
      onEvent: (e) => events.push(e),
    });
    const res = await agent.run('What is the passcode?');
    expect(res.answer).toBe('7341');
    const folds = events.filter((e): e is Extract<AgentEvent, { type: 'fold' }> => e.type === 'fold');
    expect(folds.map((f) => f.outcome.kind)).toEqual(['granular', 'granular', 'granular', 'deep', 'granular']);
    expect(folds[1]?.outcome.directive.range).toEqual([1, 1]);
    expect(folds[1]?.outcome.corrections.some((c) => c.includes('deferred to granular'))).toBe(true);
    expect(folds[3]?.outcome.directive.range).toEqual([0, 3]);
    expect(folds[4]?.outcome.directive.range).toEqual([4, 4]);
  });
it('ResearchBoard records entries, deduplicates, and provides byte-identical prefix across steps', async () => {
    const board = new ResearchBoard();
    board.record({
      agent: 'agent',
      kind: 'llm_query',
      scope: 'ctx@8192:1-end',
      key: 'extract:count categories',
      summary: 'counts(1/1 chunks): cat=60, dog=60',
      counts: { cat: 60, dog: 60 },
    });
    expect(board.entries()).toHaveLength(1);
    expect(board.findCounts('ctx', ['cat', 'dog'])).toEqual({ cat: 60, dog: 60 });
    expect(board.findCounts('ctx', ['cat', 'bird'])).toBeUndefined();

    // Deduplication check
    board.record({
      agent: 'agent',
      kind: 'llm_query',
      scope: 'ctx@8192:1-end',
      key: 'extract:count categories',
      summary: 'counts(1/1 chunks): cat=65, dog=60',
      counts: { cat: 65, dog: 60 },
    });
    expect(board.entries()).toHaveLength(1);
    expect(board.entries()[0]?.summary).toBe('counts(1/1 chunks): cat=65, dog=60');

    // Snapshot rendered in AgentFoldAgent and stays byte-identical across steps
    const store = new ContextStore();
    store.add('line 1: cat\nline 2: dog\n', { id: 'ctx', title: 'test doc' });
    const llm = new ScriptedLLM(() => '<answer>done</answer>');
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      board,
    });
    const state0 = new FoldState();
    const msg0 = agent.buildMessages('Count animals', state0);
    expect(msg0[1]?.content).toContain('### Shared Research Board');
    expect(msg0[1]?.content).toContain('cat=65, dog=60');

    // Simulate step 1
    state0.setLatest({
      step: 0,
      motivation: 'check',
      action: { name: 'grep', arguments: { pattern: 'cat' } },
      observation: '1 matches',
    });
    state0.applyFold({ range: [0, 0], summary: 'found 1 cat' });
    const msg1 = agent.buildMessages('Count animals', state0);

    // Prefix up to ### Task should be byte-identical
    const prefix0 = msg0[1]!.content.split('### Previous Steps')[0]!;
    const prefix1 = msg1[1]!.content.split('### Previous Steps')[0]!;
    expect(prefix0).toBe(prefix1);
  });

  it('ResearchBoard runAtomicBranch deduplicates concurrent and sequential branch calls', async () => {
    const board = new ResearchBoard();
    let callCount = 0;
    const taskFn = async () => {
      callCount++;
      return 'Answer is 42';
    };

    // Sequential run
    const res1 = await board.runAtomicBranch('calculate 40 + 2', taskFn);
    expect(res1).toEqual({ result: 'Answer is 42', reused: false });
    expect(callCount).toBe(1);

    const res2 = await board.runAtomicBranch('calculate 40 + 2', taskFn);
    expect(res2).toEqual({ result: 'Answer is 42', reused: true });
    expect(callCount).toBe(1);

    // Concurrent run
    const [c1, c2] = await Promise.all([
      board.runAtomicBranch('new subtask 99', taskFn),
      board.runAtomicBranch('new subtask 99', taskFn),
    ]);
    expect(callCount).toBe(2);
    expect(c1.result).toBe('Answer is 42');
    expect(c2.result).toBe('Answer is 42');
    expect([c1.reused, c2.reused]).toContain(true);
  });

  it('Scoped specialist persists FoldState across follow-up queries with byte-identical prompt prefix', async () => {
    const store = new ContextStore();
    store.add('export const AUTH_KDF_ROUNDS = 8;\nexport const AUTH_SALT = 250;\n', {
      id: 'lib_auth',
      title: 'auth library',
    });
    store.add('export const ORDER_ID = 1;\n', { id: 'service_order', title: 'order service' });

    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      switch (step) {
        case 0:
          return '<motivation>Study lib_auth rounds</motivation><tool_call>{"name":"branch","arguments":{"scope":"lib_auth","task":"Find AUTH_KDF_ROUNDS in lib_auth"}}</tool_call>';
        case 1:
          return '<folding>{"range":[0,0],"summary":"lib_auth rounds=8"}</folding><motivation>Ask lib_auth specialist follow-up</motivation><tool_call>{"name":"branch","arguments":{"scope":"lib_auth","task":"What is AUTH_SALT in lib_auth?"}}</tool_call>';
        default:
          return '<folding>{"range":[1,1],"summary":"lib_auth salt=250"}</folding><answer>8 and 250</answer>';
      }
    });

    const branchPrompts: string[] = [];
    const branch = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      branchPrompts.push(user);
      if (user.includes('### Follow-up Question')) {
        return '<motivation>Answer directly from folded state</motivation><answer>250</answer>';
      }
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      return step === 0
        ? '<motivation>grep lib_auth</motivation><tool_call>{"name":"grep","arguments":{"document":"lib_auth","pattern":"AUTH_"}}</tool_call>'
        : '<folding>{"range":[0,0],"summary":"grep lib_auth found AUTH_KDF_ROUNDS=8 and AUTH_SALT=250"}</folding><answer>8</answer>';
    });

    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, store, maxDepth: 2 });
    const res = await raf.run('Get AUTH_KDF_ROUNDS and AUTH_SALT from lib_auth');
    expect(res.answer).toBe('8 and 250');
    expect(branchPrompts).toHaveLength(3);

    // Follow-up call (3rd branch prompt) must preserve [Compressed Step 0] and [Compressed Step 1] and include ### Follow-up Question
    const firstPrompt = branchPrompts[0] ?? '';
    const followUpPrompt = branchPrompts[2] ?? '';
    expect(followUpPrompt).toContain('[Compressed Step 0]');
    expect(followUpPrompt).toContain('[Compressed Step 1]');
    expect(followUpPrompt).toContain('### Follow-up Question\nWhat is AUTH_SALT in lib_auth?');
    expect(followUpPrompt).toContain('Step 2. Previous step archived');

    // Prefix up to ### Previous Steps must be 100% byte-identical between initial specialist run and follow-up
    const prefixInit = firstPrompt.split('### Previous Steps')[0];
    const prefixFollowUp = followUpPrompt.split('### Previous Steps')[0];
    expect(prefixInit).toBeDefined();
    expect(prefixFollowUp).toBe(prefixInit);
  });

  it('Diamond dependency concurrent branch calls on same scope serialize on queue and reuse specialist state', async () => {
    const board = new ResearchBoard();
    const events: string[] = [];

    const [r1, r2, r3] = await Promise.all([
      board.runScopedBranch('lib_auth', 'Study lib_auth rounds', async (input) => {
        events.push(`start:q1:followUp=${input.isFollowUp}`);
        await Promise.resolve();
        events.push('end:q1');
        return {
          resultText: 'rounds=8',
          answer: '8',
          state: { blocks: [{ from: 0, to: 0, summary: 'rounds=8, salt=250' }] },
        };
      }),
      board.runScopedBranch('lib_auth', 'Study lib_auth rounds', async (input) => {
        events.push(`start:q1_dup:followUp=${input.isFollowUp}`);
        return {
          resultText: 'dup',
          answer: 'dup',
          state: { blocks: [] },
        };
      }),
      board.runScopedBranch('lib_auth', 'What is salt in lib_auth?', async (input) => {
        events.push(`start:q2:followUp=${input.isFollowUp}:blocks=${input.previousState?.blocks.length ?? 0}`);
        return {
          resultText: 'salt=250',
          answer: '250',
          state: {
            blocks: [
              ...(input.previousState?.blocks ?? []),
              { from: 1, to: 1, summary: 'salt=250' },
            ],
          },
        };
      }),
    ]);

    expect(r1).toEqual({ result: 'rounds=8', reused: false, scope: 'lib_auth' });
    expect(r2).toEqual({ result: 'rounds=8', reused: true, scope: 'lib_auth' });
    expect(r3).toEqual({ result: 'salt=250', reused: false, scope: 'lib_auth' });
    expect(events).toEqual([
      'start:q1:followUp=false',
      'end:q1',
      'start:q2:followUp=true:blocks=1',
    ]);
    expect(board.entries()).toHaveLength(1);
  });

  it('Detects inter-agent callStack cycles without deadlocking and supports leaf consultOnly mode at maxDepth', async () => {
    const store = new ContextStore();
    store.add('mod_a content', { id: 'mod_a', title: 'Module A' });
    store.add('mod_b content', { id: 'mod_b', title: 'Module B' });
    store.add('mod_c content', { id: 'mod_c', title: 'Module C' });

    let leafSawCycle = false;
    let leafSawConsultOnlyBlock = false;
    let leafSawModC = false;

    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      return step === 0
        ? '<motivation>First register mod_c specialist, then run mod_a</motivation><tool_call>{"name":"branch","arguments":{"tasks":[{"scope":"mod_c","task":"Inspect mod_c"},{"scope":"mod_a","task":"Inspect mod_a"}]}}</tool_call>'
        : `<folding>{"range":[0,0],"summary":"done"}</folding><answer>${user.includes('mod_b_ok') ? 'cycle-safe-and-consulted' : 'failed'}</answer>`;
    });

    const branch = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      if (user.includes('### Task\nInspect mod_c')) {
        return user.includes('### Follow-up Question')
          ? '<motivation>reply to leaf consult</motivation><answer>mod_c_val=99</answer>'
          : '<motivation>init mod_c</motivation><answer>mod_c_ready</answer>';
      }
      if (user.includes('### Task\nInspect mod_a')) {
        const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
        return step === 0
          ? '<motivation>delegate to mod_b</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_b","task":"Inspect mod_b"}}</tool_call>'
          : `<folding>{"range":[0,0],"summary":"from mod_b"}</folding><answer>${user.includes('mod_b_verified') ? 'mod_b_ok' : 'mod_b_bad'}</answer>`;
      }
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>try cycle to mod_a</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_a","task":"Cycle back to mod_a"}}</tool_call>';
      }
      if (step === 1) {
        if (user.includes('cycle detected on scope')) leafSawCycle = true;
        return '<folding>{"range":[0,0],"summary":"cycle blocked"}</folding><motivation>try unstudied at leaf</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_unstudied","task":"Spawn new"}}</tool_call>';
      }
      if (step === 2) {
        if (user.includes('At max depth you may only query existing specialists')) leafSawConsultOnlyBlock = true;
        return '<folding>{"range":[1,1],"summary":"unstudied blocked"}</folding><motivation>consult existing mod_c</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_c","task":"What is mod_c value?"}}</tool_call>';
      }
      if (user.includes('mod_c_val=99')) leafSawModC = true;
      return '<folding>{"range":[2,2],"summary":"got mod_c"}</folding><answer>mod_b_verified</answer>';
    });

    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, store, maxDepth: 2 });
    const res = await raf.run('Test cycle guard and leaf consult');
    expect(res.answer).toBe('cycle-safe-and-consulted');
    expect(leafSawCycle).toBe(true);
    expect(leafSawConsultOnlyBlock).toBe(true);
    expect(leafSawModC).toBe(true);
  });

  it('Renders new board entries via renderSince in the dynamic tail without altering cached prefix', () => {
    const board = new ResearchBoard();
    board.record({
      agent: 'specialist#1[lib_auth]',
      kind: 'branch',
      scope: 'lib_auth',
      key: 'lib_auth',
      summary: 'AUTH_KDF_ROUNDS = 8',
    });
    const store = new ContextStore();
    store.add('line 1\n', { id: 'ctx', title: 'doc' });
    const llm = new ScriptedLLM(() => '<answer>ok</answer>');
    const agent = new AgentFoldAgent({ llm, tools: [createGrepTool()], store, board });
    const state = new FoldState();
    const msg0 = agent.buildMessages('Question?', state)[1]?.content ?? '';
    expect(msg0).toContain('[branch][scope=lib_auth]');
    expect(msg0).not.toContain('### New Board Findings');

    // Record a new specialist conclusion while agent is running
    board.record({
      agent: 'specialist#2[lib_crypto]',
      kind: 'branch',
      scope: 'lib_crypto',
      key: 'lib_crypto',
      summary: 'CRYPTO_PRIME_MOD = 509',
    });
    const msg1 = agent.buildMessages('Question?', state)[1]?.content ?? '';
    expect(msg1).toContain('### New Board Findings');
    expect(msg1).toContain('[branch][scope=lib_crypto] CRYPTO_PRIME_MOD = 509');

    const prefix0 = msg0.split('### Previous Steps')[0];
    const prefix1 = msg1.split('### Previous Steps')[0];
    expect(prefix1).toBe(prefix0);
  });

  it('Hierarchical pipeline root -> subagent#0..2 -> llm_query + sub_agent@d2 -> llm_query with in-flight visibility, rev tracking, and cumulative summaries (B1, B2, B3)', async () => {
    const store = new ContextStore();
    store.add('MOD_0_BASE = 10\n', { id: 'mod_0', title: 'module 0' });
    store.add('MOD_1_KEY = 25\nMOD_1_BONUS = 87\n', { id: 'mod_1', title: 'module 1' });
    store.add('MOD_2_FACTOR = 3\n', { id: 'mod_2', title: 'module 2' });
    store.add('LEAF_OFFSET = 7\n', { id: 'mod_leaf', title: 'leaf module' });

    let mod0SawInFlightMod1 = false;
    let mod2SpawnedLeaf = false;
    let leafCalledLlmQuery = false;
    let selfBranchRejected = false;

    const queryLLM = new ScriptedLLM(
      (req) => {
        const chunk = req.messages[1]?.content ?? '';
        if (chunk.includes('LEAF_OFFSET')) {
          leafCalledLlmQuery = true;
          return JSON.stringify({ relevant: true, answer: 'LEAF_OFFSET = 7', evidence: [{ line: 1, quote: 'LEAF_OFFSET = 7' }] });
        }
        return JSON.stringify({ relevant: true, answer: 'MOD_2_FACTOR = 3', evidence: [{ line: 1, quote: 'MOD_2_FACTOR = 3' }] });
      },
      { name: 'query-reader', contextWindow: 128_000, maxOutputTokens: 1024 },
    );

    const root = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Spawn 3 parallel specialists for mod_0, mod_1, mod_2</motivation><tool_call>{"name":"branch","arguments":{"tasks":[{"scope":"mod_0","task":"Compute mod_0 + mod_1"},{"scope":"mod_1","task":"Find MOD_1_KEY and MOD_1_BONUS in mod_1"},{"scope":"mod_2","task":"Analyze mod_2 and mod_leaf"}]}}</tool_call>';
      }
      return '<folding>{"range":[0,0],"summary":"All 3 specialists completed"}</folding><answer>hierarchy-ok</answer>';
    });

    const branch = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (user.includes('responsible ONLY for [scope=mod_0]')) {
        if (user.includes('[in-progress]') && user.includes('mod_1')) mod0SawInFlightMod1 = true;
        if (step === 0) {
          return '<motivation> Try self branch first to test B2 guard </motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_0","task":"self call"}}</tool_call>';
        }
        if (step === 1) {
          if (user.includes('do NOT call branch on your own scope')) selfBranchRejected = true;
          return '<folding>{"range":[0,0],"summary":"self branch blocked"}</folding><motivation>Query peer mod_1 for MOD_1_KEY</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_1","task":"What is MOD_1_KEY?"}}</tool_call>';
        }
        return '<folding>{"range":[1,1],"summary":"got MOD_1_KEY=25"}</folding><answer>MOD_0_BASE = 10, MOD_1_KEY = 25</answer>';
      }
      if (user.includes('responsible ONLY for [scope=mod_1]')) {
        return '<motivation>Read mod_1</motivation><answer>MOD_1_KEY = 25, MOD_1_BONUS = 87</answer>';
      }
      if (user.includes('responsible ONLY for [scope=mod_2]')) {
        if (step === 0) {
          return '<motivation>Run llm_query on mod_2</motivation><tool_call>{"name":"llm_query","arguments":{"query":"Find MOD_2_FACTOR","documents":["mod_2"]}}</tool_call>';
        }
        if (step === 1) {
          mod2SpawnedLeaf = true;
          return '<folding>{"range":[0,0],"summary":"MOD_2_FACTOR = 3"}</folding><motivation>Spawn child specialist at depth 2 for mod_leaf</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_leaf","task":"Find LEAF_OFFSET in mod_leaf"}}</tool_call>';
        }
        return '<folding>{"range":[1,1],"summary":"LEAF_OFFSET = 7"}</folding><answer>MOD_2_FACTOR = 3, LEAF_OFFSET = 7</answer>';
      }
      if (user.includes('responsible ONLY for [scope=mod_leaf]')) {
        if (step === 0) {
          return '<motivation>Leaf specialist calls llm_query</motivation><tool_call>{"name":"llm_query","arguments":{"query":"Find LEAF_OFFSET","documents":["mod_leaf"]}}</tool_call>';
        }
        return '<folding>{"range":[0,0],"summary":"LEAF_OFFSET = 7"}</folding><answer>LEAF_OFFSET = 7</answer>';
      }
      return '<answer>fallback</answer>';
    });

    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, queryLLM, store, maxDepth: 2 });
    const res = await raf.run('Run hierarchical test');
    expect(res.answer).toBe('hierarchy-ok');
    expect(mod0SawInFlightMod1).toBe(true);
    expect(selfBranchRejected).toBe(true);
    expect(mod2SpawnedLeaf).toBe(true);
    expect(leafCalledLlmQuery).toBe(true);

    // Verify B1: updating an existing entry on the board increases rev and is visible in renderSince
    const revBefore = raf.board.currentRev();
    raf.board.record({
      agent: 'specialist#2[mod_1]',
      kind: 'branch',
      scope: 'mod_1',
      key: 'mod_1',
      summary: 'Updated mod_1 summary',
    });
    expect(raf.board.renderSince(revBefore)).toContain('Updated mod_1 summary');
    expect(raf.board.renderSince(revBefore, 'mod_1')).toBeUndefined();

    // Verify B3: narrow follow-up to specialist does not erase earlier constants from board summary
    const board2 = new ResearchBoard();
    await board2.runScopedBranch('lib_auth', 'Find all constants', async () => ({
      resultText: 'AUTH_KDF_ROUNDS = 10, AUTH_SALT_OFFSET = 296, AUTH_ISSUER_BONUS = 87',
      answer: 'AUTH_KDF_ROUNDS = 10, AUTH_SALT_OFFSET = 296, AUTH_ISSUER_BONUS = 87',
      state: { blocks: [{ from: 0, to: 0, summary: 'init' }], latest: undefined },
    }));
    // Follow-up asking for already-known constants should fast-reuse without calling fn!
    let fnCalled = false;
    const fastReuse = await board2.runScopedBranch('lib_auth', 'What are AUTH_KDF_ROUNDS and AUTH_SALT_OFFSET?', async () => {
      fnCalled = true;
      return { resultText: 'narrow', answer: 'narrow', state: { blocks: [], latest: undefined } };
    });
    expect(fastReuse.reused).toBe(true);
    expect(fnCalled).toBe(false);
    expect(fastReuse.result).toContain('AUTH_ISSUER_BONUS = 87');

    // Even when a new follow-up question runs fn and returns a narrow answer, board preserves cumulative facts
    await board2.runScopedBranch('lib_auth', 'What is the hop pipeline formula?', async () => ({
      resultText: 'ROUNDS + SALT = 306',
      answer: 'ROUNDS + SALT = 306',
      state: { blocks: [{ from: 0, to: 1, summary: 'followup' }], latest: undefined },
    }));
    expect(board2.render()).toContain('AUTH_ISSUER_BONUS = 87');
    expect(board2.render()).toContain('ROUNDS + SALT = 306');
  });

  it('Merges same-scope tasks in branch(tasks=[...]) and reports per-call step counts (B4)', async () => {
    const store = new ContextStore();
    store.add('X = 1\nY = 2\n', { id: 'lib_core', title: 'core' });
    let branchInvocations = 0;
    const root = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Batch two tasks to same scope lib_core</motivation><tool_call>{"name":"branch","arguments":{"tasks":[{"scope":"lib_core","task":"Find X"},{"scope":"lib_core","task":"Find Y"}]}}</tool_call>';
      }
      if (step === 1) {
        return '<folding>{"range":[0,0],"summary":"first call done"}</folding><motivation>Follow up lib_core</motivation><tool_call>{"name":"branch","arguments":{"scope":"lib_core","task":"Compute hop pipeline for X and Y"}}</tool_call>';
      }
      return `<folding>{"range":[1,1],"summary":"second call done"}</folding><answer>${user.includes('1 steps') ? 'steps-accurate' : 'steps-wrong'}</answer>`;
    });
    const branch = new ScriptedLLM(() => {
      branchInvocations++;
      return '<motivation>done</motivation><answer>X = 1, Y = 2</answer>';
    });
    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, store, maxDepth: 1 });
    const res = await raf.run('Test batch merge and step count');
    // 1 call for the merged batch + 1 call for the follow-up = 2 total (not 3)
    expect(branchInvocations).toBe(2);
    expect(res.answer).toBe('steps-accurate');
  });

  it('Guards against CoT reasoning overflow and clamps llm_query extract chunks to 8192 (B6, B8)', async () => {
    const store = new ContextStore();
    store.add(haystack(4000, 100), { id: 'doc1', title: 'doc1' });
    let sawTruncationWarning = false;
    let callCount = 0;
    const llm = new ScriptedLLM((req) => {
      callCount++;
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      if (callCount === 1) {
        return {
          text: '',
          reasoning: 'thinking forever...',
          finishReason: 'length',
          usage: { promptTokens: 1000, completionTokens: 16000, cachedTokens: 800, reasoningTokens: 16000 },
        };
      }
      if (user.includes('previous internal reasoning was too long')) sawTruncationWarning = true;
      return '<motivation>concise</motivation><answer>recovered</answer>';
    });
    const agent = new AgentFoldAgent({ llm, tools: [createGrepTool(), createReadTool()], store });
    const res = await agent.run('Test CoT overflow');
    expect(res.answer).toBe('recovered');
    expect(sawTruncationWarning).toBe(true);

    // B8: 128k reader model caps default locate chunks at 32768 and clamps extract chunk_tokens=16384 to 8192
    let readerAttempts = 0;
    let sawRetryPrompt = false;
    const bigReader = new ScriptedLLM(
      (req) => {
        readerAttempts++;
        const lastMsg = req.messages[req.messages.length - 1]?.content ?? '';
        if (lastMsg.includes('Keep internal thinking under 50 words')) sawRetryPrompt = true;
        if (readerAttempts === 1) {
          return { text: '', finishReason: 'length' };
        }
        return JSON.stringify({ relevant: true, answer: 'count=5', evidence: [], counts: { a: 5 } });
      },
      { name: 'big-reader', contextWindow: 128_000, maxOutputTokens: 16_384 },
    );
    const engine = new LLMQueryEngine(bigReader, store, new UsageTracker());
    expect(engine.defaultChunkTokens).toBe(32_768);
    expect(engine.defaultExtractChunkTokens).toBe(8192);
    const qRes = await engine.query({
      query: 'Count category a',
      mode: 'extract',
      chunkTokens: 16_384,
      categories: ['a'],
    });
    expect(qRes.chunkTokens).toBe(8192);
    expect(sawRetryPrompt).toBe(true);
    expect(qRes.findings.every((f) => !f.error)).toBe(true);
  });
});

describe('answer echo guard', () => {
  it('rejects an answer copied from the folding summary and retries', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const summary =
      'ARCHITECTURE summary with many details about the engine loop, fold state, cache layout, llm_query chunks, branch recursion, prompts, parsers, and the applyFold transition.';
    const echo = summary.slice(-120);
    const responses = [
      '<motivation>probe the context.</motivation><tool_call>{"name":"probe","arguments":{}}</tool_call>',
      `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer.</motivation><answer>${echo}</answer>`,
      `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer cleanly.</motivation><answer>clean final answer</answer>`,
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [
        {
          name: 'probe',
          description: 'probe the context',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return 'observed';
          },
        },
      ],
      store,
      maxSteps: 6,
      maxFormatRetries: 1,
      onEvent: (event) => events.push(event),
    });
    const result = await agent.run('summarize the project');
    expect(result.answer).toBe('clean final answer');
    expect(result.formatIssues).toBeGreaterThan(0);
    expect(events.some((event) => event.type === 'format_error' && event.errors.some((error) => error.includes('repeats')))).toBe(true);
  });
});

describe('answer protocol tag guard', () => {
  it('rejects an answer that contains a protocol closing tag and retries', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const summary =
      'ARCHITECTURE summary with many details about the engine loop, fold state, cache layout, llm_query chunks, branch recursion, prompts, parsers, and the applyFold transition.';
    const responses = [
      '<motivation>probe the context.</motivation><tool_call>{"name":"probe","arguments":{}}</tool_call>',
      `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer.</motivation><answer>copied text"}</folding></answer>`,
      `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer cleanly.</motivation><answer>clean final answer</answer>`,
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [
        {
          name: 'probe',
          description: 'probe the context',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return 'observed';
          },
        },
      ],
      store,
      maxSteps: 6,
      maxFormatRetries: 1,
      onEvent: (event) => events.push(event),
    });
    const result = await agent.run('summarize the project');
    expect(result.answer).toBe('clean final answer');
    expect(events.some((event) => event.type === 'format_error' && event.errors.some((error) => error.includes('protocol tag')))).toBe(true);
  });
});

describe('truncated answer guard', () => {
  it('rejects an answer cut by the output limit and retries', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const summary = 'A compact summary of the probe step with enough detail to satisfy the folding contract and keep the state consistent.';
    const responses: Array<string | { readonly text: string; readonly finishReason: string }> = [
      '<motivation>probe the context.</motivation><tool_call>{"name":"probe","arguments":{}}</tool_call>',
      {
        text: `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer.</motivation><answer>partial answer that is cut`,
        finishReason: 'length',
      },
      {
        text: `<folding>{"range":[0,0],"summary":${JSON.stringify(summary)}}</folding><motivation>answer.</motivation><answer>complete answer</answer>`,
        finishReason: 'stop',
      },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [
        {
          name: 'probe',
          description: 'probe the context',
          parameters: { type: 'object', properties: {} },
          async execute() {
            return 'observed';
          },
        },
      ],
      store,
      maxSteps: 6,
      maxFormatRetries: 1,
      onEvent: (event) => events.push(event),
    });
    const result = await agent.run('summarize the project');
    expect(result.answer).toBe('complete answer');
    expect(events.some((event) => event.type === 'format_error' && event.errors.some((error) => error.includes('output token limit')))).toBe(true);
  });
});

describe('accuracy & prefix cache hardening (H2a, H2b, H2c, H3)', () => {
  it('H2a: rejects placeholder <answer> strings before maxSteps and retries until a real answer is emitted', async () => {
    const store = new ContextStore();
    store.add('target_value = 99', { id: 'ctx' });
    const responses = [
      '<motivation>wait</motivation><answer>Pending verification, still verifying</answer>',
      '<motivation>wait more</motivation><answer>No final answer yet, still verifying.</answer>',
      '<motivation>done</motivation><answer>99</answer>',
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      maxSteps: 4,
      maxFormatRetries: 2,
      onEvent: (e) => events.push(e),
    });
    const res = await agent.run('What is target_value?');
    expect(res.answer).toBe('99');
    expect(res.formatIssues).toBe(2);
    expect(events.filter((e) => e.type === 'format_error' && e.errors.some((err) => err.includes('verification placeholder')))).toHaveLength(2);
  });

  it('H2b: ContextStore.grep centers snippets around regex matches past char 300 on long lines', () => {
    const store = new ContextStore();
    const prefix = 'a'.repeat(1100);
    const suffix = 'b'.repeat(400);
    const longLine = `${prefix}NEEDLE_TOKEN=481516${suffix}`;
    store.add(longLine, { id: 'longdoc' });
    const res = store.grep('NEEDLE_TOKEN=\\d+');
    expect(res.total).toBe(1);
    expect(res.matches).toHaveLength(1);
    expect(res.matches[0]?.text).toContain('NEEDLE_TOKEN=481516');
    expect(res.matches[0]?.text.startsWith('…')).toBe(true);
    expect(res.matches[0]?.text.endsWith('…')).toBe(true);

    // Multi-document grep distributes maxMatches across matching documents
    const multiStore = new ContextStore();
    multiStore.add(Array.from({ length: 10 }, (_, i) => `hit_${i + 1}`).join('\n'), { id: 'doc_1' });
    multiStore.add(Array.from({ length: 10 }, (_, i) => `hit_${i + 1}`).join('\n'), { id: 'doc_2' });
    multiStore.add(Array.from({ length: 10 }, (_, i) => `hit_${i + 1}`).join('\n'), { id: 'doc_3' });
    const multiRes = multiStore.grep('hit_', { maxMatches: 6 });
    expect(multiRes.total).toBe(30);
    expect(multiRes.matches.map((m) => m.docId)).toEqual(['doc_1', 'doc_1', 'doc_2', 'doc_2', 'doc_3', 'doc_3']);
  });

  it('H2c: createReadTool stops cleanly on a line boundary at maxReadTokens without omitting middle lines', async () => {
    const store = new ContextStore();
    const lines = Array.from({ length: 20 }, (_, i) => `Row_${i + 1}: ${'x'.repeat(180)}`);
    store.add(lines.join('\n'), { id: 'doc' });
    const readTool = createReadTool({ maxReadLines: 20, maxReadTokens: 250 });
    const out = await readTool.execute(
      { document: 'doc', start_line: 1, end_line: 20 },
      { store, usage: new UsageTracker(), depth: 0, agentName: 'root', step: 0, emit: () => {} },
    );
    expect(out).toMatch(/doc lines 1-(\d+) of 20 \(stopped at line \1 due to token limit; read from \d+ to continue\)/);
    expect(out).not.toContain('truncated');
    const returnedRowNums = [...out.matchAll(/^\d+\| Row_(\d+):/gm)].map((m) => Number(m[1]));
    expect(returnedRowNums.length).toBeGreaterThan(1);
    expect(returnedRowNums.length).toBeLessThan(20);
    for (let i = 0; i < returnedRowNums.length; i++) {
      expect(returnedRowNums[i]).toBe(i + 1);
    }
  });

  it('H3: parallel specialists share an identical initialBoardSnapshot and LLMQueryCache reuses content-hashed chunks across stores', async () => {
    const board = new ResearchBoard();
    const snapshots: Array<string | undefined> = [];
    const deltas: Array<string | undefined> = [];
    await Promise.all([
      board.runScopedBranch('mod_a', 'Inspect mod_a', async (input) => {
        snapshots.push(input.initialBoardSnapshot);
        await Promise.resolve();
        deltas.push(board.renderSince(input.initialBoardRev, 'mod_a'));
        return { resultText: 'A=1', answer: '1', state: { blocks: [] } };
      }),
      board.runScopedBranch('mod_b', 'Inspect mod_b', async (input) => {
        snapshots.push(input.initialBoardSnapshot);
        await Promise.resolve();
        deltas.push(board.renderSince(input.initialBoardRev, 'mod_b'));
        return { resultText: 'B=2', answer: '2', state: { blocks: [] } };
      }),
    ]);
    expect(snapshots).toEqual([undefined, undefined]);
    expect(deltas[0]).toContain('[in-progress]');
    expect(deltas[0]).toContain('mod_b');
    expect(deltas[1]).toContain('[in-progress]');
    expect(deltas[1]).toContain('mod_a');

    // Cross-store LLMQueryCache reuse when earlier chunks are unchanged and new lines are appended
    const sharedCache = { memo: new Map(), chunkCounts: new Map() };
    const baseLines = Array.from({ length: 300 }, (_, i) => `entry ${i + 1}: ${i % 2 === 0 ? 'alpha' : 'beta'}`);
    const storeTurn1 = new ContextStore();
    storeTurn1.add(baseLines.join('\n'), { id: 'session' });
    let readerCalls = 0;
    const reader = new ScriptedLLM(() => {
      readerCalls++;
      return JSON.stringify({ relevant: true, answer: 'counts', counts: { alpha: 10, beta: 10 }, evidence: [] });
    });
    const engine1 = new LLMQueryEngine(reader, storeTurn1, new UsageTracker(), {
      maxChunkTokens: 512,
      minChunkTokens: 256,
      cache: sharedCache,
    });
    const res1 = await engine1.query({ query: 'Count alpha and beta', mode: 'extract', categories: ['alpha', 'beta'] });
    const turn1Chunks = res1.findings.length;
    expect(turn1Chunks).toBeGreaterThan(2);
    expect(readerCalls).toBe(turn1Chunks);

    // Turn 2: append new lines to the end of 'session'; all full prefix chunks have identical content hashes
    const storeTurn2 = new ContextStore();
    const turn2Lines = [...baseLines, ...Array.from({ length: 100 }, (_, i) => `entry ${301 + i}: alpha`)];
    storeTurn2.add(turn2Lines.join('\n'), { id: 'session' });
    const engine2 = new LLMQueryEngine(reader, storeTurn2, new UsageTracker(), {
      maxChunkTokens: 512,
      minChunkTokens: 256,
      cache: sharedCache,
    });
    const res2 = await engine2.query({ query: 'Count alpha and beta in turn 2', mode: 'extract', categories: ['alpha', 'beta'] });
    const memoHitsTurn2 = res2.findings.filter((f) => f.memoHit).length;
    expect(memoHitsTurn2).toBeGreaterThanOrEqual(turn1Chunks - 1);
  });
});

describe('rlm.pi best practices port & root cache optimization (H1-H6)', () => {
  it('H1: BM25 V2 search ranks morphological variants, phrase bonus,PRF, and CJK n-grams; outline extracts structure', async () => {
    const store = new ContextStore();
    const filler = Array.from({ length: 300 }, (_, i) => `Line ${i + 1}: routine administrative notes and general log records.`);
    filler[140] = 'Section 4: The agency is modernising sustainable healthcare innovations across regional hospitals.';
    filler[240] = 'Volume 5: Zhuanxu Gaoyang ascended the throne and established the calendar for the four seasons.';
    store.add(filler.join('\n'), { id: 'report', title: 'Annual Report' });

    const enHits = store.search('sustainable healthcare innovation', { k: 5 });
    expect(enHits.length).toBeGreaterThan(0);
    expect(enHits[0]?.docId).toBe('report');
    expect(enHits[0]?.startLine).toBeLessThanOrEqual(141);
    expect(enHits[0]?.endLine).toBeGreaterThanOrEqual(141);
    expect(enHits[0]?.snippet).toContain('modernising sustainable healthcare innovations');

    const volHits = store.search('Zhuanxu Gaoyang calendar', { k: 3 });
    expect(volHits.length).toBeGreaterThan(0);
    expect(volHits[0]?.startLine).toBeLessThanOrEqual(241);
    expect(volHits[0]?.endLine).toBeGreaterThanOrEqual(241);
    expect(volHits[0]?.snippet).toContain('Zhuanxu');

    const searchTool = createSearchTool();
    const searchObs = await searchTool.execute(
      { query: 'sustainable healthcare innovation', k: 3 },
      { store, usage: new UsageTracker(), depth: 0, agentName: 'root', step: 0, emit: () => {} },
    );
    expect(searchObs).toContain('search "sustainable healthcare innovation": top');
    expect(searchObs).toContain('report:L');

    const structuredStore = new ContextStore();
    structuredStore.add(
      [
        '# 1. Architecture Overview',
        'Some introductory text.',
        '## 1.1 Storage Engine',
        'export class StorageEngine {',
        '  run() {}',
        '}',
        'Chapter 2 System Evaluation',
        'Evaluation details.',
      ].join('\n'),
      { id: 'spec', title: 'Spec' },
    );
    const outlineTool = createOutlineTool();
    const outlineObs = await outlineTool.execute(
      { document: 'spec' },
      { store: structuredStore, usage: new UsageTracker(), depth: 0, agentName: 'root', step: 0, emit: () => {} },
    );
    expect(outlineObs).toContain('L1: # 1. Architecture Overview');
    expect(outlineObs).toContain('L3: ## 1.1 Storage Engine');
    expect(outlineObs).toContain('L4: export class StorageEngine {');
    expect(outlineObs).toContain('L7: Chapter 2 System Evaluation');
  });

  it('H2: Root (depth=0) defers mid-run deep folds below 16 blocks to preserve prefix cache, while branch (depth=1) consolidates at 6 blocks', async () => {
    const store = new ContextStore();
    store.add('K = 42\n', { id: 'doc1' });

    const makeScript = () => {
      let call = 0;
      return new ScriptedLLM(() => {
        const step = call++;
        if (step === 0) {
          return '<motivation>start</motivation><tool_call>{"name":"grep","arguments":{"pattern":"K"}}</tool_call>';
        }
        if (step >= 1 && step <= 6) {
          return `<folding>{"range":[${step - 1},${step - 1}],"summary":"step ${step - 1} ok"}</folding><motivation>step ${step}</motivation><tool_call>{"name":"grep","arguments":{"pattern":"K"}}</tool_call>`;
        }
        if (step === 7) {
          // Request a mid-run deep fold [0, 6] (retracting 6 existing blocks 0..5) while still calling a tool
          return '<folding>{"range":[0,6],"summary":"consolidated 0..6"}</folding><motivation>final check</motivation><tool_call>{"name":"grep","arguments":{"pattern":"K"}}</tool_call>';
        }
        return '<folding>{"range":[7,7],"summary":"done"}</folding><motivation>finish</motivation><answer>42</answer>';
      });
    };

    const rootFolds: string[] = [];
    const rootAgent = new AgentFoldAgent({
      llm: makeScript(),
      tools: [createGrepTool()],
      store,
      depth: 0,
      onEvent: (e) => {
        if (e.type === 'fold') rootFolds.push(e.outcome.kind);
      },
    });
    await rootAgent.run('Find K');
    // Root at depth=0 has default threshold 16, so the [0,6] deep fold at step 7 is deferred to granular [6,6]
    expect(rootFolds).not.toContain('deep');

    const branchFolds: string[] = [];
    const branchAgent = new AgentFoldAgent({
      llm: makeScript(),
      tools: [createGrepTool()],
      store,
      depth: 1,
      scope: 'doc1',
      onEvent: (e) => {
        if (e.type === 'fold') branchFolds.push(e.outcome.kind);
      },
    });
    await branchAgent.run('Find K');
    // Branch at depth=1 has default threshold 6, so [0,6] deep fold is allowed
    expect(branchFolds).toContain('deep');
  });

  it('H3: TaskLedger blocks ancestor-echo re-delegation while allowing same question on a different target module, and demotes specialist step budget past maxSpecialists', async () => {
    expect(
      isAncestorEcho('Please analyze module lib_auth and compute AUTH_KEY', ['Analyze module lib_auth and compute AUTH_KEY']),
    ).toBe(true);
    expect(
      isAncestorEcho('Analyze module lib_crypto and compute AUTH_KEY', ['Analyze module lib_auth and compute AUTH_KEY']),
    ).toBe(false);

    const store = new ContextStore();
    store.add('VAL = 10\n', { id: 'mod_a' });
    store.add('VAL = 20\n', { id: 'mod_b' });

    let echoBlocked = false;
    const root = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Delegate mod_a</motivation><tool_call>{"name":"branch","arguments":{"scope":"mod_a","task":"Inspect custom metric alpha beta gamma"}}</tool_call>';
      }
      return '<folding>{"range":[0,0],"summary":"done"}</folding><motivation>answer</motivation><answer>30</answer>';
    });
    const branch = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        // Attempt to re-delegate the ancestor task without specifying a different scope
        return '<motivation>Echo parent task</motivation><tool_call>{"name":"branch","arguments":{"task":"Please inspect custom metric alpha beta gamma"}}</tool_call>';
      }
      if (user.includes('ancestor echo rejected')) {
        echoBlocked = true;
      }
      return '<folding>{"range":[0,0],"summary":"echo blocked"}</folding><motivation>done</motivation><answer>10</answer>';
    });
    const raf = new RecursiveAgentFold({ rootLLM: root, branchLLM: branch, store, maxDepth: 2 });
    const res = await raf.run('Root question');
    expect(res.answer).toBe('30');
    expect(echoBlocked).toBe(true);
  });

  it('H4: formatMarginNote emits a verification notice when adjacent category counts are within <5% of total or <8% of pair sum', () => {
    const note = formatMarginNote({
      'numeric value': 971,
      'description and abstract concept': 423,
      'human being': 394,
      location: 503,
    });
    expect(note).toBeDefined();
    expect(note).toContain('[Margin notice: close counts on');
    expect(note).toContain('description and abstract concept(423) vs human being(394)');

    const wideMargin = formatMarginNote({
      alpha: 900,
      beta: 100,
    });
    expect(wideMargin).toBeUndefined();
  });

  it('H5: nudges once when an agent answers immediately after a token-capped read without folding, and salvages unclosed <answer> on forcing step', async () => {
    const store = new ContextStore();
    const lines = Array.from({ length: 20 }, (_, i) => `Option_${i + 1}: ${'x'.repeat(180)}`);
    store.add(lines.join('\n'), { id: 'doc' });

    let step1Calls = 0;
    const llm = new ScriptedLLM((req) => {
      const user = req.messages[req.messages.length - 1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Read doc</motivation><tool_call>{"name":"read","arguments":{"document":"doc","start_line":1,"end_line":20}}</tool_call>';
      }
      if (step === 1) {
        step1Calls++;
        if (step1Calls === 1) {
          // Premature answer without <folding> right after a truncated read
          return '<motivation>Guessing early</motivation><answer>AE</answer>';
        }
        return '<folding>{"range":[0,0],"summary":"read partial lines"}</folding><motivation>Verified all options</motivation><answer>ACE</answer>';
      }
      return '<answer>ACE</answer>';
    });

    const agent = new AgentFoldAgent({
      llm,
      tools: [createReadTool({ maxReadLines: 20, maxReadTokens: 250 })],
      store,
      maxSteps: 4,
    });
    const res = await agent.run('Which options are valid?');
    expect(res.answer).toBe('ACE');
    expect(step1Calls).toBe(2);

    // Verify extractFallbackAnswer salvages unclosed <answer> or [Answer] marker
    expect(extractFallbackAnswer('<motivation>final</motivation><answer>[Answer]\n42')).toBe('[Answer]\n42');
    expect(extractFallbackAnswer('Reasoning summary...\n[Answer]\n["A", "C"]')).toBe('[Answer]\n["A", "C"]');
  });

  it('H6: createTallyTool reports both exact-case counts and case-folded breakdown when casing variants exist', async () => {
    const store = new ContextStore();
    const words = [
      ...Array.from({ length: 37 }, () => 'would'),
      ...Array.from({ length: 36 }, () => 'this'),
      ...Array.from({ length: 4 }, () => 'This'),
    ];
    store.add(words.join('\n'), { id: 'corpus' });
    const tallyTool = createTallyTool();
    const obs = await tallyTool.execute(
      { pattern: '\\b(would|this)\\b' },
      { store, usage: new UsageTracker(), depth: 0, agentName: 'root', step: 0, emit: () => {} },
    );
    expect(obs).toContain('37\twould');
    expect(obs).toContain('36\tthis');
    expect(obs).toContain('4\tThis');
    expect(obs).toContain('Case-folded summary (when task is case-insensitive vs exact-case):');
    expect(obs).toContain('this: 40 total (exact-case: this=36, This=4)');
  });
});

describe('Multi-format directory & document ingestion (add_document) and Live Dock hierarchy', () => {
  it('ingests mixed directories (code, markdown, rich documents via anydoc), skips binary/sensitive files, preserves Root KV prefix cache, and supports scoped branch specialists', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'raf-ingest-'));
    const repoDir = join(tempRoot, 'sample-repo');
    try {
      await mkdir(join(repoDir, 'src'), { recursive: true });
      await mkdir(join(repoDir, 'docs'), { recursive: true });
      await mkdir(join(repoDir, 'assets'), { recursive: true });

      await writeFile(
        join(repoDir, 'src', 'mod.ts'),
        'export const ORION_MULTIPLIER = 19;\nexport function computeBoost(x: number): number {\n  return x * ORION_MULTIPLIER;\n}\n',
        'utf-8',
      );
      await writeFile(
        join(repoDir, 'docs', 'guide.md'),
        '# Architecture Guide\n\nThe base calibration constant is BASE_SEED = 7.\n',
        'utf-8',
      );
      await writeFile(join(repoDir, '.env'), 'SECRET_TOKEN=super-secret\n', 'utf-8');
      await writeFile(join(repoDir, 'assets', 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x47, 0x00]));
      await writeFile(join(repoDir, 'docs', 'spec.pdf'), 'fake-pdf-binary-container', 'utf-8');

      setAnydocForTest({
        formatFromPath: (p: string) => (p.endsWith('.pdf') ? 'pdf' : null),
        toMarkdown: async () => '# Converted PDF Specification\n\nPDF_OFFSET = 12.\n',
      });

      const detected = extractPromptPaths(`Please analyze ${repoDir} and summarize the constants.`);
      expect(detected).toContain(repoDir);

      const store = new ContextStore();
      let step0DocHeader = '';
      let step1DocHeader = '';
      let step1UserPrompt = '';

      const root = new ScriptedLLM((req) => {
        const user = req.messages[1]?.content ?? '';
        const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
        const docSection = user.split('\n\n### ')[0] ?? '';
        if (step === 0) {
          step0DocHeader = docSection;
          return `<motivation>Load the target repository directory into ContextStore.</motivation><tool_call>${JSON.stringify({
            name: 'add_document',
            arguments: { path: repoDir },
          })}</tool_call>`;
        }
        if (step === 1) {
          step1DocHeader = docSection;
          step1UserPrompt = user;
          return `<folding>{"range":[0,0],"summary":"Loaded sample-repo (src/mod.ts, docs/guide.md, docs/spec.pdf)."}</folding><motivation>Delegate src/mod.ts inspection to a scoped specialist.</motivation><tool_call>${JSON.stringify({
            name: 'branch',
            arguments: {
              scope: 'sample-repo/src/mod.ts',
              task: 'Find ORION_MULTIPLIER in sample-repo/src/mod.ts',
            },
          })}</tool_call>`;
        }
        return '<folding>{"range":[1,1],"summary":"ORION_MULTIPLIER = 19, BASE_SEED = 7, PDF_OFFSET = 12."}</folding><motivation>All constants verified.</motivation><answer>ORION_MULTIPLIER=19, PDF_OFFSET=12</answer>';
      });

      const branch = new ScriptedLLM((req) => {
        const user = req.messages[1]?.content ?? '';
        if (/Step 0\./.test(user)) {
          return '<motivation>Grep for ORION_MULTIPLIER in sample-repo/src/mod.ts</motivation><tool_call>{"name":"grep","arguments":{"pattern":"ORION_MULTIPLIER","document":"sample-repo/src/mod.ts"}}</tool_call>';
        }
        return '<folding>{"range":[0,0],"summary":"sample-repo/src/mod.ts defines ORION_MULTIPLIER = 19."}</folding><motivation>Return finding</motivation><answer>ORION_MULTIPLIER = 19</answer>';
      });

      const ingestedSnapshots: string[] = [];
      const raf = new RecursiveAgentFold({
        rootLLM: root,
        branchLLM: branch,
        store,
        ingest: {
          onIngest: (res) => {
            for (const f of res.files) ingestedSnapshots.push(f.id);
          },
        },
      });

      const res = await raf.run(`Analyze ${repoDir}`);
      expect(res.answer).toBe('ORION_MULTIPLIER=19, PDF_OFFSET=12');
      expect(ingestedSnapshots.sort()).toEqual([
        'sample-repo/docs/guide.md',
        'sample-repo/docs/spec.pdf',
        'sample-repo/src/mod.ts',
      ]);
      // Sensitive .env and binary logo.bin were skipped
      expect(store.has('sample-repo/.env')).toBe(false);
      expect(store.has('sample-repo/assets/logo.bin')).toBe(false);
      // Rich document PDF was converted to Markdown via anydoc
      expect(store.get('sample-repo/docs/spec.pdf').lines.join('\n')).toContain('PDF_OFFSET = 12');
      // Root KV prefix cache: Step 0 and Step 1 ### Documents section is byte-identical!
      expect(step0DocHeader).toBe('### Documents\n(no documents loaded)');
      expect(step1DocHeader).toBe(step0DocHeader);
      // Newly added documents are surfaced in the dynamic tail under ### Newly Added Documents
      expect(step1UserPrompt).toContain('### Newly Added Documents');
      expect(step1UserPrompt).toContain('sample-repo/src/mod.ts');
      expect(step1UserPrompt).toContain('sample-repo/docs/spec.pdf');

      // Verify list_documents prefix filtering
      const listTool = createListDocumentsTool();
      const docsOut = await listTool.execute(
        { prefix: 'sample-repo/docs' },
        { store, usage: new UsageTracker(), depth: 0, agentName: 'root', step: 0, emit: () => {} },
      );
      expect(docsOut).toContain('sample-repo/docs/guide.md');
      expect(docsOut).toContain('sample-repo/docs/spec.pdf');
      expect(docsOut).not.toContain('sample-repo/src/mod.ts');
    } finally {
      setAnydocForTest(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('attributes parallel sub-agent events with parent, scope, and step, and isolates parallel specialists in buildRunModel', async () => {
    const store = new ContextStore();
    store.add('ALPHA_VAL = 101', { id: 'pkg/alpha.ts' });
    store.add('BETA_VAL = 202', { id: 'pkg/beta.ts' });

    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return `<motivation>Spawn parallel specialists for pkg/alpha.ts and pkg/beta.ts</motivation><tool_call>${JSON.stringify({
          name: 'branch',
          arguments: {
            tasks: [
              { scope: 'pkg/alpha.ts', task: 'Read ALPHA_VAL in pkg/alpha.ts' },
              { scope: 'pkg/beta.ts', task: 'Read BETA_VAL in pkg/beta.ts' },
            ],
          },
        })}</tool_call>`;
      }
      return '<folding>{"range":[0,0],"summary":"ALPHA_VAL=101, BETA_VAL=202"}</folding><motivation>Done</motivation><answer>303</answer>';
    });

    const branch = new ScriptedLLM(async (req) => {
      const user = req.messages[1]?.content ?? '';
      const isAlpha = user.includes('pkg/alpha.ts');
      const docId = isAlpha ? 'pkg/alpha.ts' : 'pkg/beta.ts';
      if (/Step 0\./.test(user)) {
        return `<motivation>Read ${docId}</motivation><tool_call>${JSON.stringify({
          name: 'read',
          arguments: { document: docId, start_line: 1, end_line: 1 },
        })}</tool_call>`;
      }
      return `<folding>{"range":[0,0],"summary":"Read ${docId}"}</folding><motivation>Answer</motivation><answer>${isAlpha ? 'ALPHA_VAL = 101' : 'BETA_VAL = 202'}</answer>`;
    });

    const rawEvents: Array<{ seq: number; at: number; event: AgentEvent }> = [];
    const raf = new RecursiveAgentFold({
      rootLLM: root,
      branchLLM: branch,
      store,
      onEvent: (event) => {
        rawEvents.push({ seq: rawEvents.length + 1, at: Date.now(), event });
      },
    });

    const res = await raf.run('Sum ALPHA_VAL and BETA_VAL');
    expect(res.answer).toBe('303');

    const subRunStarts = rawEvents
      .map((e) => e.event)
      .filter((e): e is Extract<AgentEvent, { type: 'run_start' }> => e.type === 'run_start' && e.depth === 1);
    expect(subRunStarts.length).toBe(2);
    expect(subRunStarts.every((e) => e.parent === 'root')).toBe(true);
    expect(subRunStarts.map((e) => e.scope).sort()).toEqual(['pkg/alpha.ts', 'pkg/beta.ts']);

    const buildRunModel = await loadClientBuildRunModel();
    const model = buildRunModel({
      id: 'run-1',
      status: 'done',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      events: rawEvents,
    });
    expect(model.agents.length).toBe(3);
    const rootAgent = model.agents[0];
    expect(rootAgent?.name).toBe('root');
    expect(rootAgent?.childAgentIds.length).toBe(2);
    const branchTool = rootAgent?.steps[0]?.tools.find((t) => t.name === 'branch');
    expect(branchTool?.childAgentIds.length).toBe(2);

    const sub1 = model.agents[1];
    const sub2 = model.agents[2];
    expect(sub1?.parentId).toBe(rootAgent?.id);
    expect(sub2?.parentId).toBe(rootAgent?.id);
    expect(sub1?.steps.length).toBe(2);
    expect(sub2?.steps.length).toBe(2);
    expect(sub1?.steps[0]?.tools[0]?.name).toBe('read');
    expect(sub2?.steps[0]?.tools[0]?.name).toBe('read');
  });
});

describe('externally driven step API', () => {
  it('yields one tool step, accepts the native observation, then yields the answer', async () => {
    const store = new ContextStore();
    store.add('line 1: the passcode is 7341', { id: 'ctx', title: 'ctx' });
    const events: AgentEvent[] = [];
    const llm = new ScriptedLLM((_req, index) =>
      index === 0
        ? '<motivation>locate the passcode</motivation><tool_call>{"name":"raf_grep","arguments":{"pattern":"passcode"}}</tool_call>'
        : '<folding>{"range":[0,0],"summary":"grep found the passcode at line 1"}</folding><answer>7341</answer>',
    );
    const raf = new RecursiveAgentFold({
      rootLLM: llm,
      store,
      maxDepth: 0,
      toolNamePrefix: 'raf_',
      onEvent: (event) => events.push(event),
    });

    raf.begin('What is the passcode?');
    const first = await raf.next();
    expect(first.kind).toBe('tool');
    if (first.kind !== 'tool') throw new Error('expected a tool step');
    expect(first.action.name).toBe('raf_grep');
    expect(first.reasoning).toBeUndefined();
    expect(events.some((event) => event.type === 'tool_call' && event.action.name === 'raf_grep')).toBe(true);

    raf.submit('L1: the passcode is 7341');
    const second = await raf.next();
    expect(second.kind).toBe('answer');
    if (second.kind !== 'answer') throw new Error('expected an answer step');
    expect(second.answer).toBe('7341');
    expect(second.result.terminated).toBe('answer');
    expect(second.result.steps).toBe(2);

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run_start');
    expect(types.includes('step_start')).toBe(true);
    expect(types.includes('tool_result')).toBe(true);
    expect(types.includes('answer')).toBe(true);
    expect(types[types.length - 1]).toBe('run_end');

    const toolResult = events.find((event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result');
    expect(toolResult?.name).toBe('raf_grep');
    expect(toolResult?.observation).toContain('7341');
  });
  it('keeps tool guidance and routing priority for raf_-prefixed tools when host read/grep extraTools exist', async () => {
    const systemPrompts: string[] = [];
    const llm = new ScriptedLLM((req) => {
      systemPrompts.push(req.messages[0]?.content ?? '');
      return '<answer>ok</answer>';
    });
    const hostTool = (name: string) => ({
      name,
      description: `Host ${name} tool`,
      parameters: { type: 'object' },
      execute: async () => '',
    });
    const raf = new RecursiveAgentFold({
      rootLLM: llm,
      queryLLM: llm,
      store: new ContextStore(),
      toolNamePrefix: 'raf_',
      extraTools: [hostTool('read'), hostTool('grep')],
    });

    const res = await raf.run('Summarize the workspace');
    expect(res.answer).toBe('ok');
    const system = systemPrompts[0] ?? '';
    expect(system).toContain('- **raf_llm_query**:');
    expect(system).toContain('- **raf_branch**:');
    expect(system).toContain('- **raf_search**:');
    expect(system).toContain('Tool Routing Priority');
    expect(system).toContain('- **raf_read**:');
    expect(system).toContain('- **raf_grep**:');
    expect(system).not.toContain('- **read**:');
    expect(system).not.toContain('- **grep**:');
  });

  it('links child specialist agents to a prefixed raf_branch tool call in buildRunModel', async () => {
    const store = new ContextStore();
    store.add('ORION_SEED = 55', { id: 'pkg/orion.ts' });

    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return `<motivation>Delegate pkg/orion.ts to a specialist</motivation><tool_call>${JSON.stringify({
          name: 'raf_branch',
          arguments: { scope: 'pkg/orion.ts', task: 'Read ORION_SEED in pkg/orion.ts' },
        })}</tool_call>`;
      }
      return '<folding>{"range":[0,0],"summary":"ORION_SEED = 55."}</folding><motivation>Done</motivation><answer>ORION_SEED = 55</answer>';
    });

    const branch = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      if (/Step 0\./.test(user)) {
        return `<motivation>Read the seed line</motivation><tool_call>${JSON.stringify({
          name: 'read',
          arguments: { document: 'pkg/orion.ts', start_line: 1, end_line: 1 },
        })}</tool_call>`;
      }
      return '<folding>{"range":[0,0],"summary":"ORION_SEED = 55."}</folding><motivation>Answer</motivation><answer>ORION_SEED = 55</answer>';
    });

    const rawEvents: Array<{ seq: number; at: number; event: AgentEvent }> = [];
    const raf = new RecursiveAgentFold({
      rootLLM: root,
      branchLLM: branch,
      store,
      toolNamePrefix: 'raf_',
      onEvent: (event) => {
        rawEvents.push({ seq: rawEvents.length + 1, at: Date.now(), event });
      },
    });

    const res = await raf.run('Read ORION_SEED');
    expect(res.answer).toBe('ORION_SEED = 55');

    const buildRunModel = await loadClientBuildRunModel();
    const model = buildRunModel({
      id: 'run-1',
      status: 'done',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      events: rawEvents,
    });
    expect(model.agents.length).toBe(2);
    const rootAgent = model.agents[0];
    expect(rootAgent?.name).toBe('root');
    const sub = model.agents[1];
    expect(sub?.parentId).toBe(rootAgent?.id);
    const branchTool = rootAgent?.steps[0]?.tools.find((tool) => tool.name === 'raf_branch');
    expect(branchTool?.childAgentIds.length).toBe(1);
    expect(branchTool?.childAgentIds[0]).toBe(sub?.id);
  });

  it('read overrides accept standard DSH parameters (file_path, offset, limit) and auto-ingest missing workspace files on the fly', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-auto-ingest-read-'));
    try {
      await mkdir(join(tmpDir, 'src'), { recursive: true });
      await writeFile(
        join(tmpDir, 'src/service.ts'),
        [
          'export const EXPORT_TOKEN = "ORION-9000";',
          'export function getToken(): string {',
          '  return EXPORT_TOKEN;',
          '}',
          'export const VERSION = 42;',
        ].join('\n'),
        'utf8',
      );

      const store = new ContextStore();
      const llm = new ScriptedLLM((_req, idx) =>
        idx === 0
          ? '<motivation>Read src/service.ts using standard DSH read arguments</motivation><tool_call>{"name":"read","arguments":{"file_path":"src/service.ts","offset":1,"limit":3}}</tool_call>'
          : '<folding>{"range":[0,0],"summary":"src/service.ts defines EXPORT_TOKEN = ORION-9000"}</folding><motivation>Done</motivation><answer>ORION-9000</answer>',
      );
      const raf = new RecursiveAgentFold({
        rootLLM: llm,
        store,
        ingest: { cwd: tmpDir },
        maxDepth: 0,
      });

      const res = await raf.run('What is EXPORT_TOKEN in src/service.ts?');
      expect(res.answer).toBe('ORION-9000');
      expect(store.has('src/service.ts')).toBe(true);
      const readTool = raf.toolsFor(0).find((t) => t.name === 'read');
      const out = await readTool?.execute(
        { file_path: 'src/service.ts', offset: 1, limit: 2 },
        { store, usage: raf.usage, depth: 0, agentName: 'root', step: 0, emit: () => {}, board: raf.board },
      );
      expect(out).toContain('src/service.ts lines 1-2 of 5');
      expect(out).toContain('1| export const EXPORT_TOKEN = "ORION-9000";');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('grep, outline, search, and tally accept path parameter and auto-ingest workspace files/directories', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-auto-ingest-dir-'));
    try {
      await mkdir(join(tmpDir, 'src'), { recursive: true });
      await writeFile(
        join(tmpDir, 'src/service.ts'),
        [
          'export const EXPORT_TOKEN = "ORION-9000";',
          'export function computeAlpha(): number {',
          '  return 77;',
          '}',
        ].join('\n'),
        'utf8',
      );

      const store = new ContextStore();
      const llm = new ScriptedLLM(() => '<answer>ok</answer>');
      const raf = new RecursiveAgentFold({
        rootLLM: llm,
        store,
        ingest: { cwd: tmpDir },
        maxDepth: 0,
      });
      const ctx = { store, usage: raf.usage, depth: 0, agentName: 'root', step: 0, emit: () => {}, board: raf.board };
      const tools = new Map(raf.toolsFor(0).map((t) => [t.name, t]));

      const grepOut = await tools.get('grep')?.execute({ pattern: 'EXPORT_TOKEN', path: 'src' }, ctx);
      expect(grepOut).toContain('src/service.ts:1| export const EXPORT_TOKEN = "ORION-9000";');

      const outlineOut = await tools.get('outline')?.execute({ path: 'src/service.ts' }, ctx);
      expect(outlineOut).toContain('L2: export function computeAlpha(): number {');

      const searchOut = await tools.get('search')?.execute({ query: 'computeAlpha', path: 'src/service.ts' }, ctx);
      expect(searchOut).toContain('src/service.ts:L1-4');

      const tallyOut = await tools.get('tally')?.execute({ pattern: 'export (const|function)', path: 'src' }, ctx);
      expect(tallyOut).toContain('1\tconst');
      expect(tallyOut).toContain('1\tfunction');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('AgentFoldAgent resolves accidental raf_/ref_ prefixes and subagent/task aliases to unprefixed RAF tools', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-prefix-resolve-'));
    try {
      await writeFile(join(tmpDir, 'notes.md'), '# Notes\nSECRET_KEY = 31415\n', 'utf8');
      const store = new ContextStore();
      const root = new ScriptedLLM((req) => {
        const user = req.messages[1]?.content ?? '';
        const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
        if (step === 0) {
          return `<motivation>Load notes.md via accidental ref_add_document prefix</motivation><tool_call>${JSON.stringify({
            name: 'ref_add_document',
            arguments: { path: 'notes.md' },
          })}</tool_call>`;
        }
        if (step === 1) {
          return `<motivation>Read notes.md via accidental raf_read prefix</motivation><tool_call>${JSON.stringify({
            name: 'raf_read',
            arguments: { file_path: 'notes.md', offset: 1, limit: 5 },
          })}</tool_call>`;
        }
        if (step === 2) {
          return `<folding>{"range":[0,1],"summary":"Loaded and read notes.md"}</folding><motivation>Delegate via subagent alias</motivation><tool_call>${JSON.stringify({
            name: 'subagent',
            arguments: { scope: 'notes.md', prompt: 'Verify SECRET_KEY in notes.md' },
          })}</tool_call>`;
        }
        return '<folding>{"range":[2,2],"summary":"Verified SECRET_KEY = 31415"}</folding><motivation>Done</motivation><answer>31415</answer>';
      });
      const branch = new ScriptedLLM(() => '<motivation>Return verified key</motivation><answer>SECRET_KEY = 31415</answer>');
      const events: AgentEvent[] = [];
      const raf = new RecursiveAgentFold({
        rootLLM: root,
        branchLLM: branch,
        store,
        ingest: { cwd: tmpDir },
        onEvent: (ev) => events.push(ev),
      });

      const res = await raf.run('Find SECRET_KEY');
      expect(res.answer).toBe('31415');
      const calledNames = events
        .filter((e): e is Extract<AgentEvent, { type: 'tool_call' }> => e.type === 'tool_call' && e.agent === 'root')
        .map((e) => e.action.name);
      expect(calledNames).toEqual(['add_document', 'read', 'branch']);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('buildRunModel in client.js links child specialist agents to unprefixed branch tool calls', async () => {
    const store = new ContextStore();
    store.add('NOVA_KEY = 88', { id: 'pkg/nova.ts' });

    const root = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return `<motivation>Delegate pkg/nova.ts to a specialist</motivation><tool_call>${JSON.stringify({
          name: 'branch',
          arguments: { scope: 'pkg/nova.ts', task: 'Read NOVA_KEY in pkg/nova.ts' },
        })}</tool_call>`;
      }
      return '<folding>{"range":[0,0],"summary":"NOVA_KEY = 88."}</folding><motivation>Done</motivation><answer>NOVA_KEY = 88</answer>';
    });

    const branch = new ScriptedLLM(() => '<motivation>Answer</motivation><answer>NOVA_KEY = 88</answer>');
    const rawEvents: Array<{ seq: number; at: number; event: AgentEvent }> = [];
    const raf = new RecursiveAgentFold({
      rootLLM: root,
      branchLLM: branch,
      store,
      onEvent: (event) => {
        rawEvents.push({ seq: rawEvents.length + 1, at: Date.now(), event });
      },
    });

    const res = await raf.run('Read NOVA_KEY');
    expect(res.answer).toBe('NOVA_KEY = 88');

    const buildRunModel = await loadClientBuildRunModel();
    const runRecord = {
      id: 'run-unprefixed',
      status: 'done',
      startedAt: Date.now() - 1000,
      endedAt: Date.now(),
      events: rawEvents,
    };
    expect(buildRunModel.runHasBranch?.(runRecord, { scope: 'pkg/nova.ts', task: 'Read NOVA_KEY in pkg/nova.ts' })).toBe(true);
    const model = buildRunModel(runRecord);
    expect(model.agents.length).toBe(2);
    const rootAgent = model.agents[0];
    const sub = model.agents[1];
    const branchTool = rootAgent?.steps[0]?.tools.find((tool) => tool.name === 'branch');
    expect(branchTool?.childAgentIds).toEqual([sub?.id]);
  });
});

describe('host tool-name prefix', () => {
  it('prefixes built-in tools at every depth so branch agents cannot shadow native names', () => {
    const store = new ContextStore();
    const llm = new ScriptedLLM(() => '<answer>ok</answer>');
    const raf = new RecursiveAgentFold({
      rootLLM: llm,
      store,
      maxDepth: 2,
      toolNamePrefix: 'raf_',
    });
    const rootNames = raf.toolsFor(0).map((tool) => tool.name);
    const branchNames = raf.toolsFor(1).map((tool) => tool.name);
    expect(rootNames).toContain('raf_read');
    expect(branchNames).toContain('raf_read');
    expect(branchNames).toContain('raf_branch');
    expect(branchNames).not.toContain('read');
  });
});

describe('answer validation', () => {
  it('rejects a serialized folding directive used as the final answer', async () => {
    const llm = new ScriptedLLM((_req, index) =>
      index === 0
        ? '<answer>{"range":[1,1],"summary":"oops"}</answer>'
        : '<answer>real answer</answer>',
    );
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [],
      store: new ContextStore(),
      maxFormatRetries: 2,
      onEvent: (event) => events.push(event),
    });
    const result = await agent.run('What is the result?');
    expect(result.answer).toBe('real answer');
    expect(result.formatIssues).toBeGreaterThan(0);
    const formatErrors = events.filter((event): event is Extract<AgentEvent, { type: 'format_error' }> => event.type === 'format_error');
    expect(formatErrors.some((event) => event.errors.some((message) => message.includes('folding directive')))).toBe(true);
  });
});

describe('DSH Plugin PTC bypass, multi-turn root continuity, and live file refresh', () => {
  it('Test 1: bypasses PTC only-run_code restriction via selectExecutor and auto-populates missing bash description from motivation', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-ptc-bypass-'));
    const prevProfileDir = process.env.DSH_PROFILE_DIR;
    process.env.DSH_PROFILE_DIR = tmpDir;
    try {
      const notePath = join(tmpDir, 'note.txt');
      await writeFile(notePath, 'RENDER_STATUS = READY\n', 'utf8');
      await mkdir(join(tmpDir, 'raf-engine'), { recursive: true });
      await writeFile(
        join(tmpDir, 'raf-engine', 'state.json'),
        JSON.stringify({
          version: 1,
          defaultEngine: 'raf',
          engines: { 'session-ptc-1': 'raf' },
          settings: { depth: 2, reserve: 0.3, concurrency: 4 },
        }),
        'utf8',
      );

      // Dynamic import exercises the untyped @raf/dsh-plugin ESM module boundary outside packages/engine rootDir.
      const dshPlugin = (await import('../../dsh-plugin/index.js' as string)) as {
        apply: (ctx: unknown) => void;
      };

      interface RegisteredTool {
        name: string;
        description: string;
        parameters?: Record<string, unknown>;
        output?: { render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
        execute: (args: Record<string, unknown>, exec?: { agent?: unknown; signal?: AbortSignal }) => Promise<unknown>;
      }

      const registeredTools = new Map<string, RegisteredTool>();
      const bashCalls: Array<Record<string, unknown>> = [];
      registeredTools.set('bash', {
        name: 'bash',
        description: 'Execute shell command',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['command', 'description'],
        },
        async execute(args) {
          if (typeof args.description !== 'string' || args.description.trim() === '') {
            throw new Error('invalid arguments: missing required property "description"');
          }
          bashCalls.push(args);
          return 'OK_RENDERED';
        },
      });

      // Simulated DSH ExecutionPipeline & PtcExecutor that rejects non-run_code tools unless source omits reject
      class MockExecutionPipeline {
        readonly ctx: unknown;
        readonly source: {
          get: (name: string, scope: unknown, toolSet?: unknown) => RegisteredTool | undefined;
          reject?: (name: string) => Error;
        };
        constructor(
          ctx: unknown,
          source: {
            get: (name: string, scope: unknown, toolSet?: unknown) => RegisteredTool | undefined;
            reject?: (name: string) => Error;
          },
        ) {
          this.ctx = ctx;
          this.source = source;
        }
        async execute(batch: {
          calls: Array<{ id: string; name: string; arguments: string }>;
          agent?: unknown;
          signal?: AbortSignal;
        }) {
          const results = [];
          for (const call of batch.calls) {
            const tool = this.source.get(call.name, batch.agent);
            if (!tool) {
              const err =
                this.source.reject?.(call.name) ??
                new Error(`unknown tool "${call.name}"`);
              results.push({
                callId: call.id,
                name: call.name,
                result: {
                  isError: true,
                  content: [{ type: 'text', text: err.message }],
                  error: { message: err.message },
                },
              });
              continue;
            }
            try {
              const parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
              const val = await tool.execute(parsedArgs, { agent: batch.agent, signal: batch.signal });
              results.push({
                callId: call.id,
                name: call.name,
                result: {
                  isError: false,
                  content: [{ type: 'text', text: String(val) }],
                  value: val,
                },
              });
            } catch (e) {
              const msg = (e as Error).message;
              results.push({
                callId: call.id,
                name: call.name,
                result: {
                  isError: true,
                  content: [{ type: 'text', text: msg }],
                  error: { message: msg },
                },
              });
            }
          }
          return { results };
        }
      }

      const ptcExecutor = {
        ctx: {},
        pipeline: new MockExecutionPipeline(
          {},
          {
            get: (name) => (name === 'run_code' ? registeredTools.get('run_code') : undefined),
            reject: (name) =>
              new Error(
                `unknown tool "${name}": only \`run_code\` is callable directly — call \`${name}\` from inside a \`run_code\` program instead`,
              ),
          },
        ),
        async execute(batch: {
          calls: Array<{ id: string; name: string; arguments: string }>;
          agent?: unknown;
          signal?: AbortSignal;
        }) {
          return this.pipeline.execute(batch);
        },
      };

      const mockAgent = {
        id: 'session-ptc-1',
        session: {
          id: 'session-ptc-1',
          header: { cwd: tmpDir },
          log: [{ type: 'turn/start', data: { turn: 1 } }],
          append: () => {},
        },
      };

      const readyEmitter = new EventEmitter();
      const toolsReady = once(readyEmitter, 'ready');
      const mockToolsService = {
        register(def: RegisteredTool) {
          registeredTools.set(def.name, def);
          if (def.name === 'branch') readyEmitter.emit('ready');
          return () => registeredTools.delete(def.name);
        },
        executable(name: string) {
          return registeredTools.get(name);
        },
        definitions() {
          return [...registeredTools.values()];
        },
        selectExecutor(_scope: unknown) {
          return ptcExecutor;
        },
        async execute(batch: {
          calls: Array<{ id: string; name: string; arguments: string }>;
          agent?: unknown;
          signal?: AbortSignal;
        }) {
          const exec = this.selectExecutor(batch.agent ?? mockAgent);
          return exec.execute(batch);
        },
      };

      let streamInterceptor: ((options: Record<string, unknown>, next: () => unknown) => AsyncIterable<Record<string, unknown>>) | undefined;
      let internalCallCount = 0;
      const mockCtx = {
        tools: mockToolsService,
        llm: {
          async *stream(_opts: Record<string, unknown>) {
            const stepIdx = internalCallCount++;
            let text: string;
            if (stepIdx === 0) {
              text =
                '<motivation>Run bash to render output PNGs</motivation>' +
                '<tool_call>{"name":"bash","arguments":{"command":"echo ok"}}</tool_call>';
            } else if (stepIdx === 1) {
              text =
                '<folding>{"range":[0,0],"summary":"bash echo ok returned OK_RENDERED."}</folding>' +
                `<motivation>Read note.txt directly</motivation>` +
                `<tool_call>${JSON.stringify({ name: 'read', arguments: { file_path: notePath } })}</tool_call>`;
            } else {
              text =
                '<folding>{"range":[1,1],"summary":"note.txt confirmed RENDER_STATUS = READY."}</folding>' +
                '<motivation>All checks complete</motivation>' +
                '<answer>DONE_WITHOUT_PTC_ERROR</answer>';
            }
            yield { type: 'text-delta', text };
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        },
        get(service: string) {
          if (service === 'tools') return mockToolsService;
          if (service === 'agents') return { get: () => mockAgent, list: () => [mockAgent] };
          if (service === 'workingDirectory') return { get: () => tmpDir };
          return undefined;
        },
        effect(fn: () => void) {
          fn();
        },
        on(event: string, handler: (options: Record<string, unknown>, next: () => unknown) => AsyncIterable<Record<string, unknown>>) {
          if (event === 'llm/stream') streamInterceptor = handler;
          return () => {};
        },
        inject() {},
      };

      dshPlugin.apply(mockCtx);
      await toolsReady;
      if (streamInterceptor === undefined) throw new Error('expected streamInterceptor to be registered');
      const messages: Array<Record<string, unknown>> = [
        {
          id: 'msg-user-1',
          role: 'user',
          content: [{ type: 'text', text: 'Render the diagrams and verify note.txt' }],
          source: { kind: 'user' },
        },
      ];

      let finalAnswer = '';
      for (let loop = 0; loop < 5; loop++) {
        const stream = streamInterceptor(
          {
            sessionId: 'session-ptc-1',
            provider: 'mock',
            model: 'mock-root',
            messages,
          },
          () => {
            throw new Error('should not fall through to default stream');
          },
        );
        let emittedToolCall: { id: string; name: string; arguments: string } | undefined;
        for await (const chunk of stream) {
          if (chunk.type === 'block-end') {
            const block = chunk.block as { type: string; id?: string; name?: string; arguments?: string; text?: string };
            if (block.type === 'tool-call' && block.id && block.name) {
              emittedToolCall = { id: block.id, name: block.name, arguments: block.arguments ?? '{}' };
            } else if (block.type === 'text' && block.text) {
              finalAnswer = block.text;
            }
          }
        }
        if (!emittedToolCall) break;
        // Execute tool call through DSH ToolsService.execute (which calls selectExecutor)
        const batchRes = await mockToolsService.execute({
          calls: [emittedToolCall],
          agent: mockAgent,
        });
        const firstRes = batchRes.results[0];
        expect(firstRes?.result.isError).toBe(false);
        const toolText = firstRes?.result.content[0]?.text ?? '';
        expect(toolText).not.toContain('only `run_code` is callable directly');
        messages.push({
          id: `msg-tool-${loop}`,
          role: 'tool',
          toolCallId: emittedToolCall.id,
          isError: firstRes?.result.isError ?? false,
          content: firstRes?.result.content ?? [],
        });
      }

      expect(finalAnswer).toBe('DONE_WITHOUT_PTC_ERROR');
      expect(bashCalls.length).toBe(1);
      expect(bashCalls[0]?.command).toBe('echo ok');
      expect(bashCalls[0]?.description).toBe('Run bash to render output PNGs');
      const persisted = JSON.parse(
        await readFile(join(tmpDir, 'raf-engine', 'sessions', 'session-ptc-1.json'), 'utf8'),
      ) as {
        version?: number;
        rootState?: { blocks?: unknown[] };
        initialQuestion?: string;
        turnStatus?: string;
        board?: { entries?: unknown[] };
        docs?: Record<string, { text?: string }>;
      };
      expect(persisted.version).toBe(2);
      expect(Array.isArray(persisted.rootState?.blocks)).toBe(true);
      expect(persisted.initialQuestion).toContain('Render the diagrams');
      expect(persisted.turnStatus).toBe('done');
      expect(Array.isArray(persisted.board?.entries)).toBe(true);
      expect(persisted.docs).toBeTypeOf('object');
    } finally {
      if (prevProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfileDir;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Test 2: runs past 32 steps without premature FORCE_ANSWER and preserves FoldState + KV prefix across follow-up turns', async () => {
    const store = new ContextStore();
    store.add('MODULE_ALPHA = 42\nMODULE_BETA = 58', { id: 'spec.md', title: 'spec.md' });

    const initialManifest = store.manifest();
    const initialDocIds = new Set(store.list().map((d) => d.id));
    const totalToolStepsTurn1 = 35;
    let turn1Prompts: string[] = [];

    const rootTurn1 = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      turn1Prompts.push(user);
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step < totalToolStepsTurn1) {
        const foldTag =
          step > 0
            ? `<folding>{"range":[${step - 1},${step - 1}],"summary":"Completed verification step ${step - 1}."}</folding>`
            : '';
        return `${foldTag}<motivation>Step ${step} check</motivation><tool_call>{"name":"calculator","arguments":{"expression":"${step} + 1"}}</tool_call>`;
      }
      return `<folding>{"range":[0,${totalToolStepsTurn1 - 1}],"summary":"Completed all 35 verification steps; MODULE_ALPHA=42, MODULE_BETA=58, sum=100."}</folding><motivation>All 35 steps verified</motivation><answer>Turn 1 complete: sum = 100</answer>`;
    });

    const raf1 = new RecursiveAgentFold({
      rootLLM: rootTurn1,
      store,
      rootMaxSteps: Number.POSITIVE_INFINITY,
      maxDepth: 0,
    });
    const initialQuestion = 'Verify all 35 steps and compute MODULE_ALPHA + MODULE_BETA';
    raf1.begin(initialQuestion, { initialManifest, initialDocIds });

    let turn1Result;
    for (;;) {
      const s = await raf1.next();
      if (s.kind === 'tool') {
        raf1.submit(String(s.step + 1));
      } else {
        turn1Result = s.result;
        break;
      }
    }

    expect(turn1Result.terminated).toBe('answer');
    expect(turn1Result.steps).toBe(36);
    expect(turn1Result.answer).toBe('Turn 1 complete: sum = 100');
    expect(turn1Prompts.every((p) => !p.includes('Step limit reached'))).toBe(true);

    // Add a new document between Turn 1 and Turn 2 to verify static initialManifest preservation
    store.add('EXTRA_DELTA = 7', { id: 'extra.md', title: 'extra.md' });

    let turn2UserPrompt = '';
    const rootTurn2 = new ScriptedLLM((req) => {
      turn2UserPrompt = req.messages[1]?.content ?? '';
      return '<motivation>Continue from folded Turn 1 state</motivation><answer>Turn 2 complete: 100 + 7 = 107</answer>';
    });

    const raf2 = new RecursiveAgentFold({
      rootLLM: rootTurn2,
      store,
      rootMaxSteps: Number.POSITIVE_INFINITY,
      maxDepth: 0,
    });
    raf2.begin(initialQuestion, {
      initialState: turn1Result.state,
      followUpQuestion: 'продолжи!',
      initialManifest,
      initialDocIds,
    });
    const turn2Step = await raf2.next();
    expect(turn2Step.kind).toBe('answer');
    if (turn2Step.kind === 'answer') {
      expect(turn2Step.answer).toBe('Turn 2 complete: 100 + 7 = 107');
    }

    // Verify byte-identical prefix (### Documents + ### Task) between Turn 1 Step 0 and Turn 2
    const turn1Prefix = turn1Prompts[0]?.split('### Previous Steps')[0] ?? '';
    const turn2Prefix = turn2UserPrompt.split('### Previous Steps')[0] ?? '';
    expect(turn2Prefix).toBe(turn1Prefix);
    // Verify Turn 1 folded blocks are preserved in Turn 2
    expect(turn2UserPrompt).toContain('**[Compressed Step 0]** Completed verification step 0.');
    expect(turn2UserPrompt).toContain('**[Compressed Step 34]** Completed all 35 verification steps');
    expect(turn2UserPrompt).toContain('**[Compressed Step 35]** Completed initial task; result: Turn 1 complete: sum = 100');
    expect(turn2UserPrompt).toContain('### Newly Added Documents');
    expect(turn2UserPrompt).toContain('extra.md');
    expect(turn2UserPrompt).toContain('### Follow-up Question\nпродолжи!');
  });

  it('Test 3: preserves leading underscores in doc IDs and refreshes live workspace files modified on disk', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-live-refresh-'));
    try {
      await mkdir(join(tmpDir, 'img'), { recursive: true });
      const scriptPath = join(tmpDir, 'img', '_p4.py');
      await writeFile(scriptPath, 'PANEL_COUNT = 1\nSTATUS = "DRAFT"', 'utf8');

      const store = new ContextStore();
      const raf = new RecursiveAgentFold({
        rootLLM: new ScriptedLLM(() => '<answer>ok</answer>'),
        store,
        ingest: { cwd: tmpDir },
        maxDepth: 0,
      });
      const readTool = raf.toolsFor(0).find((t) => t.name === 'read');
      if (readTool === undefined) throw new Error('expected read tool');
      const toolCtx = {
        store,
        usage: raf.usage,
        depth: 0,
        agentName: 'root',
        step: 0,
        emit: () => {},
        board: raf.board,
      };

      const firstRead = await readTool.execute({ file_path: 'img/_p4.py', start_line: 1, end_line: 5 }, toolCtx);
      expect(firstRead).toContain('img/_p4.py lines 1-2 of 2');
      expect(firstRead).toContain('STATUS = "DRAFT"');
      expect(store.has('img/_p4.py')).toBe(true);

      // Modify img/_p4.py on disk (simulating write/edit/bash)
      await writeFile(scriptPath, 'PANEL_COUNT = 4\nSTATUS = "FINAL_300DPI"\nEXTRA_LINE = True', 'utf8');

      const secondRead = await readTool.execute({ file_path: 'img/_p4.py', start_line: 1, end_line: 5 }, toolCtx);
      expect(secondRead).toContain('PANEL_COUNT = 4');
      expect(secondRead).toContain('STATUS = "FINAL_300DPI"');
      expect(secondRead).not.toContain('STATUS = "DRAFT"');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('Test 4: does not misparse literal <answer> or <think> tags inside <folding> summary as premature termination', async () => {
    const store = new ContextStore();
    store.add('Protocol format: optional <think>...</think>, <folding>...</folding>, <motivation>...</motivation>, <answer>...</answer>\nFINAL_SECRET = 9001', {
      id: 'docs/ARCHITECTURE.md',
      title: 'docs/ARCHITECTURE.md',
    });

    const llm = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return '<motivation>Read line 1 of docs/ARCHITECTURE.md</motivation><tool_call>{"name":"read","arguments":{"document":"docs/ARCHITECTURE.md","start_line":1,"end_line":1}}</tool_call>';
      }
      if (step === 1) {
        // Summary contains literal <think>…</think> and <answer>Subagent complete: cat 50, dog 50</answer>
        return '<folding>{"range":[0,0],"summary":"Step 0 read ARCHITECTURE.md L1: optional <think>…</think>, <tool_call>{}</tool_call>, or <answer>Subagent complete: cat 50, dog 50</answer>."}</folding><motivation>Now read line 2 for FINAL_SECRET</motivation><tool_call>{"name":"read","arguments":{"document":"docs/ARCHITECTURE.md","start_line":2,"end_line":2}}</tool_call>';
      }
      return '<folding>{"range":[1,1],"summary":"Read line 2: FINAL_SECRET = 9001."}</folding><motivation>Complete</motivation><answer>FINAL_SECRET = 9001</answer>';
    });

    const raf = new RecursiveAgentFold({
      rootLLM: llm,
      store,
      maxDepth: 0,
    });
    const res = await raf.run('Find FINAL_SECRET in docs/ARCHITECTURE.md');
    expect(res.terminated).toBe('answer');
    expect(res.steps).toBe(3);
    expect(res.answer).toBe('FINAL_SECRET = 9001');
  });
});

describe('step usage, invalid cap, and truncated tool calls', () => {
  it('reports the last attempt usage separately from the accumulated step usage', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<{ readonly text: string; readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } }> = [
      {
        text: 'not the protocol',
        usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0 },
      },
      {
        text: '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
        usage: { promptTokens: 200, completionTokens: 20, cachedTokens: 0 },
      },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const agent = new AgentFoldAgent({ llm, tools: [createGrepTool()], store, maxFormatRetries: 1 });
    agent.begin('find seed');
    const step = await agent.next();
    expect(step.kind).toBe('tool');
    if (step.kind !== 'tool') throw new Error(`expected tool step, got ${step.kind}`);
    expect(step.usage.promptTokens).toBe(300);
    expect(step.usage.completionTokens).toBe(30);
    expect(step.lastUsage?.promptTokens).toBe(200);
    expect(step.lastUsage?.completionTokens).toBe(20);
  });

  it('terminates after maxInvalidSteps instead of looping forever', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const llm = new ScriptedLLM(() => 'not the protocol');
    const agent = new AgentFoldAgent({ llm, tools: [], store, maxFormatRetries: 0, maxInvalidSteps: 1 });
    const res = await agent.run('find seed');
    expect(res.terminated).toBe('error');
    expect(res.error).toContain('format failure limit');
    expect(llm.calls).toHaveLength(2);
  });

  it('resets the invalid-step counter after a valid step', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<string | { readonly text: string; readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number } }> = [
      'not the protocol',
      '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
      'not the protocol again',
      '<answer>seed</answer>',
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      maxFormatRetries: 0,
      maxInvalidSteps: 1,
    });
    const res = await agent.run('find seed');
    expect(res.terminated).toBe('answer');
    expect(res.answer).toBe('seed');
  });

  it('stops an alternating invalid/valid loop with a total invalid cap', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses = [
      'not the protocol',
      '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
      'not the protocol',
      '<motivation>grep seed again</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
      'not the protocol',
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      maxFormatRetries: 0,
      maxInvalidSteps: 2,
      maxInvalidTotal: 2,
    });
    const res = await agent.run('find seed');
    expect(res.terminated).toBe('error');
    expect(res.error).toContain('invalid responses total');
    expect(res.error).toContain('1 consecutive');
  });

  it('rejects a tool call cut by the output token limit', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<string | { readonly text: string; readonly finishReason: string }> = [
      {
        text: '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
        finishReason: 'length',
      },
      '<answer>seed</answer>',
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      maxFormatRetries: 1,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('find seed');
    expect(res.answer).toBe('seed');
    expect(
      events.some(
        (event) => event.type === 'format_error' && event.errors.some((error) => error.includes('output token limit')),
      ),
    ).toBe(true);
  });
});

describe('attribute-style parameter tags', () => {
  it('parses <param_name="key">value</param_name> arguments into named tool arguments', async () => {
    const { parseAgentResponse } = await import('../src/protocol/parser.js');
    const p = parseAgentResponse(
      '<motivation>count</motivation><tool_call name="grep"><param_name="pattern">Nairobi</param_name><param_name="max_matches">100</param_name></tool_call>',
      { expectFolding: false },
    );
    expect(p.errors).toEqual([]);
    expect(p.toolCall?.name).toBe('grep');
    expect(p.toolCall?.arguments).toMatchObject({ pattern: 'Nairobi' });
    expect(String(p.toolCall?.arguments.max_matches)).toBe('100');
  });
});

describe('external signal cancellation', () => {
  it('returns immediately on external abort even when the provider ignores the abort signal', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const controller = new AbortController();
    const llm: LLMClient = {
      profile: { name: 'deaf', contextWindow: 128_000, maxOutputTokens: 1024 },
      complete() {
        setTimeout(() => controller.abort(new Error('user cancelled step')), 15);
        return new Promise(() => {});
      },
    };
    const started = Date.now();
    const agent = new AgentFoldAgent({ llm, tools: [], store, signal: controller.signal });
    const res = await agent.run('find seed');
    expect(res.terminated).toBe('error');
    expect(res.error).toContain('user cancelled step');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('propagates external signal abort to a waiting LLM call', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const controller = new AbortController();
    const llm: LLMClient = {
      profile: { name: 'stalled', contextWindow: 128_000, maxOutputTokens: 1024 },
      complete(req) {
        return new Promise((_resolve, reject) => {
          const signal = req.signal;
          if (signal === undefined) {
            reject(new Error('missing signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          setTimeout(() => controller.abort(new Error('abort requested')), 15);
        });
      },
    };
    const agent = new AgentFoldAgent({ llm, tools: [], store, signal: controller.signal });
    const res = await agent.run('find seed');
    expect(res.terminated).toBe('error');
    expect(res.error).toContain('abort requested');
  });
});

describe('reasoning budget', () => {
  it('rejects a tool call that exceeds maxReasoningTokens', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<{ readonly text: string; readonly usage: { readonly promptTokens: number; readonly completionTokens: number; readonly cachedTokens: number; readonly reasoningTokens: number } }> = [
      {
        text: '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
        usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, reasoningTokens: 40_000 },
      },
      {
        text: '<answer>seed</answer>',
        usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 0, reasoningTokens: 100 },
      },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [createGrepTool()],
      store,
      maxFormatRetries: 1,
      maxReasoningTokens: 32_000,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('find seed');
    expect(res.answer).toBe('seed');
    expect(
      events.some(
        (event) => event.type === 'format_error' && event.errors.some((error) => error.includes('reasoning budget')),
      ),
    ).toBe(true);
  });

  it('does not recover a protocol tag that reasoning only quotes', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<{ readonly text: string; readonly reasoning?: string }> = [
      { text: '', reasoning: 'The error said "<tool_call> hit the output token limit". I must be shorter.' },
      { text: '<answer>seed</answer>' },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [],
      store,
      maxFormatRetries: 1,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('find seed');
    expect(res.answer).toBe('seed');
    expect(
      events.some(
        (event) => event.type === 'format_error' && event.errors.some((error) => error.includes('not valid')),
      ),
    ).toBe(false);
  });

  it('estimates reasoning tokens when the provider omits reasoning_tokens', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses: Array<{ readonly text: string; readonly reasoning?: string }> = [
      {
        text: '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
        reasoning: 'x'.repeat(2_000),
      },
      { text: '<answer>seed</answer>' },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [],
      store,
      maxFormatRetries: 1,
      maxReasoningTokens: 100,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('find seed');
    expect(res.answer).toBe('seed');
    expect(
      events.some(
        (event) => event.type === 'format_error' && event.errors.some((error) => error.includes('reasoning budget')),
      ),
    ).toBe(true);
  });

  it('rejects over-budget reasoning on a final answer too', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const responses = [
      {
        text: '<answer>seed</answer>',
        usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 0, reasoningTokens: 40_000 },
      },
      {
        text: '<answer>seed</answer>',
        usage: { promptTokens: 50, completionTokens: 5, cachedTokens: 0, reasoningTokens: 100 },
      },
    ];
    const llm = new ScriptedLLM((_req, index) => responses[Math.min(index, responses.length - 1)]!);
    const events: AgentEvent[] = [];
    const agent = new AgentFoldAgent({
      llm,
      tools: [],
      store,
      maxFormatRetries: 1,
      maxReasoningTokens: 32_000,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('find seed');
    expect(res.answer).toBe('seed');
    expect(
      events.some(
        (event) => event.type === 'format_error' && event.errors.some((error) => error.includes('reasoning budget')),
      ),
    ).toBe(true);
  });
});


describe('host crash recovery helpers', () => {
  it('does not overwrite a successful board summary with a failed follow-up', async () => {
    const board = new ResearchBoard();
    await board.runScopedBranch('lib_a', 'Study lib_a', async () => ({
      resultText: 'A=1',
      answer: 'A=1',
      state: { blocks: [{ from: 0, to: 0, summary: 'A=1' }], latest: undefined },
    }));
    const before = board.entries()[0]?.summary;
    const failed = await board.runScopedBranch(
      'lib_a',
      'Follow-up that fails',
      async () => ({ resultText: 'transport down', answer: null, state: { blocks: [], latest: undefined }, failed: true }),
    );
    expect(failed.failed).toBe(true);
    expect(board.entries()[0]?.summary).toBe(before);
    expect(board.getSpecialist('lib_a')?.latestSummary).toContain('A=1');
  });

  it('round-trips a ResearchBoard snapshot and reuses specialist memory', async () => {
    const board = new ResearchBoard();
    await board.runScopedBranch('lib_a', 'Study lib_a', async () => ({
      resultText: 'A=1',
      answer: 'A=1',
      state: { blocks: [{ from: 0, to: 0, summary: 'A=1' }], latest: undefined },
    }));
    const snapshot = board.snapshot();
    const restored = ResearchBoard.restore(
      JSON.parse(JSON.stringify(snapshot)) as ReturnType<ResearchBoard['snapshot']>,
    );
    expect(restored.entries()).toEqual(board.entries());
    expect(restored.currentRev()).toBe(board.currentRev());
    expect(restored.getSpecialist('lib_a')?.latestSummary).toBe('A=1');
    let called = false;
    const reused = await restored.runScopedBranch('lib_a', 'Study lib_a', async () => {
      called = true;
      return { resultText: 'different', answer: 'different', state: { blocks: [], latest: undefined } };
    });
    expect(reused.reused).toBe(true);
    expect(reused.result).toBe('A=1');
    expect(called).toBe(false);
  });

  it('restores a pending tool step and submits its saved observation without re-running it', async () => {
    const store = new ContextStore();
    store.add('seed line', { id: 'ctx' });
    const first = new ScriptedLLM(
      () => '<motivation>grep seed</motivation><tool_call>{"name":"grep","arguments":{"pattern":"seed"}}</tool_call>',
    );
    const agent = new AgentFoldAgent({ llm: first, tools: [createGrepTool()], store });
    agent.begin('find seed');
    const step = await agent.next();
    expect(step.kind).toBe('tool');
    const snapshot = agent.snapshot();
    const pending = agent.snapshotPending();
    if (snapshot === undefined || pending === undefined) throw new Error('missing pending state');

    const second = new ScriptedLLM(() => '<answer>recovered</answer>');
    const resumed = new AgentFoldAgent({
      llm: second,
      tools: [createGrepTool()],
      store,
      initialState: snapshot,
    });
    resumed.begin('find seed');
    resumed.restorePending(pending);
    resumed.submit('seed line');
    const answer = await resumed.next();
    expect(answer.kind).toBe('answer');
    if (answer.kind !== 'answer') throw new Error('expected answer');
    expect(answer.answer).toBe('recovered');
  });

  it('condenses an oversized prompt before the LLM call', async () => {
    const store = new ContextStore();
    const huge = 'x'.repeat(30_000);
    const llm = new ScriptedLLM(() => '<answer>ok</answer>');
    const agent = new AgentFoldAgent({
      llm,
      tools: [],
      store,
      maxPromptTokens: 6_000,
      initialState: {
        blocks: [],
        latest: {
          step: 0,
          motivation: 'inspect',
          action: { name: 'none', arguments: {} },
          observation: huge,
        },
      },
    });
    agent.begin('find seed');
    const step = await agent.next();
    expect(step.kind).toBe('answer');
    const first = llm.calls[0];
    if (first === undefined) throw new Error('missing LLM call');
    const rendered = first.messages.map((m) => m.content).join('\n');
    expect(defaultEstimator.count(rendered)).toBeLessThanOrEqual(6_000);
  });

  it('unblocks a tool that ignores its signal when external abort fires', async () => {
    const store = new ContextStore();
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const slowTool = {
      name: 'slow',
      description: 'never returns',
      parameters: { type: 'object' as const, properties: {} },
      execute: () => {
        setTimeout(() => controller.abort(new Error('tool cancelled by signal')), 15);
        return new Promise<string>(() => {});
      },
    };
    let call = 0;
    const llm = new ScriptedLLM(() => {
      call += 1;
      return call === 1
        ? '<motivation>call slow</motivation><tool_call>{"name":"slow","arguments":{}}</tool_call>'
        : '<answer>done</answer>';
    });
    const agent = new AgentFoldAgent({
      llm,
      tools: [slowTool],
      store,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });
    const res = await agent.run('call slow');
    expect(res.terminated).toBe('error');
    expect(
      events.some(
        (event) => event.type === 'tool_result' && (event.error ?? '').includes('tool cancelled by signal'),
      ),
    ).toBe(true);
  });
});

describe('hidden stored reports', () => {
  it('excludes hidden reports from generic search/grep/tally but keeps explicit access', () => {
    const store = new ContextStore();
    store.add('visible NEEDLE', { id: 'visible' });
    store.add('hidden NEEDLE', { id: 'branch_report_test', manifest: false });
    expect(store.grep('NEEDLE').perDoc).toEqual({ visible: 1 });
    expect(store.tally('NEEDLE').totalMatches).toBe(1);
    expect(store.search('NEEDLE').every((hit) => hit.docId === 'visible')).toBe(true);
    expect(store.grep('NEEDLE', { docIds: ['branch_report_test'] }).perDoc).toEqual({ branch_report_test: 1 });
  });
});


describe('DSH surface budget', () => {
  it('caps visible reasoning but keeps a marker', async () => {
    const { capVisibleReasoning } = (await import('../../dsh-plugin/index.js' as string)) as {
      capVisibleReasoning: (text: string) => string;
    };
    const capped = capVisibleReasoning('x'.repeat(20_000));
    expect(capped.length).toBeLessThan(13_000);
    expect(capped).toContain('reasoning shortened for display');
    expect(capVisibleReasoning('short')).toBe('short');
  });
});


describe('fallback answer', () => {
  it('builds a final answer from successful branch summaries', async () => {
    const { buildFallbackAnswer } = (await import('../../dsh-plugin/index.js' as string)) as {
      buildFallbackAnswer: (turn: unknown) => string | undefined;
    };
    const board = new ResearchBoard();
    board.record({ agent: 'specialist#1', kind: 'branch', scope: 'crates/aead', key: 'crates/aead', summary: 'A=1' });
    const store = new ContextStore();
    store.add('hidden', { id: 'branch_report_x', title: 'report x', manifest: false });
    const answer = buildFallbackAnswer({
      engine: { board },
      store,
      lastResultError: 'all four failed',
    });
    expect(answer).toContain('## crates/aead');
    expect(answer).toContain('A=1');
    expect(answer).toContain('all four failed');
  });
});

describe('DSH conditional plugin tool bridging & root deep-fold cache preservation', () => {
  it('bridges conditional DSH tools (web_search with { when }) to both root and branch subagents via withInitiator and tools.get fallback', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-web-search-bridge-'));
    const prevProfileDir = process.env.DSH_PROFILE_DIR;
    process.env.DSH_PROFILE_DIR = tmpDir;
    try {
      await mkdir(join(tmpDir, 'raf-engine'), { recursive: true });
      await writeFile(
        join(tmpDir, 'raf-engine', 'state.json'),
        JSON.stringify({
          version: 1,
          defaultEngine: 'raf',
          engines: { 'session-web-1': 'raf' },
          settings: { depth: 2, reserve: 0.3, concurrency: 4 },
        }),
        'utf8',
      );
      // Dynamic import exercises the untyped @raf/dsh-plugin ESM module boundary outside packages/engine rootDir.
      const dshPlugin = (await import('../../dsh-plugin/index.js' as string)) as {
        apply: (ctx: unknown) => void;
      };
      let currentInitiator: unknown;
      const seenInitiators: unknown[] = [];
      const webSearchQueries: string[] = [];
      const mockAgent = {
        id: 'session-web-1',
        session: {
          id: 'session-web-1',
          header: { cwd: tmpDir },
          snapshotEvents: () => [{ type: 'turn/start', data: { turn: 1 } }],
          append: () => {},
        },
      };
      const conditionalWebSearch = {
        name: 'web_search',
        description: 'Search the web via DeepSeek API',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        when: async () => true,
        async execute(args: Record<string, unknown>) {
          seenInitiators.push(currentInitiator);
          webSearchQueries.push(String(args.query ?? ''));
          return `WEB_RESULTS for ${String(args.query ?? '')}: ` + 'result_entry '.repeat(120);
        },
      };
      const registered = new Map<string, typeof conditionalWebSearch>([['web_search', conditionalWebSearch]]);
      const readyEmitter = new EventEmitter();
      const toolsReady = once(readyEmitter, 'ready');
      const baseExecutor = {
        pipeline: {
          source: {
            get: () => undefined,
          },
        },
      };
      const mockToolsService = {
        register(def: typeof conditionalWebSearch) {
          registered.set(def.name, def);
          if (def.name === 'branch') readyEmitter.emit('ready');
          return () => registered.delete(def.name);
        },
        // Simulate @deepseek-ai/dsh-tools: executable returns undefined when toolSet is omitted for conditional { when } tools
        executable(name: string, _scope: unknown, toolSet?: Set<string>) {
          const def = registered.get(name);
          if (!def) return undefined;
          if ('when' in def && def.when !== undefined) {
            return toolSet?.has(name) ? def : undefined;
          }
          return def;
        },
        get(name: string) {
          return registered.get(name);
        },
        async resolve() {
          return new Set(registered.keys());
        },
        definitions(_scope: unknown, toolSet?: Set<string>) {
          return [...registered.values()].filter((d) => !('when' in d && d.when) || toolSet?.has(d.name));
        },
        selectExecutor(_scope?: unknown) {
          return baseExecutor;
        },
        async execute(batch: {
          calls: Array<{ id: string; name: string; arguments: string }>;
          agent?: unknown;
          signal?: AbortSignal;
          toolSet?: Set<string>;
        }) {
          const exec = this.selectExecutor(batch.agent ?? mockAgent) as {
            execute?: (b: typeof batch) => Promise<{ results: Array<{ callId: string; name: string; result: { isError: boolean; content: Array<{ type: string; text: string }>; value?: unknown } }> }>;
          };
          if (typeof exec.execute === 'function') return exec.execute(batch);
          throw new Error('executor missing execute');
        },
      };
      let streamInterceptor:
        | ((options: Record<string, unknown>, next: () => unknown) => AsyncIterable<Record<string, unknown>>)
        | undefined;
      let callIdx = 0;
      const mockCtx = {
        tools: mockToolsService,
        llm: {
          async *stream(opts: Record<string, unknown>) {
            const purpose = String(opts.purpose ?? '');
            const stepNum = callIdx++;
            let text: string;
            if (purpose === 'raf-branch') {
              const msgText = JSON.stringify(opts.messages ?? []);
              text = msgText.includes('WEB_RESULTS')
                ? '<folding>{"range":[0,0],"summary":"Found web results in subagent"}</folding><motivation>Done</motivation><answer>Subagent verified web_search results for RFC 9110: HTTP semantics specification details and status codes confirmed across all sections.</answer>'
                : '<motivation>Run web_search in specialist</motivation><tool_call>{"name":"web_search","arguments":{"query":"RFC 9110"}}</tool_call>';
            } else if (stepNum === 0) {
              text =
                '<motivation>Delegate web search to specialist</motivation>' +
                '<tool_call>{"name":"branch","arguments":{"scope":"rfc9110","task":"Use web_search to research RFC 9110"}}</tool_call>';
            } else {
              text =
                '<folding>{"range":[0,0],"summary":"Specialist verified RFC 9110 via web_search"}</folding>' +
                '<motivation>Complete</motivation>' +
                '<answer>WEB_SEARCH_BRIDGED_OK</answer>';
            }
            yield { type: 'text-delta', text };
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        },
        get(service: string) {
          if (service === 'tools') return mockToolsService;
          if (service === 'agents') {
            return {
              get: () => mockAgent,
              list: () => [mockAgent],
              currentInitiator: () => currentInitiator,
              withInitiator: async <T>(agent: unknown, fn: () => Promise<T>) => {
                const prev = currentInitiator;
                currentInitiator = agent;
                try {
                  return await fn();
                } finally {
                  currentInitiator = prev;
                }
              },
            };
          }
          if (service === 'workingDirectory') return { get: () => tmpDir };
          return undefined;
        },
        effect(fn: () => void) {
          fn();
        },
        on(
          event: string,
          handler: (options: Record<string, unknown>, next: () => unknown) => AsyncIterable<Record<string, unknown>>,
        ) {
          if (event === 'llm/stream') streamInterceptor = handler;
          return () => {};
        },
        inject() {},
      };

      dshPlugin.apply(mockCtx);
      await toolsReady;
      if (!streamInterceptor) throw new Error('missing streamInterceptor');

      const messages: Array<Record<string, unknown>> = [
        {
          id: 'msg-u1',
          role: 'user',
          content: [{ type: 'text', text: 'Search RFC 9110 via specialist' }],
          source: { kind: 'user' },
        },
      ];
      let finalAnswer = '';
      for (let loop = 0; loop < 4; loop++) {
        const stream = streamInterceptor(
          { sessionId: 'session-web-1', provider: 'mock', model: 'mock-root', messages },
          () => {
            throw new Error('unexpected fallthrough');
          },
        );
        let emittedCall: { id: string; name: string; arguments: string } | undefined;
        for await (const chunk of stream) {
          if (chunk.type === 'block-end') {
            const block = chunk.block as { type: string; id?: string; name?: string; arguments?: string; text?: string };
            if (block.type === 'tool-call' && block.id && block.name) {
              emittedCall = { id: block.id, name: block.name, arguments: block.arguments ?? '{}' };
            } else if (block.type === 'text' && block.text) {
              finalAnswer = block.text;
            }
          }
        }
        if (!emittedCall) break;
        const batchRes = await mockToolsService.execute({ calls: [emittedCall], agent: mockAgent });
        const firstRes = batchRes.results[0];
        messages.push({
          id: `msg-t-${loop}`,
          role: 'tool',
          toolCallId: emittedCall.id,
          isError: firstRes?.result.isError ?? false,
          content: firstRes?.result.content ?? [],
        });
      }
      expect(finalAnswer).toBe('WEB_SEARCH_BRIDGED_OK');
      expect(webSearchQueries).toEqual(['RFC 9110']);
      expect(seenInitiators[0]).toBe(mockAgent);
    } finally {
      if (prevProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfileDir;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps root Previous Steps 100% append-only across 20 steps and multi-turn follow-up even when deep fold [0,15] is requested', async () => {
    const store = new ContextStore();
    store.add('KEY_OMEGA = 777', { id: 'omega.md', title: 'omega.md' });
    const initialManifest = store.manifest();
    const initialDocIds = new Set(store.list().map((d) => d.id));
    const foldKinds: string[] = [];
    const turn1Prompts: string[] = [];
    const rootTurn1 = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      turn1Prompts.push(user);
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step < 19) {
        const foldRange = step === 16 ? '[0,15]' : `[${step - 1},${step - 1}]`;
        const fold =
          step > 0 ? `<folding>{"range":${foldRange},"summary":"Step ${step - 1} summary."}</folding>` : '';
        return `${fold}<motivation>Step ${step}</motivation><tool_call>{"name":"calculator","arguments":{"expression":"${step}+1"}}</tool_call>`;
      }
      return '<folding>{"range":[0,18],"summary":"Final step 18 summary."}</folding><motivation>Answer</motivation><answer>777</answer>';
    });
    const raf1 = new RecursiveAgentFold({
      rootLLM: rootTurn1,
      store,
      maxDepth: 0,
      onEvent: (e) => {
        if (e.type === 'fold' && e.agent === 'root') foldKinds.push(e.outcome.kind);
      },
    });
    const turn1Res = await raf1.run('Verify 20 steps for KEY_OMEGA');
    expect(turn1Res.answer).toBe('777');
    expect(foldKinds.every((k) => k === 'granular')).toBe(true);

    let turn2Prompt = '';
    const rootTurn2 = new ScriptedLLM((req) => {
      turn2Prompt = req.messages[1]?.content ?? '';
      return '<motivation>Follow-up</motivation><answer>777 confirmed</answer>';
    });
    const raf2 = new RecursiveAgentFold({ rootLLM: rootTurn2, store, maxDepth: 0 });
    raf2.begin('Verify 20 steps for KEY_OMEGA', {
      initialState: turn1Res.state,
      followUpQuestion: 'Confirm KEY_OMEGA',
      initialManifest,
      initialDocIds,
    });
    const step2 = await raf2.next();
    expect(step2.kind).toBe('answer');
    const lastTurn1 = turn1Prompts[turn1Prompts.length - 1] ?? '';
    const turn1ThroughStep17 = lastTurn1.split('**[Step 18]**')[0] ?? '';
    expect(turn2Prompt.startsWith(turn1ThroughStep17)).toBe(true);
  });

  it('executes end-to-end with pure XML <folding range="...">, <tool_call name="...">, and XML llm_query chunk findings', async () => {
    const store = new ContextStore();
    store.add('line 1: alpha\nline 2: ORION_KEY = "9942"\nline 3: omega', { id: 'doc_xml', title: 'XML test doc' });
    const queryLLM = new ScriptedLLM((req) => {
      const userMsg = req.messages.map((m) => m.content).join('\n');
      if (userMsg.includes('Mode: EXTRACT')) {
        return `<relevant>true</relevant>\n<counts>\nkey_line: 1\nother_line: 2\n</counts>\n<answer>1 key line and 2 other lines</answer>`;
      }
      return `<relevant>true</relevant>\n<answer>ORION_KEY is on line 2</answer>\n<evidence>\nL2: line 2: ORION_KEY = "9942"\n</evidence>`;
    });
    const rootLLM = new ScriptedLLM((req) => {
      const user = req.messages[1]?.content ?? '';
      const step = Number(/Step (\d+)\./.exec(user)?.[1] ?? 0);
      if (step === 0) {
        return `<motivation>Locate ORION_KEY via llm_query</motivation>
<tool_call name="llm_query">
<query>Find ORION_KEY</query>
<mode>locate</mode>
</tool_call>`;
      }
      if (step === 1) {
        return `<folding range="0-0">
llm_query located ORION_KEY = "9942" at doc_xml:L2.
</folding>
<motivation>Count line categories via llm_query extract</motivation>
<tool_call name="llm_query">
<query>Count key_line vs other_line</query>
<mode>extract</mode>
<categories>key_line, other_line</categories>
</tool_call>`;
      }
      return `<folding range="1-1">
Verified counts: key_line = 1, other_line = 2.
</folding>
<motivation>All facts verified.</motivation>
<answer>9942 (key_line=1, other_line=2)</answer>`;
    });
    const raf = new RecursiveAgentFold({ rootLLM, queryLLM, store, maxDepth: 0 });
    const res = await raf.run('What is ORION_KEY and the category counts?');
    expect(res.terminated).toBe('answer');
    expect(res.answer).toBe('9942 (key_line=1, other_line=2)');
    expect(res.formatIssues).toBe(0);
    expect(res.state.blocks).toEqual([
      { from: 0, to: 0, summary: 'llm_query located ORION_KEY = "9942" at doc_xml:L2.' },
      { from: 1, to: 1, summary: 'Verified counts: key_line = 1, other_line = 2.' },
    ]);
  });

  it('maintains 4-zone segment invariants and keeps Zone 3a cached across multi-step follow-up turns', async () => {
    const store = new ContextStore();
    store.add('ALPHA = 10\nBETA = 20', { id: 'cfg.toml', title: 'cfg.toml' });
    const initialManifest = store.manifest();
    const initialDocIds = new Set(store.listManifest().map((d) => d.id));
    const initialDocRevs: Record<string, number> = {};
    for (const d of store.listManifest()) initialDocRevs[d.id] = d.rev;

    const turn1 = new RecursiveAgentFold({
      rootLLM: new ScriptedLLM((req) => {
        for (const m of req.messages) {
          if (m.segments) expect(m.segments.map((s) => s.text).join('')).toBe(m.content);
        }
        const totalBreakpoints = req.messages.reduce(
          (acc, m) => acc + (m.segments ? m.segments.filter((s) => s.cacheBreakpoint).length : 0),
          0,
        );
        expect(totalBreakpoints).toBeLessThanOrEqual(4);
        const user = req.messages[1]?.content ?? '';
        if (user.includes('Step 0.')) {
          return '<motivation>Read cfg</motivation><tool_call name="read"><document>cfg.toml</document></tool_call>';
        }
        return '<folding range="0-0">ALPHA=10, BETA=20.</folding><motivation>Done</motivation><answer>30</answer>';
      }),
      store,
      maxDepth: 0,
    });
    const r1 = await turn1.run('Sum ALPHA and BETA');
    expect(r1.answer).toBe('30');

    // Update cfg.toml in-place to verify Zone 3a delta without mutating Zone 1
    store.add('ALPHA = 10\nBETA = 25\nGAMMA = 5', { id: 'cfg.toml', title: 'cfg.toml' });

    const turn2Calls: ChatMessage[][] = [];
    const turn2 = new RecursiveAgentFold({
      rootLLM: new ScriptedLLM((req) => {
        turn2Calls.push(req.messages.map((m) => ({ ...m })));
        const user = req.messages[1]?.content ?? '';
        if (user.includes('Step 1.')) {
          return '<motivation>Read updated cfg</motivation><tool_call name="read"><document>cfg.toml</document></tool_call>';
        }
        return '<folding range="1-1">Updated BETA=25, GAMMA=5.</folding><motivation>Done</motivation><answer>40</answer>';
      }),
      store,
      maxDepth: 0,
    });
    turn2.begin('Sum ALPHA and BETA', {
      initialState: r1.state,
      followUpQuestion: 'Include GAMMA and updated BETA',
      initialManifest,
      initialDocIds,
      initialDocRevs,
    });
    const s1 = await turn2.next();
    expect(s1.kind).toBe('tool');
    if (s1.kind === 'tool') {
      turn2.submit('ALPHA = 10\nBETA = 25\nGAMMA = 5');
    }
    const s2 = await turn2.next();
    expect(s2.kind).toBe('answer');

    const call0Segs = turn2Calls[0]?.[1]?.segments ?? [];
    const call1Segs = turn2Calls[1]?.[1]?.segments ?? [];
    // Zone 1, Zone 2, and Zone 3a (Follow-up + Updated Doc) stay 100% byte-identical across Turn 2 steps!
    expect(call0Segs[0]?.text).toBe(call1Segs[0]?.text);
    expect(call0Segs[1]?.text).toBe(call1Segs[1]?.text);
    expect(call0Segs[2]?.text).toBe(call1Segs[2]?.text);
    expect(call0Segs[2]?.text).toContain('### Follow-up Question');
    expect(call0Segs[2]?.text).toContain('### Newly Added Documents');
    expect(call0Segs[2]?.text).toContain('cfg.toml');
  });

  it('executes concurrency-safe multi-tool batches in parallel waves and spills oversized external outputs to store', async () => {
    const store = new ContextStore();
    store.add('seed', { id: 'doc' });
    const order: string[] = [];
    const parallelTool = {
      name: 'fast_read',
      description: 'concurrent read',
      parameters: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
      isConcurrencySafe: () => true,
      async execute(args: Record<string, unknown>) {
        const id = String(args.id ?? '');
        order.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 40));
        order.push(`end:${id}`);
        return `VAL_${id}`;
      },
    };
    const barrierTool = {
      name: 'shell_exec',
      description: 'sequential shell',
      parameters: { type: 'object' as const, properties: {} },
      async execute() {
        order.push('barrier');
        return Array.from({ length: 400 }, (_, i) => `LOG_LINE_${i} = ${i * 2}`).join('\n');
      },
    };
    let stepIdx = 0;
    const llm = new ScriptedLLM((req) => {
      const s = stepIdx++;
      if (s === 0) {
        // Also verify leaked DSML invoke normalization + multi-tool wave batching!
        return (
          '<motivation>Batch two concurrent reads then run shell</motivation>' +
          '<｜DSML｜function_calls>' +
          '<｜DSML｜invoke name="fast_read"><｜DSML｜parameter name="id">A</｜DSML｜parameter></｜DSML｜invoke>' +
          '<｜DSML｜invoke name="fast_read"><｜DSML｜parameter name="id">B</｜DSML｜parameter></｜DSML｜invoke>' +
          '<｜DSML｜invoke name="shell_exec"></｜DSML｜invoke>' +
          '</｜DSML｜function_calls>'
        );
      }
      const user = req.messages[1]?.content ?? '';
      expect(user).toContain('[Tool 1/3: fast_read]\nVAL_A');
      expect(user).toContain('[Tool 2/3: fast_read]\nVAL_B');
      expect(user).toContain('Full untruncated output stored as document "tool_obs_root_s0"');
      return '<folding range="0-0">Read A, B and shell log.</folding><motivation>Done</motivation><answer>OK</answer>';
    });
    const agent = new AgentFoldAgent({
      llm,
      tools: [parallelTool, barrierTool],
      store,
      maxObservationTokens: 80,
    });
    const res = await agent.run('Run parallel wave');
    expect(res.answer).toBe('OK');
    // Both A and B started before either finished, and barrier ran after both finished!
    expect(order.slice(0, 2)).toEqual(['start:A', 'start:B']);
    expect(order[4]).toBe('barrier');
    expect(store.get('tool_obs_root_s0')?.lines.length).toBeGreaterThan(400);
  });
});
