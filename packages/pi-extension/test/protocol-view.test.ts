import { describe, expect, it } from 'vitest';
import { renderProtocolMarkdown } from '../src/protocol-view.js';

describe('renderProtocolMarkdown', () => {
  it('passes plain text through unchanged', () => {
    const text = 'Just an answer with no tags.';
    expect(renderProtocolMarkdown(text)).toBe(text);
  });

  it('renders a complete step: fold, motivation, tool call', () => {
    const out = renderProtocolMarkdown(
      '<folding range="3-3">grep found the key at line 12.</folding>\n<motivation>Verify the value.</motivation>\n<tool_call name="grep"><pattern>key</pattern></tool_call>',
    );
    expect(out).toContain('fold 3–3');
    expect(out).toContain('grep found the key at line 12.');
    expect(out).toContain('Verify the value.');
    expect(out).toContain('`grep`');
    expect(out).not.toMatch(/<\s*(?:folding|motivation|tool_call)/);
  });

  it('reads a JSON folding directive body', () => {
    const out = renderProtocolMarkdown('<folding>{"range":[2,5],"summary":"Studied the parser."}</folding><answer>42</answer>');
    expect(out).toContain('fold 2–5');
    expect(out).toContain('Studied the parser.');
    expect(out).toContain('42');
  });

  it('renders a streaming prefix with an unclosed fold', () => {
    const out = renderProtocolMarkdown('<folding range="1-1">Half a summary');
    expect(out).toContain('fold 1–1');
    expect(out).toContain('Half a summary');
    expect(out).toContain('…');
  });

  it('drops thinking blocks including an unclosed one', () => {
    expect(renderProtocolMarkdown('<think>secret</think><answer>ok</answer>')).toBe('ok');
    expect(renderProtocolMarkdown('visible<think>partial reasoning')).toBe('visible');
  });

  it('takes the tool name from JSON arguments when the attribute is missing', () => {
    const out = renderProtocolMarkdown('<tool_call>{"name":"read","arguments":{"document":"doc_1"}}</tool_call>');
    expect(out).toContain('`read`');
  });
});
