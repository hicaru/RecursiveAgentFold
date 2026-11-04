import { describe, expect, it } from 'vitest';
import { parseGold, parseOolongAnswer, scoreOolong, scoreOolongLenient } from '../src/oolong/scoring.js';
import { buildNeedleTasks } from '../src/needle/needle.js';

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
