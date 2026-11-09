import type { FoldDirective, ToolAction } from '../fold/state.js';
import { extractBalanced, normalizeQuotes, parseLooseJSON } from '../util/json.js';

/**
 * Parser for the AgentFold response protocol:
 *
 * Primary XML format (zero JSON escaping required):
 *   <think>...</think>                       (optional; may come via reasoning_content)
 *   <folding range="k-n">summary</folding>   (omitted at step 0)
 *   <motivation>...</motivation>
 *   <tool_call name="tool_name">
 *   <param>value</param>
 *   </tool_call>
 *     — or —
 *   <answer>...</answer>
 *
 * Also supports key-value lines and legacy JSON inside <folding> and <tool_call>
 * for full backward compatibility.
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

const TAGS = ['think', 'folding', 'folded_output', 'fold', 'motivation', 'explanation', 'tool_call', 'answer'] as const;
type Tag = (typeof TAGS)[number];
const FOLD_TAGS = ['folding', 'folded_output', 'fold'] as const;
const MOTIVATION_TAGS = ['motivation', 'explanation'] as const;
const TOOL_TAG_ALIASES = [
  'add_document',
  'search',
  'outline',
  'grep',
  'read',
  'tally',
  'calculator',
  'branch',
  'llm_query',
  'list_documents',
  'bash',
  'write',
  'edit',
  'glob',
  'web_search',
  'web_fetch',
] as const;

const STRING_PARAM_KEYS: Readonly<Record<string, true>> = Object.freeze({
  pattern: true,
  query: true,
  document: true,
  path: true,
  file_path: true,
  filePath: true,
  content: true,
  old_string: true,
  new_string: true,
  command: true,
  description: true,
  expression: true,
  scope: true,
  task: true,
  url: true,
  text: true,
  id: true,
  mode: true,
});

const MULTILINE_PRESERVE_KEYS: Readonly<Record<string, true>> = Object.freeze({
  content: true,
  old_string: true,
  new_string: true,
  command: true,
});

const LIST_PARAM_KEYS: Readonly<Record<string, true>> = Object.freeze({
  documents: true,
  categories: true,
  paths: true,
});

const KNOWN_PARAM_NAMES: Readonly<Record<string, true>> = Object.freeze({
  pattern: true,
  query: true,
  document: true,
  documents: true,
  start_line: true,
  end_line: true,
  max_matches: true,
  context_lines: true,
  top_k: true,
  max_entries: true,
  case_sensitive: true,
  top: true,
  group: true,
  expression: true,
  path: true,
  paths: true,
  file_path: true,
  filePath: true,
  content: true,
  old_string: true,
  new_string: true,
  command: true,
  description: true,
  scope: true,
  task: true,
  tasks: true,
  max_steps: true,
  mode: true,
  chunk_tokens: true,
  categories: true,
  url: true,
  name: true,
  tool: true,
  tool_name: true,
  function: true,
  arguments: true,
  parameters: true,
  args: true,
  input: true,
  parameter: true,
  param: true,
  arg: true,
  field: true,
});

interface ExtractedTag {
  readonly tag: string;
  readonly attrs: string;
  readonly content: string;
}

function tagRegex(tag: string): RegExp {
  return new RegExp(`<\\s*${tag}(\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*${tag}\\s*>`, 'i');
}

function groupTagRegex(tags: readonly string[]): RegExp {
  const alt = tags.join('|');
  return new RegExp(`<\\s*(${alt})(\\s[^>]*)?>([\\s\\S]*?)<\\s*\\/\\s*(?:${alt})\\s*>`, 'i');
}

function openTagIndex(text: string, tag: string): number {
  const m = new RegExp(`<\\s*${tag}(?:\\s[^>]*)?>`, 'i').exec(text);
  return m ? m.index + m[0].length : -1;
}

function extractTagWithAttrs(text: string, tag: string): ExtractedTag | undefined {
  const m = tagRegex(tag).exec(text);
  if (m && m[2] !== undefined) {
    return { tag, attrs: (m[1] ?? '').trim(), content: m[2].trim() };
  }
  const selfClosing = new RegExp(`<\\s*${tag}(\\s[^>]*?)?\\/\\s*>`, 'i').exec(text);
  if (selfClosing) {
    return { tag, attrs: (selfClosing[1] ?? '').trim(), content: '' };
  }
  const openRe = new RegExp(`<\\s*${tag}(\\s[^>]*)?>`, 'i');
  const openMatch = openRe.exec(text);
  if (!openMatch) return undefined;
  const start = openMatch.index + openMatch[0].length;
  let end = text.length;
  for (const other of TAGS) {
    if (other === tag) continue;
    const re = new RegExp(`<\\s*${other}(?:\\s[^>]*)?>`, 'ig');
    re.lastIndex = start;
    const n = re.exec(text);
    if (n && n.index >= start && n.index < end) end = n.index;
  }
  return { tag, attrs: (openMatch[1] ?? '').trim(), content: text.slice(start, end).trim() };
}

function extractGroupTagWithAttrs(text: string, tags: readonly string[]): ExtractedTag | undefined {
  const m = groupTagRegex(tags).exec(text);
  if (m && m[1] !== undefined && m[3] !== undefined) {
    return { tag: m[1].toLowerCase(), attrs: (m[2] ?? '').trim(), content: m[3].trim() };
  }
  for (const t of tags) {
    const ext = extractTagWithAttrs(text, t);
    if (ext !== undefined) return ext;
  }
  return undefined;
}

export function extractTag(text: string, tag: Tag): string | undefined {
  return extractTagWithAttrs(text, tag)?.content;
}

function parseXmlAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrString) return attrs;
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key) attrs[key] = val;
  }
  return attrs;
}

function parseRangeSpec(spec: string): [number, number] | undefined {
  const cleaned = spec.trim();
  const m = /^\[\s*(-?\d+)\s*(?:(?:\.\.+|[,:–—]|-(?=\s*-?\d)|\s+to\s+)\s*(-?\d+)\s*)?\]$/i.exec(cleaned) ??
    /^(-?\d+)\s*(?:(?:\.\.+|[,:–—]|-(?=\s*-?\d)|\s+to\s+)\s*(-?\d+))?$/i.exec(cleaned);
  if (m && m[1] !== undefined) {
    const start = Number(m[1]);
    const end = Number(m[2] ?? m[1]);
    if (Number.isFinite(start) && Number.isFinite(end)) return [start, end];
  }
  const nums = cleaned.match(/-?\d+/g)?.map((n) => Math.abs(Number(n))) ?? [];
  if (nums.length >= 2 && nums[0] !== undefined && nums[1] !== undefined) {
    return [nums[0], nums[1]];
  }
  if (nums.length === 1 && nums[0] !== undefined) {
    return [nums[0], nums[0]];
  }
  return undefined;
}

function extractSummaryFromRawFold(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const summaryTag = /<\s*summary(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*summary\s*>/i.exec(trimmed);
  if (summaryTag?.[1] !== undefined) return summaryTag[1].trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = parseLooseJSON<Record<string, unknown>>(trimmed);
      if (typeof obj.summary === 'string') return obj.summary.trim();
    } catch {
      const mSum = /"summary"\s*:\s*"([\s\S]*?)"?\s*\}?\s*$/.exec(trimmed);
      if (mSum?.[1] !== undefined) return mSum[1].trim();
    }
  }
  return trimmed
    .replace(/^\s*<\s*range(?:\s[^>]*)?>[\s\S]*?<\s*\/\s*range\s*>\s*/i, '')
    .replace(/^\s*summary\s*:\s*/i, '')
    .trim();
}

