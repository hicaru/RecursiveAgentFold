import { describe, expect, it } from 'vitest';
import { FoldState } from '../src/fold/state.js';
import { parseAgentResponse } from '../src/protocol/parser.js';
import { evaluateExpression } from '../src/tools/calculator.js';
import { parseLooseJSON } from '../src/util/json.js';

const act = (step: number) => ({
  step,
  motivation: `m${step}`,
  action: { name: 'grep', arguments: { pattern: String(step) } },
  observation: `obs ${step}`,
});

describe('FoldState (paper Fig. 2 semantics)', () => {
  it('granular condensation appends, deep consolidation merges', () => {
    const s = new FoldState();
    expect(s.currentStep).toBe(0);
    s.setLatest(act(0));
    expect(s.applyFold({ range: [0, 0], summary: 'A0' }).kind).toBe('granular');
    for (let i = 1; i <= 3; i++) {
      s.setLatest(act(i));
      s.applyFold({ range: [i, i], summary: `A${i}` });
    }
    expect(s.blocks.map((b) => [b.from, b.to])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3]]);
    s.setLatest(act(4));
    const o = s.applyFold({ range: [1, 4], summary: 'B' });
    expect(o.kind).toBe('deep');
    expect(o.retractedBlocks).toBe(3);
    expect(o.firstChangedBlock).toBe(1);
    expect(s.blocks.map((b) => [b.from, b.to, b.summary])).toEqual([[0, 0, 'A0'], [1, 4, 'B']]);
    expect(s.currentStep).toBe(5);
  });

  it('normalizes bad ranges: forces end, snaps start to block boundary', () => {
    const s = new FoldState();
    s.setLatest(act(0));
    s.applyFold({ range: [0, 0], summary: 'a' });
    s.setLatest(act(1));
    s.applyFold({ range: [0, 1], summary: 'b' }); // block [0,1]
    s.setLatest(act(2));
    const o = s.applyFold({ range: [1, 7], summary: 'c' });
    expect(o.directive.range).toEqual([0, 2]);
    expect(o.corrections.length).toBe(2);
    expect(s.blocks).toEqual([{ from: 0, to: 2, summary: 'c' }]);
  });

  it('rejects out-of-order interactions', () => {
    const s = new FoldState();
    expect(() => s.setLatest(act(3))).toThrow();
  });
});

describe('parseAgentResponse', () => {
  it('parses the paper format incl. curly quotes and spaced closing tag', () => {
    const text = `<think>hmm <tool_call> mentioned in thoughts</think>
<folding>
{
"range": [6, 16],
”summary": "Multiple attempts failed."
}
</ folding >
<motivation>
Shift focus.
</motivation>
<tool_call>
{"name": "search", "arguments": {"query": ["a", "b"]}}
</tool_call>`;
    const p = parseAgentResponse(text, { expectFolding: true });
    expect(p.errors).toEqual([]);
    expect(p.folding).toEqual({ range: [6, 16], summary: 'Multiple attempts failed.' });
    expect(p.motivation).toBe('Shift focus.');
    expect(p.toolCall).toEqual({ name: 'search', arguments: { query: ['a', 'b'] } });
    expect(p.think).toContain('hmm');
  });

  it('parses answers and OpenAI-style string arguments', () => {
    const p = parseAgentResponse('<motivation>x</motivation><tool_call>{"function":{"name":"read","arguments":"{\\"document\\":\\"d\\"}"}}</tool_call>', { expectFolding: false });
    expect(p.toolCall).toEqual({ name: 'read', arguments: { document: 'd' } });
    const a = parseAgentResponse('<folding>{"range":[3,3],"summary":"s"}</folding><answer>Label: location</answer>', { expectFolding: true });
    expect(a.answer).toBe('Label: location');
  });

  it('reports missing action', () => {
    const p = parseAgentResponse('just prose', { expectFolding: false });
    expect(p.errors.length).toBe(1);
  });

  it('handles unclosed tags and raw newlines in JSON strings', () => {
    const p = parseAgentResponse('<folding>{"range": [2, 4], "summary": "line1\nline2"}</folding>\n<motivation>go\n<tool_call>{"name":"grep","arguments":{"pattern":"x"}}', { expectFolding: true });
    expect(p.errors).toEqual([]);
    expect(p.folding?.summary).toBe('line1\nline2');
    expect(p.motivation).toBe('go');
    expect(p.toolCall?.name).toBe('grep');
  });
});

describe('utils', () => {
  it('parseLooseJSON tolerates fences and trailing commas', () => {
    expect(parseLooseJSON('```json\n{"a": [1,2,],}\n```')).toEqual({ a: [1, 2] });
    expect(parseLooseJSON('Here: {"relevant": true} done')).toEqual({ relevant: true });
  });
  it('calculator', () => {
    expect(evaluateExpression('sum(12, 40, 7) / 3')).toBeCloseTo(59 / 3);
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-(3 + 4) * 2 % 5')).toBe(-4);
    expect(evaluateExpression('max(1, 2_000, 3)')).toBe(2000);
    expect(() => evaluateExpression('process.exit()')).toThrow();
  });
});
