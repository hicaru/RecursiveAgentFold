import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/context/store.js';
import { ScriptedLLM } from '../src/llm/mock.js';
import { UsageTracker } from '../src/llm/usage.js';
import { LLMQueryEngine } from '../src/tools/llm-query.js';
import { createTallyTool } from '../src/tools/document-tools.js';

describe('aggregation helpers', () => {
  it('tally counts capture groups exactly', async () => {
    const store = new ContextStore();
    store.add(['User: 1 || a', 'User: 2 || b', 'User: 1 || c', 'nothing'].join('\n'), { id: 'd' });
    const r = store.tally('User: (\\d+)');
    expect(r.counts).toEqual([['1', 2], ['2', 1]]);
    const out = await createTallyTool().execute({ pattern: 'User: (\\d+)' }, { store } as never);
    expect(out).toContain('3 match(es), 2 distinct');
  });

  it('llm_query extract sums reader counts across chunks', async () => {
    const store = new ContextStore();
    store.add(Array.from({ length: 4000 }, (_, i) => `row ${i} ${i % 3 === 0 ? 'cat' : 'dog'}`).join('\n'), { id: 'x' });
    const reader = new ScriptedLLM((req) => {
      const lines = req.messages[1]!.content.split('\n').filter((l) => /^\d+\|/.test(l));
      const cat = lines.filter((l) => l.endsWith('cat')).length;
      return JSON.stringify({ relevant: true, answer: 'ok', counts: { Cat: cat, dog: lines.length - cat } });
    });
    const engine = new LLMQueryEngine(reader, store, new UsageTracker(), { maxChunkTokens: 2048 });
    const r = await engine.query({ query: 'count cat/dog', mode: 'extract' });
    expect(r.findings.length).toBeGreaterThan(3);
    expect(r.report).toContain('cat=1334');
    expect(r.report).toContain('dog=2666');
  });
});
