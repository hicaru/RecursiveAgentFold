import { describe, expect, it } from 'vitest';
import { AgentFoldAgent } from '../src/agent/agent-fold.js';
import { ContextStore } from '../src/context/store.js';
import { FoldState } from '../src/fold/state.js';
import { ScriptedLLM } from '../src/llm/mock.js';
import { parseAgentResponse } from '../src/protocol/parser.js';
import { defaultEstimator, truncateToTokens } from '../src/tokens.js';
import { evaluateExpression } from '../src/tools/calculator.js';
import { coerceToolArguments, formatToolCallXml, validateToolArguments } from '../src/tools/types.js';
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

  it('unwraps an answer nested inside an outer answer wrapper', () => {
    const text =
      '<answer><folding range="0-0">s</folding><motivation>m</motivation><answer>\nAnswer: ACE\n</answer></answer>';
    const p = parseAgentResponse(text, { expectFolding: true });
    expect(p.answer).toBe('Answer: ACE');
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
    expect(atStep1.warnings).toContain('missing <folding>');
  });

  it('handles unclosed tags and raw newlines in JSON strings', () => {
    const p = parseAgentResponse('<folding>{"range": [2, 4], "summary": "line1\nline2"}</folding>\n<motivation>go\n<tool_call>{"name":"grep","arguments":{"pattern":"x"}}', { expectFolding: true });
    expect(p.errors).toEqual([]);
    expect(p.folding?.summary).toBe('line1\nline2');
    expect(p.motivation).toBe('go');
    expect(p.toolCall?.name).toBe('grep');
  });

  it('parses real trace edge cases: smart quotes inside valid JSON, single-backslash regex, unclosed string, <folded_output>, and bare tally JSON (B5)', () => {
    // B5a: ruler-131072-niah_single_3-0.jsonl:10 — smart quotes inside valid JSON string
    const pSmartQuotes = parseAgentResponse(
      '<folding>\n{"range": [0, 0], "summary": "Located the needle in the document: “One of the most important things...”"}\n</folding>\n<answer>Answer: 123</answer>',
      { expectFolding: true },
    );
    expect(pSmartQuotes.errors).toEqual([]);
    expect(pSmartQuotes.folding?.range).toEqual([0, 0]);
    expect(pSmartQuotes.folding?.summary).toContain('“One of the most important things...”');
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
      '<folding>{"range": [0, 3], "summary": "Completed all dependency module constant queries; exact values are confirmed.}</folding>\n<answer>Answer: 42</answer>',
      { expectFolding: true },
    );
    expect(pUnclosedQuote.errors).toEqual([]);
    expect(pUnclosedQuote.folding?.range).toEqual([0, 3]);
    expect(pUnclosedQuote.folding?.summary).toContain('exact values are confirmed.');

    // B5c-2: longbench-pro-35ddea1dc...jsonl:9 — <folded_output> tag alias
    const pFoldedOutput = parseAgentResponse(
      '<folded_output>{"range": [0, 0], "summary": "Read lines 1-80 and recorded key facts"}</folded_output>\n<motivation>next</motivation>\n<tool_call>{"name": "read", "arguments": {"document": "context", "start_line": 81, "end_line": 160}}</tool_call>',
      { expectFolding: true },
    );
    expect(pFoldedOutput.errors).toEqual([]);
    expect(pFoldedOutput.folding?.summary).toBe('Read lines 1-80 and recorded key facts');

    // B5d: ruler-131072-fwe-0.jsonl:4 — bare JSON tally call without "name" or <tool_call>
    const pBareTally = parseAgentResponse(
      'The document contains random hyphenated numeric tokens mixed with English words. Use tally on alphabetic sequences to get word frequency rankings in one step. {"pattern": "([A-Za-z]+)", "documents": ["haystack"], "case_sensitive": true, "top": 25}',
      { expectFolding: false },
    );
    expect(pBareTally.errors).toEqual([]);
    expect(pBareTally.toolCall?.name).toBe('tally');
    expect(pBareTally.toolCall?.arguments.pattern).toBe('([A-Za-z]+)');
    expect(pBareTally.motivation).toContain('Use tally on alphabetic sequences');
    // B5e: missing closing brace in nested arguments object
    const pMissingBrace = parseAgentResponse(
      '<motivation>search</motivation>\n<tool_call>\n{"name":"grep","arguments":{"pattern":"alpha|beta", "documents": ["context"], "max_matches": 10}\n</tool_call>',
      { expectFolding: false },
    );
    expect(pMissingBrace.errors).toEqual([]);
    expect(pMissingBrace.toolCall?.name).toBe('grep');
    expect(pMissingBrace.toolCall?.arguments.max_matches).toBe(10);

    // B5f: mixed <fold>...</folding> tags
    const pMixedFoldTag = parseAgentResponse(
      '<fold>\n{"range": [4, 4], "summary": "Step 4 verified option A holds"}\n</folding>\n<motivation>done</motivation>\n<answer>Answer: A</answer>',
      { expectFolding: true },
    );
    expect(pMixedFoldTag.errors).toEqual([]);
    expect(pMixedFoldTag.folding?.range).toEqual([4, 4]);
    expect(pMixedFoldTag.folding?.summary).toBe('Step 4 verified option A holds');
    // Bare folding JSON before <motivation> without <folding> tag
    const pBareFold = parseAgentResponse(
      '{"range": [0, 0], "summary": "Step 0: grep found 0 matches"} <motivation>Next probe</motivation>\n<tool_call>{"name": "grep", "arguments": {"pattern": "test"}}</tool_call>',
      { expectFolding: true },
    );
    expect(pBareFold.errors).toEqual([]);
    expect(pBareFold.folding).toEqual({ range: [0, 0], summary: 'Step 0: grep found 0 matches' });
    expect(pBareFold.toolCall?.name).toBe('grep');

    // Split folding summary after prematurely closed {"range": [5, 5]}
    const pSplitSummary = parseAgentResponse(
      '<folding>\n{"range": [5, 5]}\n"Verified years via tally on context: 1970=3, 1977=2."\n</folding>\n<motivation>Read lines</motivation>\n<tool_call>{"name": "read", "arguments": {"document": "context", "start_line": 1, "end_line": 10}}</tool_call>',
      { expectFolding: true },
    );
    expect(pSplitSummary.errors).toEqual([]);
    expect(pSplitSummary.folding).toEqual({
      range: [5, 5],
      summary: 'Verified years via tally on context: 1970=3, 1977=2.',
    });
  });

  it('parses XML attribute/tag and key-value <folding> and <tool_call> formats without JSON escaping', () => {
    // 1. XML attribute <folding range="0-2"> and <tool_call name="grep"> with unescaped quotes and backslashes
    const pXml = parseAgentResponse(
      `<folding range="0-2">
Found KEY = "alpha\\beta" and regex \\d+ in {module_a} at doc:L42.
</folding>
<motivation>Search for init method with unescaped regex.</motivation>
<tool_call name="grep">
<pattern>def __init__\\(self, "cfg"\\)|self\\.name</pattern>
<documents>doc_a, doc_b</documents>
<max_matches>10</max_matches>
</tool_call>`,
      { expectFolding: true },
    );
    expect(pXml.errors).toEqual([]);
    expect(pXml.folding).toEqual({
      range: [0, 2],
      summary: 'Found KEY = "alpha\\beta" and regex \\d+ in {module_a} at doc:L42.',
    });
    expect(pXml.toolCall).toEqual({
      name: 'grep',
      arguments: {
        pattern: 'def __init__\\(self, "cfg"\\)|self\\.name',
        documents: ['doc_a', 'doc_b'],
        max_matches: 10,
      },
    });

    // 2. Multi-task <tool_call name="branch"> with <task scope="..."> tags
    const pBranchXml = parseAgentResponse(
      `<folding range="1">Step 1 complete.</folding>
<motivation>Dispatch parallel specialists.</motivation>
<tool_call name="branch">
<task scope="crates/aead">Audit "aead" nonce handling & constants</task>
<task scope="crates/kdf">Audit HKDF derivation in crates/kdf</task>
</tool_call>`,
      { expectFolding: true },
    );
    expect(pBranchXml.errors).toEqual([]);
    expect(pBranchXml.folding).toEqual({ range: [1, 1], summary: 'Step 1 complete.' });
    expect(pBranchXml.toolCall).toEqual({
      name: 'branch',
      arguments: {
        tasks: [
          { scope: 'crates/aead', task: 'Audit "aead" nonce handling & constants' },
          { scope: 'crates/kdf', task: 'Audit HKDF derivation in crates/kdf' },
        ],
      },
    });

    // 3. Nested HTML/XML inside <content> tag of <tool_call name="write"> preserved verbatim
    const pWriteXml = parseAgentResponse(
      `<motivation>Write HTML component.</motivation>
<tool_call name="write">
<file_path>src/App.html</file_path>
<content>
<div class="card">
  <span>"Hello & Welcome"</span>
</div>
</content>
</tool_call>`,
      { expectFolding: false },
    );
    expect(pWriteXml.errors).toEqual([]);
    expect(pWriteXml.toolCall).toEqual({
      name: 'write',
      arguments: {
        file_path: 'src/App.html',
        content: '<div class="card">\n  <span>"Hello & Welcome"</span>\n</div>',
      },
    });

    // 4. Key-value fallback inside <folding> and <tool_call>
    const pKv = parseAgentResponse(
      `<folding>
range: 2-4
summary: Verified all 3 modules ("a", "b", "c").
</folding>
<motivation>Read lines 10-20.</motivation>
<tool_call>
name: read
document: ctx
start_line: 10
end_line: 20
</tool_call>`,
      { expectFolding: true },
    );
    expect(pKv.errors).toEqual([]);
    expect(pKv.folding).toEqual({
      range: [2, 4],
      summary: 'Verified all 3 modules ("a", "b", "c").',
    });
    expect(pKv.toolCall).toEqual({
      name: 'read',
      arguments: { document: 'ctx', start_line: 10, end_line: 20 },
    });
  });

  it('handles session 01a1c76c regressions: multi-format branch tool_call, XML entity heredocs, Step-0 folding, and backticked protocol tags in <answer>', () => {
    // 1. XML & TOML branch inside <tool_call>
    const pBranchToml = parseAgentResponse(
      `<motivation>Fan out across packages.</motivation>
<tool_call name="branch">
[[tasks]]
scope = "packages/engine"
task = "Inspect parser, board, and walk"

[[tasks]]
scope = "packages/pi-extension"
task = "Inspect live widget and renderers"
</tool_call>`,
      { expectFolding: false },
    );
    expect(pBranchToml.errors).toEqual([]);
    expect(pBranchToml.toolCall).toEqual({
      name: 'branch',
      arguments: {
        tasks: [
          { scope: 'packages/engine', task: 'Inspect parser, board, and walk' },
          { scope: 'packages/pi-extension', task: 'Inspect live widget and renderers' },
        ],
      },
    });

    // 2. XML entity decoding in bash heredoc (&lt;&lt;'PY' and &amp;&amp;)
    const pBashXml = parseAgentResponse(
      `<motivation>Run python check.</motivation>
<tool_call name="bash">
<command>cd /tmp &amp;&amp; python3 - &lt;&lt;'PY'
print(1 &lt; 2)
PY</command>
</tool_call>`,
      { expectFolding: false },
    );
    expect(pBashXml.errors).toEqual([]);
    expect(pBashXml.toolCall).toEqual({
      name: 'bash',
      arguments: {
        command: "cd /tmp && python3 - <<'PY'\nprint(1 < 2)\nPY",
      },
    });

    // 3. Non-empty <folding>none</folding> on Step 0 warns instead of throwing a fatal error
    const pStep0Fold = parseAgentResponse(
      '<folding>No prior step to fold.</folding><motivation>Read README.</motivation><tool_call>{"name":"read","arguments":{"path":"README.md"}}</tool_call>',
      { expectFolding: false },
    );
    expect(pStep0Fold.errors).toEqual([]);
    expect(pStep0Fold.warnings).toContain('unexpected <folding> when expectFolding=false');
    expect(pStep0Fold.toolCall?.name).toBe('read');

    // 4. <answer> containing inline backticked and fenced <folding>, <tool_call>, and </answer>
    const answerText = [
      'The parser handles `<folding>`, `<tool_call>`, and `</answer>` safely:',
      '```xml',
      '<folding range="0-0">example</folding>',
      '<answer>nested example</answer>',
      '```',
      'Final conclusion reached.',
    ].join('\n');
    const pAnswer = parseAgentResponse(
      `<folding range="0-0">Done.</folding><motivation>Deliver report.</motivation><answer>${answerText}</answer>`,
      { expectFolding: true },
    );
    expect(pAnswer.errors).toEqual([]);
    expect(pAnswer.answer).toBe(answerText);
  });

  it('rejects unclosed <parameter>, unclosed multiline tags, unescaped protocol markup, duplicate scalars, <param_name>, and multi-value shorthand (B1, B2, B5, B6, PI-2)', () => {
    // B1: unclosed <parameter> must not swallow next parameter into pattern
    const pB1 = parseAgentResponse(
      '<motivation>grep</motivation><tool_call name="grep"><parameter name="pattern">foo<parameter name="documents">["a.ts"]</parameter></tool_call>',
      { expectFolding: false },
    );
    expect(pB1.errors.length).toBeGreaterThan(0);
    expect(pB1.toolCall).toBeUndefined();

    // B2: unclosed <new_string> followed by </old_string> must fail instead of writing </old_string> into file
    const pB2 = parseAgentResponse(
      '<motivation>edit</motivation><tool_call name="edit"><old_string>a</old_string><new_string>b</old_string></tool_call>',
      { expectFolding: false },
    );
    expect(pB2.errors.some((e) => e.includes('unclosed <new_string>'))).toBe(true);
    expect(pB2.toolCall).toBeUndefined();

    // B2 CDATA escape succeeds cleanly
    const pB2Cdata = parseAgentResponse(
      '<motivation>edit</motivation><tool_call name="edit"><old_string>a</old_string><new_string><![CDATA[x</old_string>]]></new_string></tool_call>',
      { expectFolding: false },
    );
    expect(pB2Cdata.errors).toEqual([]);
    expect(pB2Cdata.toolCall?.arguments.new_string).toBe('x</old_string>');

    // Raw unescaped protocol markup inside parameter is rejected unless CDATA or entity-escaped
    const pRawMarkup = parseAgentResponse(
      '<motivation>write</motivation><tool_call name="write"><path>a.txt</path><content><tool_call>x</tool_call></content></tool_call>',
      { expectFolding: false },
    );
    expect(pRawMarkup.errors.some((e) => e.includes('unescaped protocol markup'))).toBe(true);
    const pEscapedMarkup = parseAgentResponse(
      '<motivation>write</motivation><tool_call name="write"><path>a.txt</path><content>&lt;tool_call&gt;x&lt;/tool_call&gt;</content></tool_call>',
      { expectFolding: false },
    );
    expect(pEscapedMarkup.errors).toEqual([]);

    // Duplicate scalar parameter in single tool_call is rejected
    const pDupScalar = parseAgentResponse(
      '<motivation>read</motivation><tool_call name="read"><document>a.ts</document><start_line>1</start_line><start_line>10</start_line></tool_call>',
      { expectFolding: false },
    );
    expect(pDupScalar.errors.some((e) => e.includes('duplicate scalar parameter "start_line"'))).toBe(true);

    // Placeholder <param_name> is rejected
    const pPlaceholder = parseAgentResponse(
      '<motivation>read</motivation><tool_call name="read"><param_name>a.ts</param_name></tool_call>',
      { expectFolding: false },
    );
    expect(pPlaceholder.errors.some((e) => e.includes('<param_name>'))).toBe(true);

    // PI-2: single-tag external tool arguments and key-value custom keys are preserved
    const pTaskGetXml = parseAgentResponse(
      '<motivation>get task</motivation><tool_call name="TaskGet"><taskId>4</taskId></tool_call>',
      { expectFolding: false },
    );
    expect(pTaskGetXml.errors).toEqual([]);
    expect(pTaskGetXml.toolCall).toEqual({ name: 'TaskGet', arguments: { taskId: 4 } });

    const pTaskGetKv = parseAgentResponse(
      '<motivation>get task</motivation><tool_call name="TaskGet">taskId: 4</tool_call>',
      { expectFolding: false },
    );
    expect(pTaskGetKv.errors).toEqual([]);
    expect(pTaskGetKv.toolCall).toEqual({ name: 'TaskGet', arguments: { taskId: 4 } });

    const pSearchXml = parseAgentResponse(
      '<motivation>search</motivation><tool_call name="google_search"><q>rust</q></tool_call>',
      { expectFolding: false },
    );
    expect(pSearchXml.errors).toEqual([]);
    expect(pSearchXml.toolCall).toEqual({ name: 'google_search', arguments: { q: 'rust' } });

    // Shorthand scalar rejects multi-line / trailing line numbers
    const pReadRangeShorthand = parseAgentResponse(
      '<motivation>read</motivation><tool_call name="read">docs/GDD.md 1 140</tool_call>',
      { expectFolding: false },
    );
    expect(pReadRangeShorthand.errors.some((e) => e.includes('untagged multi-value body'))).toBe(true);
    const pBashMultiline = parseAgentResponse(
      '<motivation>bash</motivation><tool_call name="bash">List files\nls -la</tool_call>',
      { expectFolding: false },
    );
    expect(pBashMultiline.errors.some((e) => e.includes('untagged multi-value body'))).toBe(true);
    const pSingleRead = parseAgentResponse(
      '<motivation>read</motivation><tool_call name="read">docs/GDD.md</tool_call>',
      { expectFolding: false },
    );
    expect(pSingleRead.errors).toEqual([]);
    expect(pSingleRead.toolCall).toEqual({ name: 'read', arguments: { document: 'docs/GDD.md' } });
  });
});

