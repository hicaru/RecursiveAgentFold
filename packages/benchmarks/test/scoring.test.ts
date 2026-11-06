import { describe, expect, it } from 'vitest';
import { parseGold, parseOolongAnswer, scoreOolong, scoreOolongLenient } from '../src/oolong/scoring.js';
import { buildNeedleTasks } from '../src/needle/needle.js';
import { buildCodeGraphTasks } from '../src/codegraph/codegraph.js';
import { parseChoiceLetter, splitContextIntoDocuments } from '../src/longbench/tasks.js';
import { buildLongBenchProTasks } from '../src/longbench-pro/tasks.js';
import { buildRulerTasks, parseAnswerList } from '../src/ruler/ruler.js';
import { buildMrcrTasks, parseBullets } from '../src/mrcr/mrcr.js';
describe('OOLONG scoring (official port)', () => {
  it('parses gold literals', () => {
    expect(parseGold("['location']").value).toBe('location');
    expect(parseGold('[12]').value).toBe('12');
    expect(parseGold('["more common than human being"]').value).toBe('more common than human being');
    expect(parseGold('[datetime.date(2023, 5, 1)]').date?.toISOString().slice(0, 10)).toBe('2023-05-01');
  });

  it('parse_answer semantics', () => {
    expect(parseOolongAnswer('Label: location')).toEqual({ candidate: 'location', confidence: 'vhigh' });
    expect(parseOolongAnswer('short')).toEqual({ candidate: 'short', confidence: 'low' });
    expect(parseOolongAnswer('the final number of items is 42').candidate).toBe('42');
    expect(parseOolongAnswer('Answer: entity is more common than human being in the data').candidate).toBe('more common');
  });

  it('scores labels, numerics, comparisons and dates', () => {
    expect(scoreOolong({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: location').score).toBe(1);
    expect(scoreOolong({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: Location').score).toBe(0);
    expect(scoreOolong({ answer: '[10]', answer_type: 'ANSWER_TYPE.NUMERIC' }, 'Answer: 12').score).toBeCloseTo(0.5625);
    expect(scoreOolong({ answer: "['more common than entity']", answer_type: 'ANSWER_TYPE.COMPARISON' }, 'Answer: location is more common than entity overall').score).toBe(1);
    expect(scoreOolong({ answer: '[datetime.date(2023, 5, 1)]', answer_type: 'ANSWER_TYPE.DATE' }, 'Date: May 1, 2023').score).toBe(1);
  });

  it('lenient variant is case-insensitive', () => {
    expect(scoreOolongLenient({ answer: "['location']", answer_type: 'ANSWER_TYPE.LABEL' }, 'Label: Location')).toBe(1);
  });
});

describe('needle generator', () => {
  it('is deterministic and roughly sized', () => {
    const a = buildNeedleTasks({ tokens: 20_000, tasks: 2, seed: 3 });
    const b = buildNeedleTasks({ tokens: 20_000, tasks: 2, seed: 3 });
    expect(a[0]!.documents[0]!.text).toBe(b[0]!.documents[0]!.text);
    expect(a[0]!.documents[0]!.tokens).toBeGreaterThan(19_000);
    const gold = a[0]!.meta.gold as number;
    expect(a[0]!.score(`Answer: ${gold}`).score).toBe(1);
  });
});

describe('codegraph & longbench generators', () => {
  it('codegraph builds 8 deterministic module documents and scores spec_specialist, diamond_deps, and chain_hop', () => {
    const a = buildCodeGraphTasks({ tokens: 24_000, tasks: 3, hops: 3, seed: 7 });
    const b = buildCodeGraphTasks({ tokens: 24_000, tasks: 3, hops: 3, seed: 7 });
    expect(a).toHaveLength(3);
    expect(a[0]?.documents).toHaveLength(8);
    expect(a[0]?.documents.map((d) => d.id)).toEqual([
      'app_gateway',
      'service_order',
      'service_billing',
      'lib_auth',
      'lib_crypto',
      'lib_pricing',
      'lib_tax_rules',
      'spec_protocol',
    ]);
    expect(a[0]?.documents[0]?.text).toBe(b[0]?.documents[0]?.text);
    expect(a.map((t) => t.meta.task)).toEqual(['spec_specialist', 'diamond_deps', 'chain_hop']);
    for (const t of a) {
      const gold = t.meta.gold as number;
      expect(t.score(`Answer: ${gold}`).score).toBe(1);
      expect(t.score(`Answer: ${gold + 1}`).score).toBe(0);
    }
  });

  it('longbench splits multi-file contexts into documents and parses choice letters', () => {
    const ctx = [
      `=== File: src/a.ts ===\n${'const x = 1;\n'.repeat(30)}`,
      `=== File: src/b.ts ===\n${'const y = 2;\n'.repeat(30)}`,
    ].join('\n');
    const docs = splitContextIntoDocuments(ctx);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.id).toBe('doc_1');
    expect(docs[1]?.id).toBe('doc_2');
    expect(parseChoiceLetter('Answer: B')).toBe('B');
    expect(parseChoiceLetter('After checking all modules, the correct option is (C).')).toBe('C');
  });
});

describe('ruler / mrcr / longbench-pro generators', () => {
  it('ruler is deterministic, sized, and gold is findable in the haystack', () => {
    const a = buildRulerTasks({ tokens: 20_000, tasks: 1, seed: 7 });
    const b = buildRulerTasks({ tokens: 20_000, tasks: 1, seed: 7 });
    expect(a).toHaveLength(11);
    const first = a[0];
    const firstB = b[0];
    if (!first || !firstB) throw new Error('missing ruler task');
    expect(first.documents[0]?.text).toBe(firstB.documents[0]?.text);
    expect(first.documents[0]?.tokens).toBeGreaterThan(18_000);
    // gold answer must literally appear in the haystack for retrieval subtasks
    for (const t of a.slice(0, 8)) {
      const gold = String(t.meta.gold ?? '');
      expect(t.documents[0]?.text).toContain(gold.split(',')[0] ?? gold);
    }
    // scoring: exact gold → 1, junk → 0
    const single = a.find((t) => t.meta.task === 'niah_single_1');
    if (!single) throw new Error('missing niah_single_1');
    expect(single.score(`Answer: ${String(single.meta.gold)}`).score).toBe(1);
    expect(single.score('Answer: 000000').score).toBe(0);
    // cwe: all 10 → 1, partial → 0 with correct extra
    const cwe = a.find((t) => t.meta.task === 'cwe');
    if (!cwe) throw new Error('missing cwe');
    const goldList = String(cwe.meta.gold).split(',');
    expect(cwe.score(`Answer: ${goldList.join(', ')}`).score).toBe(1);
    const partial = cwe.score(`Answer: ${goldList.slice(0, 6).join(', ')}`);
    expect(partial.score).toBe(0);
    expect(partial.extra?.correct).toBe(6);
    // vt chain contains X1..XchainLen
    const vt = a.find((t) => t.meta.task === 'vt');
    if (!vt) throw new Error('missing vt');
    // one group per task: the runner shares a document store across a group,
    // and each ruler task owns a different haystack
    expect(new Set(a.map((t) => t.group)).size).toBe(a.length);
    expect(new Set(a.map((t) => t.documents[0]?.text)).size).toBe(a.length);
  });

  it('mrcr is deterministic and scores item-level F1', () => {
    const a = buildMrcrTasks({ tokens: 20_000, tasks: 3, seed: 5 });
    const b = buildMrcrTasks({ tokens: 20_000, tasks: 3, seed: 5 });
    expect(a).toHaveLength(3);
    expect(a[0]?.documents[0]?.text).toBe(b[0]?.documents[0]?.text);
    const t = a[0];
    if (!t) throw new Error('missing mrcr task');
    const gold = String(t.meta.gold).split(' || ');
    expect(gold.length).toBeGreaterThanOrEqual(1);
    const perfect = t.score(gold.map((g, i) => `- ${g}${i === 0 ? '.' : ''}`).join('\n'));
    expect(perfect.score).toBe(1);
    const half = t.score(`- ${gold[0]}`);
    expect(half.score).toBeGreaterThan(0);
    expect(half.score).toBeLessThan(1);
    expect(t.score('- completely unrelated sentence.').score).toBe(0);
    expect(parseBullets('1. alpha\n- beta\nAnswer: below').length).toBe(2);
  });

  it('longbench-pro builds free-form tasks with lenient containment scoring', () => {
    const rows = [
      {
        _id: 'x1',
        domain: 'Academic Papers',
        difficulty: 'hard',
        length: 'long',
        question: 'What does the paper conclude?',
        answer: 'the model scales linearly',
        context: '=== paper.txt ===\n'.padEnd(300, 'x') + 'the model scales linearly',
        token_length: 200_000,
      },
    ];
    const tasks = buildLongBenchProTasks(rows);
    const t = tasks[0];
    if (!t) throw new Error('missing longbench-pro task');
    expect(t.id).toBe('longbench-pro-x1');
    expect(t.documents.length).toBeGreaterThanOrEqual(1);
    expect(t.score('Answer: The model scales linearly.').score).toBe(1);
    expect(t.score('Answer: something else entirely').score).toBe(0);
    expect(t.score('The paper says the model scales linearly overall. Answer: model scales linearly').score).toBe(1);
  });
});
