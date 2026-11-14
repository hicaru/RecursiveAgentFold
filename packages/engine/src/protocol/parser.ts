import type { FoldDirective, ToolAction } from '../fold/state.js';
import { decodeXmlText, normalizeBranchArguments, stripCodeFence } from '../tools/branch-args.js';
import { extractBalanced, normalizeQuotes, parseLooseJSON } from '../util/json.js';

/** Replace Markdown fenced code blocks and inline code spans with spaces of equal length. */
export function maskMarkdownCode(text: string): string {
  if (!text.includes('`') && !text.includes('~')) return text;
  const maskMatch = (m: string): string => m.replace(/[^\r\n]/g, ' ');
  const withoutFences = text.replace(
    /(^|\r?\n)([ \t]*)(`{3,}|~{3,})[^\r\n]*\r?\n[\s\S]*?\r?\n[ \t]*\3[ \t]*(?=\r?\n|$)/g,
    (m) => maskMatch(m),
  );
  return withoutFences.replace(/(`+)([^`\r\n]+)\1/g, (m) => maskMatch(m));
}

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
  /** All tool calls parsed from this step in source order (supports parallel multi-tool batches). */
  toolCalls?: ToolAction[];
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
  oldText: true,
  newText: true,
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
  oldText: true,
  newText: true,
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
  oldText: true,
  newText: true,
  edits: true,
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
  readonly start: number;
  readonly end: number;
}

const DSML_MARKER_RE = /<\/?[|｜\uff5c]+DSML[|｜\uff5c]+/i;
const PROTOCOL_PARAM_MARKUP_RE = /<\s*\/?\s*(?:tool_call|parameter|param|folding|folded_output|motivation|answer)\b/i;

const ATTR_STYLE_PARAM_OPEN_RE = /<\s*(?:param_name|param|parameter|arg)\s*=\s*["']([^"'<>]+)["']\s*>/gi;
const ATTR_STYLE_PARAM_CLOSE_RE = /<\s*\/\s*(?:param_name|param|arg)\s*>/gi;

/** Convert leaked DeepSeek DSML tokens and `<param_name="key">` argument tags into standard XML tags. */
export function normalizeModelProtocolTokens(raw: string): string {
  let text = raw;
  if (ATTR_STYLE_PARAM_OPEN_RE.test(text)) {
    ATTR_STYLE_PARAM_OPEN_RE.lastIndex = 0;
    text = text
      .replace(ATTR_STYLE_PARAM_OPEN_RE, '<parameter name="$1">')
      .replace(ATTR_STYLE_PARAM_CLOSE_RE, '</parameter>');
  }
  ATTR_STYLE_PARAM_OPEN_RE.lastIndex = 0;
  if (!DSML_MARKER_RE.test(text)) return text;
  return text
    .replace(/<[|｜\uff5c]+DSML[|｜\uff5c]+invoke\b([^>]*)>/gi, '<tool_call$1>')
    .replace(/<\/[|｜\uff5c]+DSML[|｜\uff5c]+invoke\s*>/gi, '</tool_call>')
    .replace(/<[|｜\uff5c]+DSML[|｜\uff5c]+parameter\b([^>]*)>/gi, '<parameter$1>')
    .replace(/<\/[|｜\uff5c]+DSML[|｜\uff5c]+parameter\s*>/gi, '</parameter>')
    .replace(/<\/?[|｜\uff5c]+DSML[|｜\uff5c]+[^>]*>/gi, '');
}

function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingCloseTag(
  text: string,
  tagName: string,
  searchFrom: number,
): { readonly index: number; readonly end: number } | undefined {
  const esc = escapeTag(tagName);
  const tokenRe = new RegExp(`<\\s*(\\/?)\\s*${esc}(?:\\s[^>]*?)?(\\/?)\\s*>`, 'gi');
  tokenRe.lastIndex = searchFrom;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const isSelfClose = m[2] === '/';
    if (isClose) {
      depth -= 1;
      if (depth === 0) {
        return { index: m.index, end: m.index + m[0].length };
      }
    } else if (!isSelfClose) {
      depth += 1;
    }
  }
  return undefined;
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

function extractTagWithAttrs(text: string, tag: string, maskedText?: string): ExtractedTag | undefined {
  const scan = maskedText ?? text;
  const m = tagRegex(tag).exec(scan);
  if (m && m[2] !== undefined) {
    const openMatch = new RegExp(`^<\\s*${tag}(\\s[^>]*)?>`, 'i').exec(text.slice(m.index));
    const innerStart = m.index + (openMatch ? openMatch[0].length : 0);
    const closeMatch = new RegExp(`<\\s*\\/\\s*${tag}\\s*>$`, 'i').exec(scan.slice(m.index, m.index + m[0].length));
    const innerEnd = m.index + m[0].length - (closeMatch ? closeMatch[0].length : 0);
    return {
      tag,
      attrs: (openMatch?.[1] ?? m[1] ?? '').trim(),
      content: text.slice(innerStart, innerEnd).trim(),
      start: m.index,
      end: m.index + m[0].length,
    };
  }
  const selfClosing = new RegExp(`<\\s*${tag}(\\s[^>]*?)?\\/\\s*>`, 'i').exec(scan);
  if (selfClosing) {
    const rawSelf = new RegExp(`^<\\s*${tag}(\\s[^>]*?)?\\/\\s*>`, 'i').exec(text.slice(selfClosing.index));
    return {
      tag,
      attrs: (rawSelf?.[1] ?? selfClosing[1] ?? '').trim(),
      content: '',
      start: selfClosing.index,
      end: selfClosing.index + selfClosing[0].length,
    };
  }
  const openRe = new RegExp(`<\\s*${tag}(\\s[^>]*)?>`, 'i');
  const openMatch = openRe.exec(scan);
  if (!openMatch) return undefined;
  const rawOpen = openRe.exec(text.slice(openMatch.index));
  const start = openMatch.index + openMatch[0].length;
  let end = scan.length;
  for (const other of TAGS) {
    if (other === tag) continue;
    const re = new RegExp(`<\\s*${other}(?:\\s[^>]*)?>`, 'ig');
    re.lastIndex = start;
    const n = re.exec(scan);
    if (n && n.index >= start && n.index < end) end = n.index;
  }
  return {
    tag,
    attrs: (rawOpen?.[1] ?? openMatch[1] ?? '').trim(),
    content: text.slice(start, end).trim(),
    start: openMatch.index,
    end,
  };
}

function extractAllTagsWithAttrs(text: string, tag: string, maskedText?: string): ExtractedTag[] {
  const scan = maskedText ?? text;
  const out: ExtractedTag[] = [];
  let pos = 0;
  const openRe = new RegExp(`<\\s*${escapeTag(tag)}(\\s[^>]*?)?(\\/?)\\s*>`, 'gi');
  while (pos < scan.length) {
    openRe.lastIndex = pos;
    const openMatch = openRe.exec(scan);
    if (!openMatch) break;
    const tagStart = openMatch.index;
    const contentStart = tagStart + openMatch[0].length;
    const rawOpen = new RegExp(`^<\\s*${escapeTag(tag)}(\\s[^>]*?)?(\\/?)\\s*>`, 'i').exec(text.slice(tagStart));
    const attrs = (rawOpen?.[1] ?? openMatch[1] ?? '').trim();
    const selfClose = (rawOpen?.[2] ?? openMatch[2]) === '/';
    if (selfClose) {
      out.push({ tag, attrs, content: '', start: tagStart, end: contentStart });
      pos = contentStart;
      continue;
    }
    const close = findMatchingCloseTag(scan, tag, contentStart);
    if (close) {
      out.push({
        tag,
        attrs,
        content: text.slice(contentStart, close.index).trim(),
        start: tagStart,
        end: close.end,
      });
      pos = close.end;
      continue;
    }
    let fallbackEnd = scan.length;
    for (const other of TAGS) {
      const re = new RegExp(`<\\s*${other}(?:\\s[^>]*)?>`, 'ig');
      re.lastIndex = contentStart;
      const n = re.exec(scan);
      if (n && n.index >= contentStart && n.index < fallbackEnd) fallbackEnd = n.index;
    }
    out.push({
      tag,
      attrs,
      content: text.slice(contentStart, fallbackEnd).trim(),
      start: tagStart,
      end: fallbackEnd,
    });
    pos = fallbackEnd;
  }
  return out;
}

function extractGroupTagWithAttrs(text: string, tags: readonly string[], maskedText?: string): ExtractedTag | undefined {
  const scan = maskedText ?? text;
  const m = groupTagRegex(tags).exec(scan);
  if (m && m[1] !== undefined && m[3] !== undefined) {
    const matchedTag = m[1].toLowerCase();
    const rawOpen = new RegExp(`^<\\s*(?:${tags.join('|')})(\\s[^>]*)?>`, 'i').exec(text.slice(m.index));
    const innerStart = m.index + (rawOpen ? rawOpen[0].length : 0);
    const closeMatch = new RegExp(`<\\s*\\/\\s*(?:${tags.join('|')})\\s*>$`, 'i').exec(
      scan.slice(m.index, m.index + m[0].length),
    );
    const innerEnd = m.index + m[0].length - (closeMatch ? closeMatch[0].length : 0);
    return {
      tag: matchedTag,
      attrs: (rawOpen?.[1] ?? m[2] ?? '').trim(),
      content: text.slice(innerStart, innerEnd).trim(),
      start: m.index,
      end: m.index + m[0].length,
    };
  }
  for (const t of tags) {
    const ext = extractTagWithAttrs(text, t, scan);
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
    if (key) attrs[key] = decodeXmlText(val);
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
    const stripped = rawVal.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    return key === 'command'
      ? decodeXmlText(stripped)
      : decodeXmlText(stripped, { preserveHtmlEntitiesWhenRawTagsPresent: true });
  }
  const trimmed = rawVal.trim();
  if (LIST_PARAM_KEYS[key]) {
    const childMatches = [...trimmed.matchAll(/<\s*(?:item|value|doc|document|category|path)(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*(?:item|value|doc|document|category|path)\s*>/gi)];
    if (childMatches.length > 0) {
      return childMatches.map((m) => decodeXmlText(m[1] ?? '').trim()).filter(Boolean);
    }
    if (trimmed.startsWith('[')) {
      try {
        const parsed = parseLooseJSON(trimmed);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // Fall through to delimiter split
      }
    }
    const delimRe = key === 'paths' ? /\r?\n+/ : /[\n,]+/;
    return decodeXmlText(trimmed)
      .split(delimRe)
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  if (STRING_PARAM_KEYS[key]) {
    return decodeXmlText(trimmed);
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
      return decodeXmlText(trimmed);
    }
  }
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    const nested = parseNestedXmlChildren(trimmed);
    if (nested !== undefined) return nested;
  }
  return decodeXmlText(trimmed);
}

function parseNestedXmlChildren(xml: string): unknown {
  const entries: Array<{ tag: string; value: unknown }> = [];
  let pos = 0;
  while (pos < xml.length) {
    while (pos < xml.length && /\s/.test(xml[pos] ?? '')) pos++;
    if (pos >= xml.length) break;
    const openRe = /<\s*([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s[^>]*)?>/y;
    openRe.lastIndex = pos;
    const openMatch = openRe.exec(xml);
    const tag = openMatch?.[1];
    if (!openMatch || tag === undefined) return undefined;
    const start = openMatch.index + openMatch[0].length;
    const closeMatch = findMatchingCloseTag(xml, tag, start);
    if (!closeMatch) return undefined;
    const inner = xml.slice(start, closeMatch.index);
    entries.push({ tag, value: parseXmlParamValue(tag, inner) });
    pos = closeMatch.end;
  }
  if (entries.length === 0) return undefined;
  const firstTag = entries[0]?.tag;
  const allSameItemTag =
    entries.length > 1
      ? entries.every((e) => e.tag === firstTag)
      : firstTag === 'item' || firstTag === 'edit' || firstTag === 'entry';
  if (allSameItemTag) return entries.map((e) => e.value);
  const obj: Record<string, unknown> = {};
  for (const e of entries) {
    const prev = obj[e.tag];
    if (prev === undefined) obj[e.tag] = e.value;
    else if (Array.isArray(prev)) prev.push(e.value);
    else obj[e.tag] = [prev, e.value];
  }
  return obj;
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
  errors?: string[],
  fallbackName?: string,
  contextText?: string,
): ToolAction | undefined {
  const initialErrCount = errors?.length ?? 0;
  const topAttrs = parseXmlAttributes(attrs ?? '');
  let toolName: string | undefined =
    topAttrs.name ?? topAttrs.tool ?? topAttrs.tool_name ?? topAttrs.function ?? fallbackName;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(topAttrs)) {
    if (k === 'name' || k === 'tool' || k === 'tool_name' || k === 'function') continue;
    args[k] = parseXmlParamValue(k, v);
  }

  let body = stripCodeFence(raw.trim());

  // Unwrap <invoke name="...">...</invoke> or <tool_name>...</tool_name> wrapper inside <tool_call>
  const outerWrap = /^<\s*([a-zA-Z_][a-zA-Z0-9_-]*)(\s[^>]*)?>([\s\S]*)<\s*\/\s*\1\s*>$/i.exec(body);
  if (outerWrap && outerWrap[1] !== undefined && outerWrap[3] !== undefined) {
    const outerTag = outerWrap[1];
    const outerTagLower = outerTag.toLowerCase();
    const outerAttrs = parseXmlAttributes(outerWrap[2] ?? '');
    if (outerTagLower === 'invoke' || outerTagLower === 'function_call' || outerTagLower === 'tool') {
      toolName = outerAttrs.name ?? outerAttrs.tool ?? outerAttrs.function ?? toolName;
      body = stripCodeFence(outerWrap[3]);
    } else if (toolName === undefined && !KNOWN_PARAM_NAMES[outerTag] && !KNOWN_PARAM_NAMES[outerTagLower]) {
      toolName = toolName ?? outerTag;
      for (const [k, v] of Object.entries(outerAttrs)) {
        if (k === 'name' || k === 'tool') continue;
        args[k] = parseXmlParamValue(k, v);
      }
      body = stripCodeFence(outerWrap[3]);
    }
  }

  // If body after optional unwrap is JSON, parse JSON arguments with resolved toolName
  if (body.startsWith('{') || (toolName === 'branch' && body.startsWith('['))) {
    try {
      const jsonParsed: unknown = parseLooseJSON(body);
      if (toolName === 'branch' && Array.isArray(jsonParsed)) {
        return { name: 'branch', arguments: normalizeBranchArguments({ ...args, tasks: jsonParsed }) };
      }
      if (jsonParsed !== null && typeof jsonParsed === 'object' && !Array.isArray(jsonParsed)) {
        const jsonObj = jsonParsed as Record<string, unknown>;
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
          if (typeof jsonArgs === 'string') {
            jsonArgs = resolvedName === 'branch' ? normalizeBranchArguments(jsonArgs) : parseLooseJSON(jsonArgs);
          }
          if (resolvedName === 'branch' && Array.isArray(jsonArgs)) {
            return { name: 'branch', arguments: normalizeBranchArguments({ ...args, tasks: jsonArgs }) };
          }
          if (jsonArgs && typeof jsonArgs === 'object' && !Array.isArray(jsonArgs)) {
            const mergedArgs = { ...args, ...(jsonArgs as Record<string, unknown>) };
            return {
              name: resolvedName,
              arguments: resolvedName === 'branch' ? normalizeBranchArguments(mergedArgs) : mergedArgs,
            };
          }
        }
      }
    } catch {
      // Continue to XML / key-value / flexible branch parsing
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
    body = stripCodeFence(argsWrap[1]);
  }

  if (toolName === 'branch') {
    const bodyWithoutName = body.replace(
      /^\s*<\s*(?:name|tool|tool_name)\s*>[\s\S]*?<\s*\/\s*(?:name|tool|tool_name)\s*>\s*/i,
      '',
    );
    const normalizedBody = normalizeBranchArguments(bodyWithoutName);
    const merged = normalizeBranchArguments({ ...args, ...normalizedBody });
    if (Object.keys(merged).length > 0) {
      return { name: 'branch', arguments: merged };
    }
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
      const closeMatch = findMatchingCloseTag(body, rawTagName, contentStart);
      if (closeMatch) {
        inner = body.slice(contentStart, closeMatch.index);
        pos = closeMatch.end;
      } else {
        const attrKeyForScalar = tagAttrs.name ?? tagAttrs.key ?? rawTagName;
        if (MULTILINE_PRESERVE_KEYS[attrKeyForScalar]) {
          errors?.push('unclosed <' + rawTagName + '> tag in <tool_call>');
          return undefined;
        }
        errors?.push('unclosed <' + rawTagName + '> parameter tag in <tool_call>');
        const nextBoundaryRe = /<\s*(?:parameter|param|arg|field)\b|<\s*\/\s*tool_call\b[^>]*>|<\s*\/\s*[a-zA-Z_][a-zA-Z0-9_-]*\s*>/gi;
        nextBoundaryRe.lastIndex = contentStart;
        const nextBoundary = nextBoundaryRe.exec(body);
        if (nextBoundary) {
          inner = body.slice(contentStart, nextBoundary.index);
          pos = /^<\s*\//.test(nextBoundary[0]) ? nextBoundary.index + nextBoundary[0].length : nextBoundary.index;
        } else {
          inner = body.slice(contentStart);
          pos = body.length;
        }
      }
    }

    foundXmlParam = true;
    const tagLower = rawTagName.toLowerCase();

    if ((tagLower === 'name' || tagLower === 'tool' || tagLower === 'tool_name' || tagLower === 'function') && !tagAttrs.name) {
      if (!toolName && inner.trim()) toolName = inner.trim();
      continue;
    }

    const attrKey = tagAttrs.name ?? tagAttrs.key;
    const paramKey =
      (tagLower === 'parameter' || tagLower === 'param' || tagLower === 'arg' || tagLower === 'argument' || tagLower === 'field') &&
      attrKey !== undefined
        ? attrKey
        : rawTagName;
    if (paramKey === 'param_name') {
      errors?.push('replace placeholder <param_name> with the actual parameter tag name');
      return undefined;
    }

    if (paramKey === 'task') {
      const scopeAttr = tagAttrs.scope?.trim();
      const trimmedTask = decodeXmlText(inner).trim();
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

    const rawWithoutCdata = inner.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
    if (PROTOCOL_PARAM_MARKUP_RE.test(rawWithoutCdata)) {
      errors?.push(
        'unescaped protocol markup inside parameter "' +
          paramKey +
          '"; wrap literal XML tags in <![CDATA[...]]> or escape as &lt;...&gt;',
      );
      return undefined;
    }

    const val = isSelfClosing && tagAttrs.value !== undefined ? parseXmlParamValue(paramKey, tagAttrs.value) : parseXmlParamValue(paramKey, inner);
    const existing = args[paramKey];
    if (existing !== undefined) {
      if (!LIST_PARAM_KEYS[paramKey] && paramKey !== 'task' && paramKey !== 'tasks' && paramKey !== 'edit' && paramKey !== 'item') {
        errors?.push('duplicate scalar parameter "' + paramKey + '" in single <tool_call>; emit separate <tool_call> blocks for batched calls');
        return undefined;
      }
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
    const first = taskItems[0];
    if (taskItems.length === 1 && first !== undefined && args.tasks === undefined) {
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
      const m = /^([a-zA-Z_][a-zA-Z0-9_-]{0,63})\s*:\s*(.*)$/.exec(line);
      const isUrlScheme =
        m !== null && m[1] !== undefined && m[2] !== undefined && /^https?$|^ftp$|^file$/i.test(m[1]) && m[2].startsWith('//');
      if (m && m[1] !== undefined && m[2] !== undefined && !isUrlScheme && (KNOWN_PARAM_NAMES[m[1]] || toolName !== undefined)) {
        if (m[1] === 'param_name') {
          errors?.push('replace placeholder <param_name> with the actual parameter tag name');
          return undefined;
        }
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
      const scalar = decodeXmlText(body).trim();
      if (
        scalar.includes('\n') ||
        ((toolName === 'read' || toolName === 'add_document') && /\s+\d+(?:\s+\d+)?$/.test(scalar))
      ) {
        errors?.push('untagged multi-value body in <tool_call name="' + toolName + '">; wrap each argument in its XML tag');
        return undefined;
      }
      if (toolName === 'calculator') args.expression = scalar;
      else if (toolName === 'grep' || toolName === 'tally') args.pattern = scalar;
      else if (toolName === 'search' || toolName === 'llm_query') args.query = scalar;
      else if (toolName === 'add_document') args.path = scalar;
      else if (toolName === 'read') args.document = scalar;
      else if (toolName === 'bash') args.command = scalar;
    }
  }

  if ((errors?.length ?? 0) > initialErrCount) return undefined;

  const finalName =
    toolName ?? (Object.keys(args).length > 0 && contextText !== undefined ? inferBareToolName(args, contextText) : undefined);
  if (!finalName) return undefined;
  if (!foundXmlParam && Object.keys(args).length === 0 && !attrs && !fallbackName) return undefined;
  return { name: finalName, arguments: finalName === 'branch' ? normalizeBranchArguments(args) : args };
}

function parseToolCall(
  raw: string,
  attrs: string | undefined,
  errors: string[],
  fallbackName?: string,
  contextText?: string,
): ToolAction | undefined {
  const cleanedRaw = stripCodeFence(raw);
  const trimmed = cleanedRaw.trim();
  const hasXmlOrAttrs = Boolean(attrs && attrs.trim()) || (trimmed.startsWith('<') && !trimmed.startsWith('{'));
  if (hasXmlOrAttrs || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    const beforeErrors = errors.length;
    const structured = tryParseStructuredToolCall(cleanedRaw, attrs, errors, fallbackName, contextText);
    if (structured) return structured;
    if (errors.length > beforeErrors) return undefined;
    if (hasXmlOrAttrs && !trimmed.includes('{')) {
      errors.push('tool_call.name is missing');
      return undefined;
    }
  }

  let parsedJson: unknown;
  try {
    parsedJson = parseLooseJSON(cleanedRaw);
  } catch (e) {
    const beforeCatchErrors = errors.length;
    const structured = tryParseStructuredToolCall(cleanedRaw, attrs, errors, fallbackName, contextText);
    if (structured) return structured;
    if (errors.length > beforeCatchErrors) return undefined;
    errors.push(`<tool_call> is not valid: ${(e as Error).message}`);
    return undefined;
  }
  const topAttrs = parseXmlAttributes(attrs ?? '');
  const attrName = topAttrs.name ?? topAttrs.tool ?? topAttrs.tool_name ?? topAttrs.function;
  if (Array.isArray(parsedJson)) {
    const arrayToolName = attrName ?? fallbackName;
    if (arrayToolName === 'branch') {
      return { name: 'branch', arguments: normalizeBranchArguments(parsedJson) };
    }
    errors.push('tool_call.arguments must be an object');
    return undefined;
  }
  if (parsedJson === null || typeof parsedJson !== 'object') {
    errors.push('tool_call.arguments must be an object');
    return undefined;
  }
  const obj = parsedJson as Record<string, unknown>;
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
    if (name === 'branch') {
      args = normalizeBranchArguments(args);
    } else {
      try {
        args = parseLooseJSON(args);
      } catch {
        errors.push('tool_call.arguments is a string, not valid JSON');
        return undefined;
      }
    }
  }
  if (name === 'branch' && Array.isArray(args)) {
    return { name: 'branch', arguments: normalizeBranchArguments(args) };
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    errors.push('tool_call.arguments must be an object');
    return undefined;
  }
  return {
    name,
    arguments: name === 'branch' ? normalizeBranchArguments(args as Record<string, unknown>) : (args as Record<string, unknown>),
  };
}

interface ExtractedAnswer {
  readonly content: string;
  readonly start: number;
  readonly end: number;
}

const NESTED_ANSWER_RE = /^<\s*answer(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*answer\s*>$/i;

function unwrapNestedAnswer(content: string): string {
  let current = content;
  for (let m = NESTED_ANSWER_RE.exec(current); m !== null; m = NESTED_ANSWER_RE.exec(current)) {
    current = (m[1] ?? '').trim();
  }
  return current;
}

function extractAnswerSpan(actionBody: string, maskedBody: string): ExtractedAnswer | undefined {
  const openMatch = /<\s*answer(?:\s[^>]*)?>/i.exec(maskedBody);
  if (!openMatch) return undefined;
  const start = openMatch.index + openMatch[0].length;
  const closeRe = /<\s*\/\s*answer\s*>/gi;
  closeRe.lastIndex = start;
  let lastClose: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = closeRe.exec(maskedBody)) !== null) {
    lastClose = m;
  }
  if (lastClose !== null) {
    return {
      content: unwrapNestedAnswer(actionBody.slice(start, lastClose.index).trim()),
      start: openMatch.index,
      end: lastClose.index + lastClose[0].length,
    };
  }
  const fallback = extractTagWithAttrs(actionBody, 'answer', maskedBody);
  return fallback
    ? { content: fallback.content, start: fallback.start, end: fallback.end }
    : undefined;
}

export interface ParseOptions {
  /** True when a folding directive is required (every step except 0). */
  expectFolding: boolean;
  /** Provider reasoning, used as <think> when the text has none. */
  reasoning?: string;
}

export function parseAgentResponse(rawText: string, opts: ParseOptions): ParsedResponse {
  const errors: string[] = [];
  const warnings: string[] = [];
  const text = normalizeModelProtocolTokens(rawText);
  if (text !== rawText) {
    warnings.push('normalized DSML protocol tokens');
  }
  // Drop reasoning before looking for protocol tags; models sometimes mention
  // "<tool_call>" inside their thoughts.
  const firstFoldOpen = openTagIndex(text, 'folding');
  const firstThinkOpen = openTagIndex(text, 'think');
  const hasLeadingThink =
    firstThinkOpen >= 0 && (firstFoldOpen < 0 || firstThinkOpen < firstFoldOpen);
  const thinkRaw = hasLeadingThink ? extractTag(text, 'think') : undefined;
  const body = thinkRaw !== undefined ? text.replace(tagRegex('think'), '') : text;
  const out: ParsedResponse = { errors, warnings, think: thinkRaw ?? opts.reasoning };

  const maskedFullBody = maskMarkdownCode(body);
  const foldExt = extractGroupTagWithAttrs(body, FOLD_TAGS, maskedFullBody);
  let bareFold: string | undefined;
  if (foldExt && foldExt.tag !== 'folding') {
    warnings.push('used <folded_output>/<fold> alias for <folding>');
  }
  if (foldExt !== undefined && (foldExt.content.trim() !== '' || foldExt.attrs !== '')) {
    if (opts.expectFolding) {
      out.folding = parseFolding(foldExt.content, foldExt.attrs, warnings, errors);
    } else {
      const foldErrors: string[] = [];
      const parsedFold = parseFolding(foldExt.content, foldExt.attrs, warnings, foldErrors);
      if (parsedFold !== undefined && foldErrors.length === 0) {
        out.folding = parsedFold;
      }
      warnings.push('unexpected <folding> when expectFolding=false');
    }
  } else if (opts.expectFolding) {
    const motIdx = openTagIndex(maskedFullBody, 'motivation');
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

  // Strip <folding> span before extracting <motivation>, <tool_call>, or <answer> so
  // literal protocol tags quoted inside a folding summary are never misparsed as actions.
  const afterFoldBody =
    foldExt !== undefined
      ? `${body.slice(0, foldExt.start)}${body.slice(foldExt.end)}`
      : bareFold
        ? body.replace(bareFold, '')
        : body;

  const maskedAfterFold = maskMarkdownCode(afterFoldBody);
  const motExt = extractGroupTagWithAttrs(afterFoldBody, MOTIVATION_TAGS, maskedAfterFold);
  if (motExt?.content) out.motivation = motExt.content;

  const actionBody =
    motExt !== undefined
      ? `${afterFoldBody.slice(0, motExt.start)}${afterFoldBody.slice(motExt.end)}`
      : afterFoldBody;
  const maskedActionBody = maskMarkdownCode(actionBody);
  const answerSpan = extractAnswerSpan(actionBody, maskedActionBody);
  const allToolTags = extractAllTagsWithAttrs(actionBody, 'tool_call', maskedActionBody);
  const outsideToolTags =
    answerSpan !== undefined
      ? allToolTags.filter((t) => t.end <= answerSpan.start || t.start >= answerSpan.end)
      : allToolTags;

  if (outsideToolTags.length > 0) {
    if (answerSpan !== undefined) {
      warnings.push('both <tool_call> and <answer> present; executing <tool_call>');
    }
    const parsedCalls: ToolAction[] = [];
    for (let i = 0; i < outsideToolTags.length; i++) {
      const ext = outsideToolTags[i];
      if (!ext) continue;
      const callErrors: string[] = [];
      const parsed = parseToolCall(ext.content, ext.attrs, callErrors, undefined, afterFoldBody);
      if (parsed && callErrors.length === 0) {
        parsedCalls.push(parsed);
      } else {
        errors.push(...callErrors);
      }
    }
    if (parsedCalls.length > 0 && parsedCalls.length === outsideToolTags.length) {
      out.toolCalls = parsedCalls;
      out.toolCall = parsedCalls[0];
      errors.length = 0;
    }
  } else if (answerSpan !== undefined) {
    out.answer = answerSpan.content;
  } else {
    const aliasActions: ToolAction[] = [];
    for (const toolName of TOOL_TAG_ALIASES) {
      const exts = extractAllTagsWithAttrs(actionBody, toolName, maskedActionBody);
      if (exts.length > 0) {
        for (let i = 0; i < exts.length; i++) {
          const ext = exts[i];
          if (!ext) continue;
          const parsed = parseToolCall(ext.content, ext.attrs, errors, ext.tag, afterFoldBody);
          if (parsed) aliasActions.push(parsed);
        }
        if (aliasActions.length > 0) {
          warnings.push(`used <${toolName}> tag instead of <tool_call>`);
          break;
        }
      }
    }
    if (aliasActions.length > 0) {
      out.toolCalls = aliasActions;
      out.toolCall = aliasActions[0];
    } else {
      // Last resort: bare JSON tool call without tags (excluding folding/motivation tags).
      const restBody = actionBody;
      const bare = extractBalanced(restBody) ?? extractBalanced(normalizeQuotes(restBody));
      if (bare) {
        const tempErrors: string[] = [];
        const parsedTool = parseToolCall(bare, undefined, tempErrors, undefined, restBody);
        if (parsedTool) {
          out.toolCall = parsedTool;
          out.toolCalls = [parsedTool];
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
