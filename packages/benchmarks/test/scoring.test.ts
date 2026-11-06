import { describe, expect, it } from 'vitest';
import { parseGold, parseOolongAnswer, scoreOolong, scoreOolongLenient } from '../src/oolong/scoring.js';
import { buildNeedleTasks } from '../src/needle/needle.js';
import { buildCodeGraphTasks } from '../src/codegraph/codegraph.js';
import { parseChoiceLetter, splitContextIntoDocuments } from '../src/longbench/tasks.js';
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
