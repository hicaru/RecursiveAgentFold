import { describe, expect, it } from 'vitest';
import { FoldState } from '../src/fold/state.js';
import { parseAgentResponse } from '../src/protocol/parser.js';
import { defaultEstimator, truncateToTokens } from '../src/tokens.js';
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

  it('ignores an empty <folding> when none is expected, warns when one is', () => {
    const tool = '<motivation>x</motivation><tool_call>{"name":"grep","arguments":{"pattern":"x"}}</tool_call>';
    const atStep0 = parseAgentResponse(`<folding>\n</folding>${tool}`, { expectFolding: false });
    expect(atStep0.errors).toEqual([]);
    expect(atStep0.folding).toBeUndefined();
    const atStep1 = parseAgentResponse(`<folding></folding>${tool}`, { expectFolding: true });
    expect(atStep1.errors).toEqual([]);
    expect(atStep1.folding).toBeUndefined();
    expect(atStep1.warnings).toContain('缺少 <folding>');
  });

  it('handles unclosed tags and raw newlines in JSON strings', () => {
    const p = parseAgentResponse('<folding>{"range": [2, 4], "summary": "line1\nline2"}</folding>\n<motivation>go\n<tool_call>{"name":"grep","arguments":{"pattern":"x"}}', { expectFolding: true });
    expect(p.errors).toEqual([]);
    expect(p.folding?.summary).toBe('line1\nline2');
    expect(p.motivation).toBe('go');
    expect(p.toolCall?.name).toBe('grep');
  });

  it('parses real trace edge cases: Chinese quotes inside valid JSON, single-backslash regex, unclosed string, <folded_output>, and bare tally JSON (B5)', () => {
    // B5a: ruler-131072-niah_single_3-0.jsonl:10 — Chinese quotes inside valid JSON string
    const pChineseQuotes = parseAgentResponse(
      '<folding>\n{"range": [0, 0], "summary": "在文档中定位了 needle 的位置，内容为：“One of the most important things...”"}\n</folding>\n<answer>Answer: 123</answer>',
      { expectFolding: true },
    );
    expect(pChineseQuotes.errors).toEqual([]);
    expect(pChineseQuotes.folding?.range).toEqual([0, 0]);
    expect(pChineseQuotes.folding?.summary).toContain('“One of the most important things...”');

    // B5b: longbench-66ec56dd821e116aacb1cd0e.jsonl:5 — single backslash in regex pattern
    const pRegex = parseAgentResponse(
      '<motivation>search init</motivation>\n<tool_call>\n{"name": "grep", "arguments": {"pattern": "self\\.name|def __init__"}}\n</tool_call>',
      { expectFolding: false },
    );
    expect(pRegex.errors).toEqual([]);
    expect(pRegex.toolCall?.name).toBe('grep');
    expect(pRegex.toolCall?.arguments.pattern).toBe('self\\.name|def __init__');

    // B5c-1: codegraph-120000-diamond-1.jsonl:142 — missing closing quote before final brace
    const pUnclosedQuote = parseAgentResponse(
      '<folding>{"range": [0, 3], "summary": "已完成所有依赖模块常量查询，各常量精确值均已确定。}</folding>\n<answer>Answer: 42</answer>',
      { expectFolding: true },
    );
    expect(pUnclosedQuote.errors).toEqual([]);
    expect(pUnclosedQuote.folding?.range).toEqual([0, 3]);
    expect(pUnclosedQuote.folding?.summary).toContain('各常量精确值均已确定。');

    // B5c-2: longbench-pro-35ddea1dc...jsonl:9 — <folded_output> tag alias
    const pFoldedOutput = parseAgentResponse(
      '<folded_output>{"range": [0, 0], "summary": "已读取第1-80行并记录关键事实"}</folded_output>\n<motivation>next</motivation>\n<tool_call>{"name": "read", "arguments": {"document": "context", "start_line": 81, "end_line": 160}}</tool_call>',
      { expectFolding: true },
    );
    expect(pFoldedOutput.errors).toEqual([]);
    expect(pFoldedOutput.folding?.summary).toBe('已读取第1-80行并记录关键事实');

    // B5d: ruler-131072-fwe-0.jsonl:4 — bare JSON tally call without "name" or <tool_call>
    const pBareTally = parseAgentResponse(
      '文档是随机连字符数字 token，其中混有真实英文单词。用 tally 对字母序列做精确频次统计即可一步拿到词频排行。{"pattern": "([A-Za-z]+)", "documents": ["haystack"], "case_sensitive": true, "top": 25}',
      { expectFolding: false },
    );
    expect(pBareTally.errors).toEqual([]);
    expect(pBareTally.toolCall?.name).toBe('tally');
    expect(pBareTally.toolCall?.arguments.pattern).toBe('([A-Za-z]+)');
    expect(pBareTally.motivation).toContain('用 tally 对字母序列做精确频次统计');

    // B5e: missing closing brace in nested arguments object
    const pMissingBrace = parseAgentResponse(
      '<motivation>search</motivation>\n<tool_call>\n{"name":"grep","arguments":{"pattern":"alpha|beta", "documents": ["context"], "max_matches": 10}\n</tool_call>',
      { expectFolding: false },
    );
    expect(pMissingBrace.errors).toEqual([]);
    expect(pMissingBrace.toolCall?.name).toBe('grep');
    expect(pMissingBrace.toolCall?.arguments.max_matches).toBe(10);

    // B5f: longbench-66ec0c4c821e116aacb1994a.jsonl:36 — mixed <折叠>...</folding> tags
    const pMixedFoldTag = parseAgentResponse(
      '<折叠>\n{"range": [4, 4], "summary": "步骤4已验证选项A成立"}\n</folding>\n<motivation>done</motivation>\n<answer>答案：A</answer>',
      { expectFolding: true },
    );
    expect(pMixedFoldTag.errors).toEqual([]);
    expect(pMixedFoldTag.folding?.range).toEqual([4, 4]);
    expect(pMixedFoldTag.folding?.summary).toBe('步骤4已验证选项A成立');
  });
});

