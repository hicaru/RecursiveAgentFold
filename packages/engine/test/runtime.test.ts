import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/context/store.js';
import { ResearchBoard } from '../src/context/board.js';
import { ScriptedLLM } from '../src/llm/mock.js';
import { RecursiveAgentFold } from '../src/runtime.js';
import { computeChunkTokens, LLMQueryEngine } from '../src/tools/llm-query.js';
import { UsageTracker } from '../src/llm/usage.js';
import type { AgentEvent } from '../src/agent/events.js';
import { AgentFoldAgent } from '../src/agent/agent-fold.js';
import { FoldState } from '../src/fold/state.js';
import { createGrepTool, createReadTool } from '../src/tools/document-tools.js';

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
    // at step 3 the latest interaction is step 2 → range end is normalized to 2
    expect(res.state.blocks).toEqual([{ from: 0, to: 2, summary: 'Passcode confirmed 7341.' }]);
    const folds = events.filter((e) => e.type === 'fold' && e.agent === 'root');
    expect(folds.map((f) => (f.type === 'fold' ? f.outcome.kind : ''))).toEqual(['granular', 'granular', 'deep']);
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
    expect(folds.map((f) => f.outcome.kind)).toEqual(['granular', 'granular', 'granular', 'deep', 'deep']);
    expect(folds[1]?.outcome.directive.range).toEqual([1, 1]);
    expect(folds[1]?.outcome.corrections.some((c) => c.includes('deferred to granular'))).toBe(true);
    expect(folds[3]?.outcome.directive.range).toEqual([0, 3]);
    expect(folds[4]?.outcome.directive.range).toEqual([0, 4]);
  });
it('ResearchBoard records entries, deduplicates, and provides byte-identical prefix across steps', async () => {
    const board = new ResearchBoard();
    board.record({
      agent: 'agent',
      kind: 'llm_query',
      scope: 'ctx@8192:1-end',
      key: 'extract:count categories',
      summary: 'counts(1/1块): cat=60, dog=60',
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
      summary: 'counts(1/1块): cat=65, dog=60',
      counts: { cat: 65, dog: 60 },
    });
    expect(board.entries()).toHaveLength(1);
    expect(board.entries()[0]?.summary).toBe('counts(1/1块): cat=65, dog=60');

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

    // Prefix up to ### 任务 should be byte-identical
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

    // Follow-up call (3rd branch prompt) must preserve [压缩步骤 0] and [压缩步骤 1] and include ### 协同追问
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
      '<motivation>wait</motivation><answer>暂无最终答案，继续验证中</answer>',
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
    expect(out).not.toContain('已截断');
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