function parseFolding(
  raw: string,
  attrs: string | undefined,
  warnings: string[],
  errors: string[],
): FoldDirective | undefined {
  const parsedAttrs = parseXmlAttributes(attrs ?? '');
  const rangeAttr = parsedAttrs.range ?? parsedAttrs.steps ?? parsedAttrs.step ?? parsedAttrs.span;
  const fromAttr = parsedAttrs.from ?? parsedAttrs.start;
  const toAttr = parsedAttrs.to ?? parsedAttrs.end;

  if (rangeAttr !== undefined || fromAttr !== undefined) {
    const rangeTuple =
      rangeAttr !== undefined
        ? parseRangeSpec(rangeAttr)
        : fromAttr !== undefined
          ? parseRangeSpec(`${fromAttr}-${toAttr ?? fromAttr}`)
          : undefined;
    if (!rangeTuple) {
      errors.push('folding.range must be [start, end]');
      return undefined;
    }
    const summary = extractSummaryFromRawFold(raw);
    if (!summary) {
      errors.push('folding.summary is empty');
      return undefined;
    }
    return { range: rangeTuple, summary };
  }

  // XML child tags: <folding><range>0-2</range><summary>...</summary></folding>
  const rangeTagMatch = /<\s*range(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*range\s*>/i.exec(raw);
  if (rangeTagMatch?.[1] !== undefined) {
    const rangeTuple = parseRangeSpec(rangeTagMatch[1]);
    if (!rangeTuple) {
      errors.push('folding.range must be [start, end]');
      return undefined;
    }
    const summary = extractSummaryFromRawFold(raw);
    if (!summary) {
      errors.push('folding.summary is empty');
      return undefined;
    }
    return { range: rangeTuple, summary };
  }

  // Key-value or bracket header format when not JSON:
  //   range: 0-2
  //   summary: ...
  // or:
  //   [0-2] summary...
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{')) {
    const kvMatch = /^\s*(?:range|steps?)\s*:\s*([^\n]+)(?:\n+([\s\S]*))?$/i.exec(trimmed);
    if (kvMatch?.[1] !== undefined) {
      const rangeTuple = parseRangeSpec(kvMatch[1]);
      if (!rangeTuple) {
        errors.push('folding.range must be [start, end]');
        return undefined;
      }
      const summary = (kvMatch[2] ?? '').replace(/^\s*summary\s*:\s*/i, '').trim();
      if (!summary) {
        errors.push('folding.summary is empty');
        return undefined;
      }
      return { range: rangeTuple, summary };
    }

    const bracketPrefixMatch = /^\s*\[\s*(-?\d+)\s*(?:(?:\.\.+|[,:–—]|-(?=\s*-?\d)|\s+to\s+)\s*(-?\d+)\s*)?\]\s*:?\s*([\s\S]*)$/i.exec(trimmed);
    if (bracketPrefixMatch?.[1] !== undefined) {
      const start = Number(bracketPrefixMatch[1]);
      const end = Number(bracketPrefixMatch[2] ?? bracketPrefixMatch[1]);
      const summary = (bracketPrefixMatch[3] ?? '').replace(/^\s*summary\s*:\s*/i, '').trim();
      if (!summary) {
        errors.push('folding.summary is empty');
        return undefined;
      }
      return { range: [start, end], summary };
    }
  }

  // Legacy JSON format: {"range": [k, n], "summary": "..."}
  let obj: Record<string, unknown>;
  try {
    obj = parseLooseJSON<Record<string, unknown>>(raw);
  } catch (e) {
    const mRange = /"range"\s*:\s*\[\s*(-?\d+)\s*(?:,\s*(-?\d+)\s*)?\]/.exec(raw);
    const mSum = /"summary"\s*:\s*"([\s\S]*?)"?\s*\}?\s*$/.exec(raw);
    if (mRange?.[1] !== undefined && mSum?.[1] !== undefined) {
      const start = Number(mRange[1]);
      const end = Number(mRange[2] ?? mRange[1]);
      const summary = mSum[1].trim();
      if (summary) {
        warnings.push('folding parsed via regex fallback');
        return { range: [start, end], summary };
      }
    }
    errors.push(`<folding> is not valid: ${(e as Error).message}`);
    return undefined;
  }
  let range = obj.range;
  if (typeof range === 'string') {
    const tuple = parseRangeSpec(range);
    range = tuple ?? [];
    warnings.push('folding.range is a string');
  }
  if (typeof range === 'number') range = [range, range];
  if (!Array.isArray(range) || range.length < 1 || range.some((x) => typeof x !== 'number' && isNaN(Number(x)))) {
    errors.push('folding.range must be [start, end]');
    return undefined;
  }
  const start = Number(range[0]);
  const end = Number(range[range.length - 1]);
  let summary = typeof obj.summary === 'string' ? obj.summary : obj.summary !== undefined ? JSON.stringify(obj.summary) : '';
  if (!summary.trim()) {
    const mAfter = /\]\s*\}?\s*,?\s*(?:"summary"\s*:\s*)?"([\s\S]*?)"?\s*\}?\s*$/.exec(raw);
    if (mAfter?.[1]?.trim()) {
      summary = mAfter[1].trim();
      warnings.push('folding.summary recovered via regex fallback');
    } else {
      errors.push('folding.summary is empty');
    }
  }
  return { range: [start, end], summary };
}