describe('utils & CJK token estimation (B7)', () => {
  it('parseLooseJSON tolerates fences, trailing commas, and unescaped inner quotes', () => {
    expect(parseLooseJSON('```json\n{"a": [1,2,],}\n```')).toEqual({ a: [1, 2] });
    expect(parseLooseJSON('Here: {"relevant": true} done')).toEqual({ relevant: true });
    expect(parseLooseJSON('{"range": [0, 0], "summary": "Found "alpha" in doc"}')).toEqual({
      range: [0, 0],
      summary: 'Found "alpha" in doc',
    });
  });
  it('estimates CJK tokens accurately and truncates Chinese text within token budget (B7)', () => {
    const cjkText = '第'.repeat(3000);
    const tokens = defaultEstimator.count(cjkText);
    expect(tokens).toBeGreaterThanOrEqual(2100);
    expect(tokens).toBeLessThanOrEqual(2200);

    const longCjk = '中'.repeat(8000);
    const trunc = truncateToTokens(longCjk, 2400, defaultEstimator);
    expect(trunc.truncated).toBe(true);
    expect(defaultEstimator.count(trunc.text)).toBeLessThanOrEqual(2500);
  });
  it('calculator', () => {
    expect(evaluateExpression('sum(12, 40, 7) / 3')).toBeCloseTo(59 / 3);
    expect(evaluateExpression('2^3^2')).toBe(512);
    expect(evaluateExpression('-(3 + 4) * 2 % 5')).toBe(-4);
    expect(evaluateExpression('max(1, 2_000, 3)')).toBe(2000);
    expect(() => evaluateExpression('process.exit()')).toThrow();
  });
});
