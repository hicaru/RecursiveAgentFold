import type { FoldDirective, ToolAction } from '../fold/state.js';
import { extractBalanced, normalizeQuotes, parseLooseJSON } from '../util/json.js';

/**
 * Parser for the AgentFold response protocol (paper §3.3, Fig. 7/9):
 *
 *   <think>…</think>                       (optional; may come via reasoning_content)
 *   <folding>{"range":[k,t-1],"summary":"…"}</folding>   (omitted at step 0)
 *   <motivation>…</motivation>             (the paper's "explanation")
 *   <tool_call>{"name":"…","arguments":{…}}</tool_call>
 *     — or —
 *   <answer>…</answer>
 */
export interface ParsedResponse {
  think?: string;
  folding?: FoldDirective;
  motivation?: string;
  toolCall?: ToolAction;
  answer?: string;
  /** Hard errors: the response cannot be executed. */
  errors: string[];
  /** Soft issues: executable but non-conforming. */
  warnings: string[];
}

const TAGS = ['think', 'folding', 'motivation', 'tool_call', 'answer'] as const;
type Tag = (typeof TAGS)[number];

function tagRegex(tag: string): RegExp {
  // tolerant of `</ folding >`, attributes and casing
  return new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, 'i');
}

function openTagIndex(text: string, tag: string): number {
  const m = new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>`, 'i').exec(text);
  return m ? m.index + m[0].length : -1;
}

export function extractTag(text: string, tag: Tag): string | undefined {
  const m = tagRegex(tag).exec(text);
  if (m?.[1] !== undefined) return m[1].trim();
  // Unclosed tag: take content until the next known open tag or end of text.
  const start = openTagIndex(text, tag);
  if (start < 0) return undefined;
  let end = text.length;
  for (const other of TAGS) {
    if (other === tag) continue;
    const re = new RegExp(`<\\s*${other}(?:\\s[^>]*)?>`, 'ig');
    re.lastIndex = start;
    const n = re.exec(text);
    if (n && n.index >= start && n.index < end) end = n.index;
  }
  return text.slice(start, end).trim();
}

function parseFolding(raw: string, warnings: string[], errors: string[]): FoldDirective | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = parseLooseJSON<Record<string, unknown>>(raw);
  } catch (e) {
    errors.push(`<folding> 不是合法 JSON：${(e as Error).message}`);
    return undefined;
  }
  let range = obj.range;
  if (typeof range === 'string') {
    const nums = range.match(/-?\d+/g)?.map(Number) ?? [];
    range = nums.length === 1 ? [nums[0], nums[0]] : nums;
    warnings.push('folding.range 是字符串');
  }
  if (typeof range === 'number') range = [range, range];
  if (!Array.isArray(range) || range.length < 1 || range.some((x) => typeof x !== 'number' && isNaN(Number(x)))) {
    errors.push('folding.range 必须是 [start, end]');
    return undefined;
  }
  const start = Number(range[0]);
  const end = Number(range[range.length - 1]);
  const summary = typeof obj.summary === 'string' ? obj.summary : obj.summary !== undefined ? JSON.stringify(obj.summary) : '';
  if (!summary.trim()) errors.push('folding.summary 为空');
  return { range: [start, end], summary };
}

function parseToolCall(raw: string, errors: string[]): ToolAction | undefined {
  let obj: Record<string, unknown>;
  try {
    obj = parseLooseJSON<Record<string, unknown>>(raw);
  } catch (e) {
    errors.push(`<tool_call> 不是合法 JSON：${(e as Error).message}`);
    return undefined;
  }
  // Accept OpenAI-style {"function": {"name", "arguments": "<json>"}} as well.
  const fn = (obj.function ?? obj) as Record<string, unknown>;
  const name = fn.name ?? fn.tool ?? fn.tool_name;
  if (typeof name !== 'string' || !name) {
    errors.push('tool_call.name 缺失');
    return undefined;
  }
  let args = fn.arguments ?? fn.args ?? fn.parameters ?? fn.input;
  if (args === undefined) {
    // Flattened form: {"name": "read", "document": "x", ...}
    const { name: _n, tool: _t, tool_name: _tn, function: _f, ...rest } = fn;
    args = rest;
  }
  if (typeof args === 'string') {
    try {
      args = parseLooseJSON(args);
    } catch {
      errors.push('tool_call.arguments 是字符串，但不是合法 JSON');
      return undefined;
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    errors.push('tool_call.arguments 必须是对象');
    return undefined;
  }
  return { name, arguments: args as Record<string, unknown> };
}

export interface ParseOptions {
  /** True when a folding directive is required (every step except 0). */
  expectFolding: boolean;
  /** Provider reasoning, used as <think> when the text has none. */
  reasoning?: string;
}

export function parseAgentResponse(text: string, opts: ParseOptions): ParsedResponse {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Drop reasoning before looking for protocol tags; models sometimes mention
  // "<tool_call>" inside their thoughts.
  const thinkRaw = extractTag(text, 'think');
  const body = thinkRaw !== undefined ? text.replace(tagRegex('think'), '') : text;
  const out: ParsedResponse = { errors, warnings, think: thinkRaw ?? opts.reasoning };

  const foldRaw = extractTag(body, 'folding');
  if (foldRaw !== undefined && foldRaw.trim() !== '') out.folding = parseFolding(foldRaw, warnings, errors);
  else if (opts.expectFolding) warnings.push('缺少 <folding>');

  const motivation = extractTag(body, 'motivation') ?? extractTag(body, 'explanation' as Tag);
  if (motivation !== undefined) out.motivation = motivation;

  const answer = extractTag(body, 'answer');
  const toolRaw = extractTag(body, 'tool_call');
  if (answer !== undefined) {
    out.answer = answer;
    if (toolRaw !== undefined) warnings.push('同时出现 <answer> 和 <tool_call>，采用 <answer>');
  } else if (toolRaw !== undefined) {
    out.toolCall = parseToolCall(toolRaw, errors);
  } else {
    // Last resort: bare JSON tool call without tags.
    const bare = extractBalanced(normalizeQuotes(body));
    if (bare && /"name"\s*:/.test(bare) && /"arguments"\s*:/.test(bare)) {
      out.toolCall = parseToolCall(bare, errors);
      warnings.push('工具调用没有 <tool_call> 标签');
    } else {
      errors.push('回复既没有 <tool_call> 也没有 <answer>');
    }
  }
  if (!out.motivation && !out.answer) warnings.push('缺少 <motivation>');
  return out;
}