describe('tool argument validation and XML step escaping (B13)', () => {
  it('escapes XML characters in formatToolCallXml and validates schemas before execution', async () => {
    const xml = formatToolCallXml('edit', { old_string: 'a < b & c > d', new_string: 'x' });
    expect(xml).toContain('a &lt; b &amp; c &gt; d');
    expect(xml).not.toContain('a < b');

    const taskGetSchema = {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
      additionalProperties: false,
    };
    const coerced = coerceToolArguments({ task_id: 7 }, taskGetSchema);
    expect(coerced).toEqual({ taskId: '7' });
    expect(validateToolArguments('TaskGet', {}, taskGetSchema)).toEqual(['TaskGet: missing required argument "taskId"']);
    expect(validateToolArguments('TaskGet', { taskId: '7', bogus: 1 }, taskGetSchema)).toEqual([
      'TaskGet: unknown argument "bogus"',
    ]);

    // AgentFoldAgent.next() intercepts invalid args via FORMAT_REPAIR before executing tool
    const store = new ContextStore();
    const executed: Array<Record<string, unknown>> = [];
    let callCount = 0;
    const llm = new ScriptedLLM((req) => {
      callCount++;
      if (callCount === 1) {
        return '<motivation>get task</motivation><tool_call name="TaskGet"></tool_call>';
      }
      if (callCount === 2) {
        expect(req.messages.map((m) => m.content).join('\n')).toContain('missing required argument "taskId"');
        return '<motivation>get task</motivation><tool_call name="TaskGet"><taskId>7</taskId></tool_call>';
      }
      return '<folding range="0-0">got 7</folding><motivation>done</motivation><answer>OK</answer>';
    });
    const agent = new AgentFoldAgent({
      llm,
      store,
      tools: [
        {
          name: 'TaskGet',
          description: 'Get task',
          parameters: taskGetSchema,
          async execute(args) {
            executed.push(args);
            return 'task 7';
          },
        },
      ],
    });
    const res = await agent.run('Get task 7');
    expect(res.answer).toBe('OK');
    expect(executed).toEqual([{ taskId: '7' }]);
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
  it('estimates non-ASCII/CJK tokens accurately and truncates text within token budget (B7)', () => {
    const cjkText = '\u4e00'.repeat(3000);
    const tokens = defaultEstimator.count(cjkText);
    expect(tokens).toBeGreaterThanOrEqual(2100);
    expect(tokens).toBeLessThanOrEqual(2200);

    const longCjk = '\u4e2d'.repeat(8000);
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