function inferBareToolName(obj: Record<string, unknown>, contextText: string): string | undefined {
  if (typeof obj.expression === 'string') return 'calculator';
  if (typeof obj.path === 'string' || Array.isArray(obj.paths)) return 'add_document';
  if (typeof obj.pattern === 'string') {
    if ('top' in obj || 'group' in obj || /\btally\b/i.test(contextText)) return 'tally';
    return 'grep';
  }
  if (('start_line' in obj || 'end_line' in obj || 'document' in obj) && !('pattern' in obj) && !('query' in obj)) {
    return 'read';
  }
  if ('task' in obj || 'tasks' in obj || 'scope' in obj) return 'branch';
  if ('query' in obj || 'categories' in obj) return 'llm_query';
  if (typeof obj.command === 'string') return 'bash';
  if (typeof obj.old_string === 'string' || typeof obj.new_string === 'string') return 'edit';
  if (typeof obj.content === 'string' && (typeof obj.file_path === 'string' || typeof obj.path === 'string')) return 'write';
  return undefined;
}

function parseXmlParamValue(key: string, rawVal: string): unknown {
  if (MULTILINE_PRESERVE_KEYS[key]) {
    return rawVal.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
  }
  const trimmed = rawVal.trim();
  if (LIST_PARAM_KEYS[key]) {
    const childMatches = [...trimmed.matchAll(/<\s*(?:item|value|doc|document|category|path)(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*(?:item|value|doc|document|category|path)\s*>/gi)];
    if (childMatches.length > 0) {
      return childMatches.map((m) => (m[1] ?? '').trim()).filter(Boolean);
    }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = parseLooseJSON(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // Fall through to delimiter split
      }
    }
    return trimmed
      .split(/[\n,]+/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (STRING_PARAM_KEYS[key]) {
    return trimmed;
  }
  if (/^(?:true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === 'true';
  }
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try {
      return parseLooseJSON(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function extractTaskElements(xmlText: string): Array<{ scope?: string; task: string }> {
  const tasks: Array<{ scope?: string; task: string }> = [];
  const taskRe = /<\s*task(\s[^>]*)?>([\s\S]*?)<\s*\/\s*task\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = taskRe.exec(xmlText)) !== null) {
    const tAttrs = parseXmlAttributes(m[1] ?? '');
    let body = (m[2] ?? '').trim();
    let scope = tAttrs.scope?.trim();
    const innerScope = /<\s*scope(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*scope\s*>/i.exec(body);
    if (innerScope?.[1] !== undefined) {
      scope = innerScope[1].trim();
      body = body.replace(innerScope[0], '').trim();
    }
    const innerTask = /<\s*(?:task|instruction|query|question)(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*(?:task|instruction|query|question)\s*>/i.exec(body);
    if (innerTask?.[1] !== undefined) {
      body = innerTask[1].trim();
    }
    if (body) {
      tasks.push(scope ? { scope, task: body } : { task: body });
    }
  }
  return tasks;
}

function tryParseStructuredToolCall(
  raw: string,
  attrs: string | undefined,
  fallbackName?: string,
  contextText?: string,
): ToolAction | undefined {
  const topAttrs = parseXmlAttributes(attrs ?? '');
  let toolName: string | undefined =
    topAttrs.name ?? topAttrs.tool ?? topAttrs.tool_name ?? topAttrs.function ?? fallbackName;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(topAttrs)) {
    if (k === 'name' || k === 'tool' || k === 'tool_name' || k === 'function') continue;
    args[k] = parseXmlParamValue(k, v);
  }

  let body = raw.trim();

  // Unwrap <invoke name="...">...</invoke> or <tool_name>...</tool_name> wrapper inside <tool_call>
  const outerWrap = /^<\s*([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?>([\s\S]*)<\s*\/\s*\1\s*>$/i.exec(body);
  if (outerWrap && outerWrap[1] !== undefined && outerWrap[3] !== undefined) {
    const outerTag = outerWrap[1];
    const outerTagLower = outerTag.toLowerCase();
    const outerAttrs = parseXmlAttributes(outerWrap[2] ?? '');
    if (outerTagLower === 'invoke' || outerTagLower === 'function_call' || outerTagLower === 'tool') {
      toolName = outerAttrs.name ?? outerAttrs.tool ?? outerAttrs.function ?? toolName;
      body = outerWrap[3].trim();
    } else if (!KNOWN_PARAM_NAMES[outerTag] && !KNOWN_PARAM_NAMES[outerTagLower]) {
      toolName = toolName ?? outerTag;
      for (const [k, v] of Object.entries(outerAttrs)) {
        if (k === 'name' || k === 'tool') continue;
        args[k] = parseXmlParamValue(k, v);
      }
      body = outerWrap[3].trim();
    }
  }

  // If body after optional unwrap is JSON, parse JSON arguments with resolved toolName
  if (body.startsWith('{')) {
    try {
      const jsonObj = parseLooseJSON<Record<string, unknown>>(body);
      const fn = (jsonObj.function ?? jsonObj) as Record<string, unknown>;
      const resolvedName =
        (typeof fn.name === 'string' ? fn.name : undefined) ??
        (typeof fn.tool === 'string' ? fn.tool : undefined) ??
        toolName ??
        (contextText !== undefined ? inferBareToolName(fn, contextText) : undefined);
      if (resolvedName) {
        let jsonArgs = fn.arguments ?? fn.args ?? fn.parameters ?? fn.input;
        if (jsonArgs === undefined) {
          const { name: _n, tool: _t, tool_name: _tn, function: _f, ...rest } = fn;
          jsonArgs = rest;
        }
        if (typeof jsonArgs === 'string') jsonArgs = parseLooseJSON(jsonArgs);
        if (jsonArgs && typeof jsonArgs === 'object' && !Array.isArray(jsonArgs)) {
          return { name: resolvedName, arguments: { ...args, ...(jsonArgs as Record<string, unknown>) } };
        }
      }
    } catch {
      // Continue to XML / key-value parsing
    }
  }

  // Extract <name>...</name> if present outside <arguments>
  const nameTagMatch = /^[\s\S]*?<\s*(?:name|tool|tool_name)\s*>([\s\S]*?)<\s*\/\s*(?:name|tool|tool_name)\s*>/i.exec(body);
  if (nameTagMatch?.[1] !== undefined && !toolName) {
    toolName = nameTagMatch[1].trim();
  }

  // Unwrap <arguments>...</arguments> or <parameters>...</parameters> if present
  const argsWrap = /<\s*(?:arguments|parameters|args|input)(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*(?:arguments|parameters|args|input)\s*>/i.exec(body);
  if (argsWrap?.[1] !== undefined) {
    body = argsWrap[1].trim();
  }

  const taskItems: Array<{ scope?: string; task: string }> = [];
  let foundXmlParam = false;
  let pos = 0;

  while (pos < body.length) {
    const openRe = /<\s*([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*?)?(\/?)\s*>/g;
    openRe.lastIndex = pos;
    const openMatch = openRe.exec(body);
    if (!openMatch || openMatch[1] === undefined) break;

    const rawTagName = openMatch[1];
    const tagAttrs = parseXmlAttributes(openMatch[2] ?? '');
    const isSelfClosing = openMatch[3] === '/';
    const contentStart = openMatch.index + openMatch[0].length;

    let inner = '';
    if (isSelfClosing) {
      pos = contentStart;
    } else {
      const closeRe = new RegExp(`<\\s*\\/\\s*${rawTagName}\\s*>`, 'gi');
      closeRe.lastIndex = contentStart;
      const closeMatch = closeRe.exec(body);
      if (closeMatch) {
        inner = body.slice(contentStart, closeMatch.index);
        pos = closeMatch.index + closeMatch[0].length;
      } else {
        inner = body.slice(contentStart);
        pos = body.length;
      }
    }

    foundXmlParam = true;
    const tagLower = rawTagName.toLowerCase();

    if ((tagLower === 'name' || tagLower === 'tool' || tagLower === 'tool_name' || tagLower === 'function') && !tagAttrs.name) {
      if (!toolName && inner.trim()) toolName = inner.trim();
      continue;
    }

    const paramKey =
      (tagLower === 'parameter' || tagLower === 'param' || tagLower === 'arg' || tagLower === 'argument' || tagLower === 'field') &&
      (tagAttrs.name ?? tagAttrs.key)
        ? (tagAttrs.name ?? tagAttrs.key)!
        : rawTagName;

    if (paramKey === 'task') {
      const scopeAttr = tagAttrs.scope?.trim();
      const trimmedTask = inner.trim();
      if (trimmedTask) {
        taskItems.push(scopeAttr ? { scope: scopeAttr, task: trimmedTask } : { task: trimmedTask });
      }
      continue;
    }

    if (paramKey === 'tasks') {
      const extracted = extractTaskElements(inner);
      if (extracted.length > 0) {
        taskItems.push(...extracted);
      } else {
        const parsedVal = parseXmlParamValue('tasks', inner);
        if (Array.isArray(parsedVal)) {
          args.tasks = parsedVal;
        } else if (typeof parsedVal === 'string' && parsedVal) {
          args.tasks = parsedVal.split('\n').map((s) => s.trim()).filter(Boolean);
        }
      }
      continue;
    }

    const val = isSelfClosing && tagAttrs.value !== undefined ? parseXmlParamValue(paramKey, tagAttrs.value) : parseXmlParamValue(paramKey, inner);
    const existing = args[paramKey];
    if (existing !== undefined) {
      if (Array.isArray(existing)) {
        if (Array.isArray(val)) existing.push(...val);
        else existing.push(val);
      } else {
        args[paramKey] = Array.isArray(val) ? [existing, ...val] : [existing, val];
      }
    } else {
      args[paramKey] = val;
    }
  }

  if (taskItems.length > 0) {
    if (taskItems.length === 1 && args.tasks === undefined) {
      const first = taskItems[0]!;
      if (first.scope !== undefined && args.scope === undefined) {
        args.scope = first.scope;
      }
      args.task = first.task;
    } else {
      args.tasks = taskItems.map((t) => (t.scope !== undefined ? { scope: t.scope, task: t.task } : { task: t.task }));
    }
  }

  // Key-value lines fallback inside <tool_call> when no XML child tags were used
  if (!foundXmlParam && body && !body.startsWith('{')) {
    const lines = body.split('\n');
    let kvCount = 0;
    let currentKey: string | undefined;
    const currentLines: string[] = [];
    const flushKv = () => {
      if (!currentKey) return;
      const valStr = currentLines.join('\n').trim();
      if ((currentKey === 'name' || currentKey === 'tool' || currentKey === 'tool_name') && !toolName) {
        toolName = valStr.replace(/^["']|["']$/g, '');
      } else {
        args[currentKey] = parseXmlParamValue(currentKey, valStr.replace(/^["']|["']$/g, ''));
      }
      currentKey = undefined;
      currentLines.length = 0;
    };
    for (const line of lines) {
      const m = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (m && m[1] !== undefined && m[2] !== undefined && KNOWN_PARAM_NAMES[m[1]]) {
        flushKv();
        currentKey = m[1];
        currentLines.push(m[2]);
        kvCount++;
      } else if (currentKey) {
        currentLines.push(line);
      }
    }
    flushKv();

    // Single shorthand scalar inside <calculator>2 + 2</calculator> or <grep>pattern</grep>
    if (kvCount === 0 && toolName && Object.keys(args).length === 0 && body.trim()) {
      const scalar = body.trim();
      if (toolName === 'calculator') args.expression = scalar;
      else if (toolName === 'grep' || toolName === 'tally') args.pattern = scalar;
      else if (toolName === 'search' || toolName === 'llm_query') args.query = scalar;
      else if (toolName === 'add_document') args.path = scalar;
      else if (toolName === 'read') args.document = scalar;
      else if (toolName === 'bash') args.command = scalar;
    }
  }

  const finalName =
    toolName ?? (Object.keys(args).length > 0 && contextText !== undefined ? inferBareToolName(args, contextText) : undefined);
  if (!finalName) return undefined;
  if (!foundXmlParam && Object.keys(args).length === 0 && !attrs && !fallbackName) return undefined;
  return { name: finalName, arguments: args };
}

function parseToolCall(
  raw: string,
  attrs: string | undefined,
  errors: string[],
  fallbackName?: string,
  contextText?: string,
): ToolAction | undefined {
  const trimmed = raw.trim();
  const hasXmlOrAttrs = Boolean(attrs && attrs.trim()) || (trimmed.startsWith('<') && !trimmed.startsWith('{'));
  if (hasXmlOrAttrs || (!trimmed.startsWith('{') && !trimmed.startsWith('```'))) {
    const structured = tryParseStructuredToolCall(raw, attrs, fallbackName, contextText);
    if (structured) return structured;
    if (hasXmlOrAttrs && !trimmed.includes('{')) {
      errors.push('tool_call.name is missing');
      return undefined;
    }
  }

  let obj: Record<string, unknown>;
  try {
    obj = parseLooseJSON<Record<string, unknown>>(raw);
  } catch (e) {
    const structured = tryParseStructuredToolCall(raw, attrs, fallbackName, contextText);
    if (structured) return structured;
    errors.push(`<tool_call> is not valid: ${(e as Error).message}`);
    return undefined;
  }
  const topAttrs = parseXmlAttributes(attrs ?? '');
  const attrName = topAttrs.name ?? topAttrs.tool ?? topAttrs.tool_name ?? topAttrs.function;
  // Accept OpenAI-style {"function": {"name", "arguments": "<json>"}} as well.
  const fn = (obj.function ?? obj) as Record<string, unknown>;
  const name =
    fn.name ??
    fn.tool ??
    fn.tool_name ??
    attrName ??
    fallbackName ??
    (contextText !== undefined ? inferBareToolName(fn, contextText) : undefined);
  if (typeof name !== 'string' || !name) {
    errors.push('tool_call.name is missing');
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
      errors.push('tool_call.arguments is a string, not valid JSON');
      return undefined;
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    errors.push('tool_call.arguments must be an object');
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
  const firstFoldOpen = openTagIndex(text, 'folding');
  const firstThinkOpen = openTagIndex(text, 'think');
  const hasLeadingThink =
    firstThinkOpen >= 0 && (firstFoldOpen < 0 || firstThinkOpen < firstFoldOpen);
  const thinkRaw = hasLeadingThink ? extractTag(text, 'think') : undefined;
  const body = thinkRaw !== undefined ? text.replace(tagRegex('think'), '') : text;
  const out: ParsedResponse = { errors, warnings, think: thinkRaw ?? opts.reasoning };

  const foldExt = extractGroupTagWithAttrs(body, FOLD_TAGS);
  let bareFold: string | undefined;
  if (foldExt && foldExt.tag !== 'folding') {
    warnings.push('used <folded_output>/<fold> alias for <folding>');
  }
  if (foldExt !== undefined && (foldExt.content.trim() !== '' || foldExt.attrs !== '')) {
    out.folding = parseFolding(foldExt.content, foldExt.attrs, warnings, errors);
  } else if (opts.expectFolding) {
    const motIdx = openTagIndex(body, 'motivation');
    const prefix = motIdx >= 0 ? body.slice(0, motIdx).trim() : body.trim();
    const candidate = prefix.startsWith('{') && /"range"\s*:/.test(prefix) ? extractBalanced(prefix) : undefined;
    if (candidate) {
      bareFold = candidate;
      warnings.push('folding missing <folding> tag');
      out.folding = parseFolding(candidate, undefined, warnings, errors);
    } else {
      warnings.push('missing <folding>');
    }
  }

  // Strip <folding> block before extracting <motivation>, <tool_call>, or <answer> so
  // literal protocol tags quoted inside a folding summary are never misparsed as actions.
  const afterFoldBody = (bareFold ? body.replace(bareFold, '') : body).replace(groupTagRegex(FOLD_TAGS), '');

  const motExt = extractGroupTagWithAttrs(afterFoldBody, MOTIVATION_TAGS);
  if (motExt?.content) out.motivation = motExt.content;

  const actionBody = afterFoldBody.replace(groupTagRegex(MOTIVATION_TAGS), '');
  const answer = extractTag(actionBody, 'answer');
  const toolExt = extractTagWithAttrs(actionBody, 'tool_call');
  if (answer !== undefined) {
    out.answer = answer;
    if (toolExt !== undefined) warnings.push('both <answer> and <tool_call> present; using <answer>');
  } else if (toolExt !== undefined) {
    out.toolCall = parseToolCall(toolExt.content, toolExt.attrs, errors, undefined, afterFoldBody);
  } else {
    let aliasMatch: ExtractedTag | undefined;
    for (const toolName of TOOL_TAG_ALIASES) {
      const ext = extractTagWithAttrs(actionBody, toolName);
      if (ext !== undefined) {
        aliasMatch = ext;
        break;
      }
    }
    if (aliasMatch) {
      out.toolCall = parseToolCall(aliasMatch.content, aliasMatch.attrs, errors, aliasMatch.tag, afterFoldBody);
      warnings.push(`used <${aliasMatch.tag}> tag instead of <tool_call>`);
    } else {
      // Last resort: bare JSON tool call without tags (excluding folding/motivation tags).
      const restBody = actionBody;
      const bare = extractBalanced(restBody) ?? extractBalanced(normalizeQuotes(restBody));
      if (bare) {
        const tempErrors: string[] = [];
        const parsedTool = parseToolCall(bare, undefined, tempErrors, undefined, restBody);
        if (parsedTool) {
          out.toolCall = parsedTool;
          warnings.push('tool call missing <tool_call> tag');
          if (!out.motivation) {
            const idx = restBody.indexOf('{');
            const pre = idx > 0 ? restBody.slice(0, idx).trim() : '';
            if (pre) out.motivation = pre;
          }
        } else {
          errors.push('response has neither <tool_call> nor <answer>');
        }
      } else {
        errors.push('response has neither <tool_call> nor <answer>');
      }
    }
  }
  if (!out.motivation && !out.answer) warnings.push('missing <motivation>');
  return out;
}
