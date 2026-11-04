import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/context/store.js';
import { ScriptedLLM } from '../src/llm/mock.js';
import { RecursiveAgentFold } from '../src/runtime.js';
import { computeChunkTokens, LLMQueryEngine } from '../src/tools/llm-query.js';
import { UsageTracker } from '../src/llm/usage.js';
import type { AgentEvent } from '../src/agent/events.js';

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
      const step = Number(/当前是第 (\d+) 步/.exec(user)![1]);
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
      return /当前是第 0 步/.test(user)
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
      if (/步数上限/.test(user)) return '<answer>beta</answer>';
      const step = Number(/当前是第 (\d+) 步/.exec(user)![1]);
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
});
