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
    expect(out).toContain('3 个匹配，2 个不同值');
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
it('llm_query canonical category memoization reuses cached counts across different query phrasing', async () => {
    const store = new ContextStore();
    store.add(Array.from({ length: 4000 }, (_, i) => `row ${i} ${i % 3 === 0 ? 'cat' : i % 3 === 1 ? 'dog' : 'bird'}`).join('\n'), { id: 'x' });
    let llmCallCount = 0;
    const reader = new ScriptedLLM((req) => {
      llmCallCount++;
      const lines = req.messages[1]!.content.split('\n').filter((l) => /^\d+\|/.test(l));
      const cat = lines.filter((l) => l.endsWith('cat')).length;
      const dog = lines.filter((l) => l.endsWith('dog')).length;
      const bird = lines.filter((l) => l.endsWith('bird')).length;
      return JSON.stringify({ relevant: true, answer: 'counts', counts: { cat, dog, bird } });
    });
    const engine = new LLMQueryEngine(reader, store, new UsageTracker(), { maxChunkTokens: 2048 });

    // First query with 3 categories
    const r1 = await engine.query({
      query: 'Count cat, dog, and bird per chunk',
      mode: 'extract',
      categories: ['Cat', 'Dog', 'Bird'],
    });
    const firstCallCount = llmCallCount;
    expect(firstCallCount).toBeGreaterThan(0);
    expect(r1.findings.every((f) => !f.memoHit)).toBe(true);

    // Second query with completely different wording but same categories
    const r2 = await engine.query({
      query: 'What are the occurrences of bird, dog, and cat?',
      mode: 'extract',
      categories: ['dog', 'cat', 'bird'],
    });
    expect(llmCallCount).toBe(firstCallCount); // 0 additional LLM calls!
    expect(r2.findings.every((f) => f.memoHit)).toBe(true);
    expect(r2.findings.length).toBe(r1.findings.length);

    // Third query with subset categories (e.g. comparing only cat vs dog)
    const r3 = await engine.query({
      query: 'Compare counts of cat and dog only',
      mode: 'extract',
      categories: ['cat', 'dog'],
    });
    expect(llmCallCount).toBe(firstCallCount); // Still 0 additional LLM calls!
    expect(r3.findings.every((f) => f.memoHit)).toBe(true);
    expect(r3.findings[0]?.counts).toHaveProperty('cat');
    expect(r3.findings[0]?.counts).toHaveProperty('dog');
    expect(r3.findings[0]?.counts).not.toHaveProperty('bird');
  });
});
