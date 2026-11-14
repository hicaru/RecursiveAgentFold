import { parseLooseJSON } from '../util/json.js';
import { ToolArgumentError } from './types.js';

export interface SubTaskSpec {
  readonly scope?: string;
  readonly task: string;
  readonly cwd?: string;
}

export interface NormalizedBranchArgs {
  readonly scope?: string;
  readonly task?: string;
  readonly tasks?: readonly SubTaskSpec[];
  readonly max_steps?: number;
  readonly cwd?: string;
}

const CONTAINER_KEYS: readonly string[] = Object.freeze([
  'tasks',
  'branches',
  'subtasks',
  'sub_tasks',
  'subTasks',
  'items',
  'specs',
  'work',
  'jobs',
  'delegations',
  'targets',
  'calls',
  'agents',
  'specialists',
]);

const ENVELOPE_KEYS: readonly string[] = Object.freeze([
  'arguments',
  'args',
  'parameters',
  'params',
  'input',
  'branch',
  'data',
]);

const SCOPE_KEYS: readonly string[] = Object.freeze([
  'scope',
  'target',
  'path',
  'file',
  'file_path',
  'filePath',
  'document',
  'doc',
  'doc_id',
  'docId',
  'module',
  'pkg',
  'package',
  'dir',
  'directory',
  'folder',
  'area',
  'domain',
  'topic',
  'component',
  'crate',
  'service',
  'id',
  'name',
  'key',
]);

const TASK_KEYS: readonly string[] = Object.freeze([
  'task',
  'prompt',
  'question',
  'instruction',
  'instructions',
  'query',
  'goal',
  'objective',
  'description',
  'brief',
  'request',
  'message',
  'todo',
  'action',
  'text',
  'body',
  'content',
  'value',
]);

const STEP_KEYS: readonly string[] = Object.freeze([
  'max_steps',
  'maxSteps',
  'steps',
  'step_budget',
  'stepBudget',
  'budget',
]);

const CWD_ONLY_KEYS: readonly string[] = Object.freeze(['cwd', 'workdir', 'working_directory', 'workingDirectory']);
const CWD_KEYS: readonly string[] = Object.freeze([...CWD_ONLY_KEYS, 'dir']);

const MULTI_SCOPE_KEYS: readonly string[] = Object.freeze(['scopes', 'paths', 'documents', 'modules', 'dirs']);

const RESERVED_MAP_KEYS: ReadonlySet<string> = new Set(
  Object.freeze([
    ...CONTAINER_KEYS,
    ...ENVELOPE_KEYS,
    ...SCOPE_KEYS,
    ...TASK_KEYS,
    ...STEP_KEYS,
    ...CWD_ONLY_KEYS,
    ...MULTI_SCOPE_KEYS,
    'tool',
    'tool_name',
    'function',
    'type',
    'parallel',
    'concurrency',
    'depth',
  ]),
);

const XML_ITEM_TAGS: ReadonlySet<string> = new Set(
  Object.freeze(['task', 'branch', 'subtask', 'sub_task', 'item', 'job', 'spec', 'agent', 'specialist', 'delegation', 'entry']),
);

const XML_WRAPPER_TAGS: ReadonlySet<string> = new Set(
  Object.freeze(['tasks', 'branches', 'subtasks', 'sub_tasks', 'items', 'jobs', 'specs', 'arguments', 'parameters', 'args', 'input']),
);

const XML_ENTITY_RE = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|quot|apos|amp));/g;

/** Unwrap CDATA sections and decode standard XML character entities. */
export function decodeXmlText(raw: string, options?: { readonly preserveHtmlEntitiesWhenRawTagsPresent?: boolean }): string {
  if (!raw.includes('&') && !raw.includes('<![CDATA[')) return raw;
  const cdataParts: string[] = [];
  const masked = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, inner: string) => {
    const idx = cdataParts.length;
    cdataParts.push(inner);
    return `\u0000CDATA_${idx}\u0000`;
  });
  const skipDecode =
    options?.preserveHtmlEntitiesWhenRawTagsPresent === true &&
    /<([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>[\s\S]*<\s*\/\s*\1\s*>/.test(masked);
  const decoded = skipDecode
    ? masked
    : masked.replace(XML_ENTITY_RE, (full, dec?: string, hex?: string, named?: string) => {
        if (dec !== undefined) {
          const code = Number.parseInt(dec, 10);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
        }
        if (hex !== undefined) {
          const code = Number.parseInt(hex, 16);
          return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
        }
        switch (named) {
          case 'lt':
            return '<';
          case 'gt':
            return '>';
          case 'quot':
            return '"';
          case 'apos':
            return "'";
          case 'amp':
            return '&';
          default:
            return full;
        }
      });
  if (cdataParts.length === 0) return decoded;
  return decoded.replace(/\u0000CDATA_(\d+)\u0000/g, (_m, idxStr: string) => cdataParts[Number(idxStr)] ?? '');
}

/** Strip outer Markdown code fences when present. */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1\s*$/.exec(trimmed);
  return m?.[2] !== undefined ? m[2].trim() : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pickString(rec: Readonly<Record<string, unknown>>, keys: readonly string[]): string | undefined {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    const v = rec[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
  }
  return undefined;
}

function pickCwd(rec: Readonly<Record<string, unknown>>, hasTask: boolean): string | undefined {
  return pickString(rec, hasTask ? CWD_KEYS : CWD_ONLY_KEYS);
}

function makeSubTaskSpec(task: string, scope?: string, cwd?: string): SubTaskSpec {
  return {
    ...(scope !== undefined && scope !== '' ? { scope } : {}),
    task,
    ...(cwd !== undefined && cwd !== '' ? { cwd } : {}),
  };
}

function findClosingTag(
  text: string,
  tagName: string,
  searchFrom: number,
): { readonly index: number; readonly end: number } | undefined {
  const esc = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tokenRe = new RegExp(`<\\s*(\\/?)\\s*${esc}(?:\\s[^>]*?)?(\\/?)\\s*>`, 'gi');
  tokenRe.lastIndex = searchFrom;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(text)) !== null) {
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return { index: m.index, end: m.index + m[0].length };
    } else if (m[2] !== '/') {
      depth += 1;
    }
  }
  return undefined;
}
function pickNumber(rec: Readonly<Record<string, unknown>>, keys: readonly string[]): number | undefined {
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === undefined) continue;
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const n = Number(v.trim());
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function unquoteScalar(raw: string): string {
  const s = raw.trim();
  if (s.length >= 6 && ((s.startsWith('"""') && s.endsWith('"""')) || (s.startsWith("'''") && s.endsWith("'''")))) {
    return s.slice(3, -3).trim();
  }
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"')
      ? inner.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : inner;
  }
  return s;
}

/** Parse shorthand string forms like `[scope=docs] Study...` or `packages/engine: Study...`. */
export function parseShorthandTaskString(raw: string, fallbackScope?: string): SubTaskSpec | undefined {
  const cleaned = raw.trim();
  if (cleaned === '') return undefined;

  const explicitBracket = /^\[(?:scope|target|path|module)\s*[:=]\s*([^\]]+)\]\s*([\s\S]+)$/i.exec(cleaned);
  if (explicitBracket?.[1] !== undefined && explicitBracket[2] !== undefined) {
    const scope = unquoteScalar(explicitBracket[1]);
    const task = explicitBracket[2].trim();
    if (task !== '') return scope !== '' ? { scope, task } : { task };
  }

  const bracketScope = /^\[([A-Za-z0-9_./@-]{1,120})\]\s+([\s\S]+)$/.exec(cleaned);
  if (bracketScope?.[1] !== undefined && bracketScope[2] !== undefined) {
    const scope = bracketScope[1].trim();
    const task = bracketScope[2].trim();
    if (task !== '' && !/^\d+$/.test(scope)) return { scope, task };
  }

  const arrow = /^(?:\*\*|`|"|')?([A-Za-z0-9_./@-]{1,120})(?:\*\*|`|"|')?\s*(?:=>|->)\s*([\s\S]+)$/.exec(cleaned);
  if (arrow?.[1] !== undefined && arrow[2] !== undefined) {
    const scope = arrow[1].trim();
    const task = arrow[2].trim();
    if (task !== '') return { scope, task };
  }

  const boldOrCodeSep =
    /^(?:\*\*([A-Za-z0-9_./@-]{1,120})\*\*|`([A-Za-z0-9_./@-]{1,120})`)(?:\s*:\s+|\s+[—–-]\s+)([\s\S]+)$/.exec(cleaned);
  if (boldOrCodeSep?.[3] !== undefined) {
    const scope = (boldOrCodeSep[1] ?? boldOrCodeSep[2] ?? '').trim();
    const task = boldOrCodeSep[3].trim();
    if (scope !== '' && task !== '') return { scope, task };
  }

  const pathSep = /^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)(?:\s*:\s+|\s+[—–-]\s+)([\s\S]+)$/.exec(cleaned);
  if (pathSep?.[1] !== undefined && pathSep[2] !== undefined) {
    const scope = pathSep[1].trim();
    const task = pathSep[2].trim();
    if (task !== '') return { scope, task };
  }

  return fallbackScope !== undefined && fallbackScope !== '' ? { scope: fallbackScope, task: cleaned } : { task: cleaned };
}

function parseXmlAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!attrString) return attrs;
  const re = /([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (key !== undefined) attrs[key] = decodeXmlText(val);
  }
  return attrs;
}

/** Parse XML representations of branch tasks, including nested, self-closing, paired, and custom-scope tags. */
function parseXmlBranchTasks(raw: string, fallbackScope?: string): SubTaskSpec[] | undefined {
  const text = raw.trim();
  if (!text.startsWith('<')) return undefined;

  let working = text;
  for (;;) {
    const openWrap = /^<\s*([a-zA-Z_][a-zA-Z0-9_./-]*)(?:\s[^>]*)?>/i.exec(working);
    const tag = openWrap?.[1]?.toLowerCase();
    if (openWrap && tag !== undefined && (XML_WRAPPER_TAGS.has(tag) || tag === 'tool_call' || tag === 'invoke')) {
      const close = findClosingTag(working, openWrap[1] ?? tag, openWrap[0].length);
      if (close !== undefined && close.end === working.length) {
        working = working.slice(openWrap[0].length, close.index).trim();
        continue;
      }
    }
    break;
  }
  if (working !== text && !working.startsWith('<')) {
    const unwrapped = parseFlexibleBranchTasks(working, fallbackScope);
    return unwrapped.length > 0 ? unwrapped : undefined;
  }
  const elements: Array<{ readonly tag: string; readonly attrs: Record<string, string>; readonly body: string }> = [];
  let pos = 0;
  while (pos < working.length) {
    const ws = /^\s*/.exec(working.slice(pos));
    pos += ws?.[0].length ?? 0;
    if (pos >= working.length) break;
    if (working.startsWith('<!--', pos)) {
      const endComment = working.indexOf('-->', pos + 4);
      pos = endComment >= 0 ? endComment + 3 : working.length;
      continue;
    }
    const openRe = /<\s*([a-zA-Z_][a-zA-Z0-9_./-]*)(\s[^>]*?)?(\/?)\s*>/y;
    openRe.lastIndex = pos;
    const m = openRe.exec(working);
    if (!m || m[1] === undefined) break;
    const tagName = m[1];
    const attrs = parseXmlAttrs(m[2] ?? '');
    const selfClosing = m[3] === '/';
    const contentStart = m.index + m[0].length;
    if (selfClosing) {
      elements.push({ tag: tagName, attrs, body: '' });
      pos = contentStart;
      continue;
    }
    const closeMatch = findClosingTag(working, tagName, contentStart);
    if (!closeMatch) {
      elements.push({ tag: tagName, attrs, body: working.slice(contentStart) });
      pos = working.length;
    } else {
      elements.push({ tag: tagName, attrs, body: working.slice(contentStart, closeMatch.index) });
      pos = closeMatch.end;
    }
  }

  if (elements.length === 0) return undefined;

  const out: SubTaskSpec[] = [];
  let pendingScope: string | undefined;

  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el === undefined) continue;
    const lower = el.tag.toLowerCase();

    if (XML_WRAPPER_TAGS.has(lower)) {
      const nested = parseFlexibleBranchTasks(el.body, fallbackScope);
      if (nested.length > 0) out.push(...nested);
      continue;
    }

    if ((lower === 'param' || lower === 'parameter' || lower === 'arg' || lower === 'field') && (el.attrs.name ?? el.attrs.key)) {
      const pName = (el.attrs.name ?? el.attrs.key ?? '').toLowerCase();
      if (SCOPE_KEYS.includes(pName)) {
        pendingScope = decodeXmlText(el.body).trim();
        continue;
      }
      if (TASK_KEYS.includes(pName)) {
        const taskVal = decodeXmlText(el.body).trim();
        if (taskVal !== '') {
          const scope = pendingScope ?? fallbackScope;
          out.push(scope !== undefined && scope !== '' ? { scope, task: taskVal } : { task: taskVal });
          pendingScope = undefined;
        }
        continue;
      }
      if (CONTAINER_KEYS.includes(pName)) {
        const nested = parseFlexibleBranchTasks(el.body, fallbackScope);
        if (nested.length > 0) out.push(...nested);
        continue;
      }
    }

    if (SCOPE_KEYS.includes(lower) && Object.keys(el.attrs).length === 0) {
      pendingScope = decodeXmlText(el.body).trim();
      continue;
    }

    if (STEP_KEYS.includes(lower)) continue;

    if (XML_ITEM_TAGS.has(lower) || TASK_KEYS.includes(lower)) {
      let scope = pickString(el.attrs, SCOPE_KEYS) ?? pendingScope;
      let cwd = pickCwd(el.attrs, true);
      let taskText = pickString(el.attrs, TASK_KEYS);
      let body = el.body.trim();

      if (body.startsWith('<')) {
        if (/^<\s*(?:tasks|branches|subtasks|sub_tasks|items|jobs|specs|task|branch|subtask|sub_task|item)\b/i.test(body)) {
          const nested = parseFlexibleBranchTasks(body, scope ?? fallbackScope);
          if (nested.length > 0) {
            out.push(...nested);
            pendingScope = undefined;
            continue;
          }
        }
        const childParsed = parseXmlChildFields(body, scope ?? fallbackScope);
        if (childParsed !== undefined) {
          if (childParsed.tasks !== undefined && childParsed.tasks.length > 0) {
            out.push(...childParsed.tasks);
            pendingScope = undefined;
            continue;
          }
          scope = childParsed.scope ?? scope;
          cwd = childParsed.cwd ?? cwd;
          if (childParsed.task !== undefined) taskText = childParsed.task;
          body = '';
        }
      }
      if (taskText === undefined && body !== '') {
        taskText = decodeXmlText(body).trim();
      }
      if (taskText !== undefined && taskText !== '') {
        out.push(makeSubTaskSpec(taskText, scope ?? fallbackScope, cwd));
        pendingScope = undefined;
      }
      continue;
    }

    // Custom scope tag: e.g. <docs>Study docs</docs> or <packages_engine>Study engine</packages_engine>
    const customBody = decodeXmlText(el.body).trim();
    if (customBody !== '' && !RESERVED_MAP_KEYS.has(lower)) {
      out.push({ scope: el.tag, task: customBody });
    }
  }

  return out.length > 0 ? out : undefined;
}

function parseXmlChildFields(
  xml: string,
  fallbackScope?: string,
): { readonly scope?: string; readonly task?: string; readonly cwd?: string; readonly tasks?: readonly SubTaskSpec[] } | undefined {
  const fields: Record<string, string> = {};
  const tagRe = /<\s*([a-zA-Z_][a-zA-Z0-9_-]*)(?:\s[^>]*)?>/gi;
  let pos = 0;
  let count = 0;
  let remainder = '';
  while (pos < xml.length) {
    tagRe.lastIndex = pos;
    const openMatch = tagRe.exec(xml);
    if (!openMatch || openMatch[1] === undefined) {
      remainder += xml.slice(pos);
      break;
    }
    remainder += xml.slice(pos, openMatch.index);
    const k = openMatch[1];
    const start = openMatch.index + openMatch[0].length;
    const close = findClosingTag(xml, k, start);
    const rawInner = close ? xml.slice(start, close.index) : xml.slice(start);
    const lower = k.toLowerCase();
    if (XML_WRAPPER_TAGS.has(lower)) {
      const nested = parseFlexibleBranchTasks(rawInner, fields.scope ?? fallbackScope);
      if (nested.length > 0) return { tasks: nested };
    }
    const decoded = decodeXmlText(rawInner).trim();
    fields[k] = decoded;
    fields[lower] = decoded;
    count++;
    pos = close ? close.end : xml.length;
  }
  if (count === 0) return undefined;
  const scope = pickString(fields, SCOPE_KEYS);
  const task = pickString(fields, TASK_KEYS) ?? (remainder.trim() !== '' ? decodeXmlText(remainder).trim() : undefined);
  const cwd = pickCwd(fields, task !== undefined);
  if (scope === undefined && task === undefined && cwd === undefined) return undefined;
  return {
    ...(scope !== undefined ? { scope } : {}),
    ...(task !== undefined ? { task } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

/** Parse TOML inline tables `{ scope = "a", task = "b" }` and arrays `[ ... ]`. */
function parseTomlInlineTable(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return undefined;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === '') return {};
  const out: Record<string, string> = {};
  const pairRe = /([A-Za-z0-9_./"-]+)\s*=\s*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*'|[^,}]+)(?:\s*,|$)/g;
  let m: RegExpExecArray | null;
  let matched = 0;
  while ((m = pairRe.exec(inner)) !== null) {
    const k = m[1] !== undefined ? unquoteScalar(m[1]) : '';
    const v = m[2] !== undefined ? unquoteScalar(m[2]) : '';
    if (k !== '') {
      out[k] = v;
      matched++;
    }
  }
  return matched > 0 ? out : undefined;
}

function splitTopLevelItems(listBody: string): string[] {
  const items: string[] = [];
  let depthBrace = 0;
  let depthBracket = 0;
  let quote: '"' | "'" | '' = '';
  let start = 0;
  for (let i = 0; i < listBody.length; i++) {
    const ch = listBody[i];
    const prev = i > 0 ? listBody[i - 1] : '';
    if (quote !== '') {
      if (ch === quote && prev !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{') depthBrace++;
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === ',' && depthBrace === 0 && depthBracket === 0) {
      const seg = listBody.slice(start, i).trim();
      if (seg !== '') items.push(seg);
      start = i + 1;
    }
  }
  const tail = listBody.slice(start).trim();
  if (tail !== '') items.push(tail);
  return items;
}

/** Parse TOML / INI representations: `[[tasks]]`, `[scope]`, `key = "val"`, `tasks = [{ scope = ... }]`. */
function parseTomlOrIniBranch(raw: string, fallbackScope?: string): NormalizedBranchArgs | undefined {
  const lines = raw.split(/\r?\n/);
  const hasArrayHeader = lines.some((l) => /^\s*\[\[\s*[^\]]+\s*\]\]\s*(?:#.*)?$/.test(l));
  const hasSectionHeader = lines.some((l) => /^\s*\[\s*(?![^=\]]*=)[^\]]+\s*\]\s*(?:#.*)?$/.test(l));
  const hasTomlAssign = lines.some((l) => /^\s*[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*\S/.test(l));
  if (!hasArrayHeader && !hasSectionHeader && !hasTomlAssign) return undefined;

  const tables: Array<{ headerScope?: string; fields: Record<string, unknown> }> = [];
  const rootFields: Record<string, unknown> = {};
  let currentFields: Record<string, unknown> = rootFields;

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i] ?? '';
    const trimmed = rawLine.trim();
    i++;
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    const arrHeader = /^\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/.exec(trimmed);
    if (arrHeader?.[1] !== undefined) {
      const fields: Record<string, unknown> = {};
      tables.push({ fields });
      currentFields = fields;
      continue;
    }

    const secHeader = /^\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$/.exec(trimmed);
    if (secHeader?.[1] !== undefined && !secHeader[1].includes('=')) {
      const secName = unquoteScalar(secHeader[1]);
      const fields: Record<string, unknown> = {};
      const headerScope = CONTAINER_KEYS.includes(secName) ? undefined : secName;
      tables.push({ ...(headerScope !== undefined ? { headerScope } : {}), fields });
      currentFields = fields;
      continue;
    }

    const assign = /^([A-Za-z0-9_./"-]+)\s*=\s*([\s\S]*)$/.exec(trimmed);
    if (!assign || assign[1] === undefined || assign[2] === undefined) continue;
    const key = unquoteScalar(assign[1]);
    let rhs = assign[2].trim();

    if ((rhs.startsWith('"""') && !rhs.slice(3).includes('"""')) || (rhs.startsWith("'''") && !rhs.slice(3).includes("'''"))) {
      const delim = rhs.slice(0, 3);
      const buf: string[] = [rhs];
      while (i < lines.length) {
        const nextLine = lines[i] ?? '';
        i++;
        buf.push(nextLine);
        if (nextLine.includes(delim)) break;
      }
      rhs = buf.join('\n');
      currentFields[key] = unquoteScalar(rhs);
      continue;
    }

    if (rhs.startsWith('[') && !rhs.endsWith(']')) {
      const buf: string[] = [rhs];
      let depth = (rhs.match(/\[/g)?.length ?? 0) - (rhs.match(/\]/g)?.length ?? 0);
      while (i < lines.length && depth > 0) {
        const nextLine = (lines[i] ?? '').replace(/\s*#.*$/, '');
        i++;
        if (nextLine.trim() === '') continue;
        buf.push(nextLine);
        depth += (nextLine.match(/\[/g)?.length ?? 0) - (nextLine.match(/\]/g)?.length ?? 0);
      }
      rhs = buf.join(' ');
    }

    rhs = rhs.replace(/\s+#[^"']*$/, '').trim();
    if (rhs.startsWith('[') && rhs.endsWith(']')) {
      const inner = rhs.slice(1, -1).trim();
      const rawItems = splitTopLevelItems(inner);
      const parsedItems = rawItems.map((entry) => parseTomlInlineTable(entry) ?? unquoteScalar(entry));
      currentFields[key] = parsedItems;
    } else {
      const inlineTbl = parseTomlInlineTable(rhs);
      currentFields[key] = inlineTbl ?? unquoteScalar(rhs);
    }
  }

  const collected: SubTaskSpec[] = [];
  for (let t = 0; t < tables.length; t++) {
    const tbl = tables[t];
    if (tbl === undefined) continue;
    const fromTbl = extractTasksFromRecord(tbl.fields, tbl.headerScope ?? fallbackScope);
    collected.push(...fromTbl);
  }
  const fromRoot = extractTasksFromRecord(rootFields, fallbackScope);
  collected.push(...fromRoot);

  const maxSteps = pickNumber(rootFields, STEP_KEYS);
  if (collected.length === 0) return undefined;
  if (collected.length === 1 && tables.length === 0 && !CONTAINER_KEYS.some((k) => k in rootFields)) {
    const single = collected[0];
    if (single === undefined) return undefined;
    return {
      ...(single.scope !== undefined ? { scope: single.scope } : {}),
      task: single.task,
      ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
    };
  }
  return {
    tasks: collected,
    ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
  };
}

/** Parse YAML block lists / maps and Markdown bulleted or numbered task lists. */
function parseYamlOrListBranch(raw: string, fallbackScope?: string): NormalizedBranchArgs | undefined {
  const lines = raw.split(/\r?\n/);
  const tasks: SubTaskSpec[] = [];
  let topScope = fallbackScope;
  let maxSteps: number | undefined;
  let inContainer = false;

  let currentItem: Record<string, string> | undefined;
  let blockKey: string | undefined;
  let blockIndent = 0;
  const blockLines: string[] = [];

  const flushBlock = () => {
    if (blockKey !== undefined && currentItem !== undefined) {
      currentItem[blockKey] = blockLines.join('\n').trim();
    }
    blockKey = undefined;
    blockLines.length = 0;
  };

  const flushItem = () => {
    flushBlock();
    if (currentItem === undefined) return;
    const extracted = extractTasksFromRecord(currentItem, topScope);
    tasks.push(...extracted);
    currentItem = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (blockKey !== undefined) {
      if (trimmed === '' || indent > blockIndent) {
        blockLines.push(trimmed === '' ? '' : line.slice(Math.min(line.length, blockIndent + 2)));
        continue;
      }
      flushBlock();
    }

    if (trimmed === '' || trimmed === '---' || trimmed === '...' || trimmed.startsWith('#')) continue;

    // Top-level header before list items (`tasks:`, `scope: docs`, `max_steps: 10`)
    if (indent === 0 && !trimmed.startsWith('-') && !/^\d+[.)]\s/.test(trimmed)) {
      const topKv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
      if (topKv?.[1] !== undefined && topKv[2] !== undefined) {
        const k = topKv[1];
        const v = topKv[2].trim();
        if (CONTAINER_KEYS.includes(k) && v === '') {
          flushItem();
          inContainer = true;
          continue;
        }
        if (SCOPE_KEYS.includes(k) && v !== '' && currentItem === undefined) {
          topScope = unquoteScalar(v);
          continue;
        }
        if (STEP_KEYS.includes(k) && v !== '') {
          const n = Number(unquoteScalar(v));
          if (Number.isFinite(n)) maxSteps = n;
          continue;
        }
        if (TASK_KEYS.includes(k) && v !== '' && !inContainer && tasks.length === 0) {
          currentItem ??= {};
          if (v === '|' || v === '>') {
            blockKey = k;
            blockIndent = indent;
          } else {
            currentItem[k] = unquoteScalar(v);
          }
          continue;
        }
        // YAML map under `tasks:\n  docs: Study docs`
        if (inContainer && v !== '') {
          flushItem();
          tasks.push({ scope: unquoteScalar(k), task: unquoteScalar(v) });
          continue;
        }
      }
    }

    // Indented map under `tasks:` without `-` (`  docs: Study docs`)
    if (inContainer && currentItem === undefined && indent > 0 && !trimmed.startsWith('-') && !/^\d+[.)]\s/.test(trimmed)) {
      const mapKv = /^([A-Za-z0-9_./"@'-]+)\s*:\s*(.+)$/.exec(trimmed);
      if (mapKv?.[1] !== undefined && mapKv[2] !== undefined) {
        const k = unquoteScalar(mapKv[1]);
        const v = unquoteScalar(mapKv[2]);
        if (!RESERVED_MAP_KEYS.has(k) && v !== '') {
          tasks.push({ scope: k, task: v });
          continue;
        }
      }
    }

    // Bullet item: `- ...`, `* ...`, `1. ...`
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(trimmed);
    if (bullet?.[1] !== undefined) {
      flushItem();
      const rest = bullet[1].trim();
      if (rest.startsWith('{') && rest.endsWith('}')) {
        try {
          const obj: unknown = parseLooseJSON(rest);
          if (isRecord(obj)) {
            tasks.push(...extractTasksFromRecord(obj, topScope));
            continue;
          }
        } catch {
          // Fall through to KV / shorthand parsing
        }
      }
      const kv = /^([A-Za-z0-9_./"@'-]+)\s*:\s*(.*)$/.exec(rest);
      if (kv?.[1] !== undefined && kv[2] !== undefined) {
        const k = unquoteScalar(kv[1]);
        const v = kv[2].trim();
        if (SCOPE_KEYS.includes(k) || TASK_KEYS.includes(k) || STEP_KEYS.includes(k)) {
          currentItem = {};
          if (v === '|' || v === '>') {
            blockKey = k;
            blockIndent = indent;
          } else {
            currentItem[k] = unquoteScalar(v);
          }
          continue;
        }
        if (!RESERVED_MAP_KEYS.has(k) && v !== '' && !/\s/.test(k)) {
          tasks.push({ scope: k, task: unquoteScalar(v) });
          continue;
        }
      }
      const shorthand = parseShorthandTaskString(unquoteScalar(rest), topScope);
      if (shorthand !== undefined) tasks.push(shorthand);
      continue;
    }

    // Continuation property of current YAML list item (`  task: ...`)
    if (currentItem !== undefined && indent > 0) {
      const propKv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(trimmed);
      if (propKv?.[1] !== undefined && propKv[2] !== undefined) {
        const k = propKv[1];
        const v = propKv[2].trim();
        if (v === '|' || v === '>') {
          blockKey = k;
          blockIndent = indent;
        } else {
          currentItem[k] = unquoteScalar(v);
        }
      }
    }
  }

  flushItem();
  if (tasks.length === 0) return undefined;
  if (tasks.length === 1 && !inContainer && !lines.some((l) => /^\s*(?:[-*+]|\d+[.)])\s+/.test(l))) {
    const single = tasks[0];
    if (single === undefined) return undefined;
    return {
      ...(single.scope !== undefined ? { scope: single.scope } : {}),
      task: single.task,
      ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
    };
  }
  return {
    tasks,
    ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
  };
}

function coerceScopeList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((x): x is string => typeof x === 'string')
      .map((s) => s.trim())
      .filter((s) => s !== '');
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const s = stripCodeFence(raw);
    if (s.startsWith('[')) {
      try {
        const parsed: unknown = parseLooseJSON(s);
        if (Array.isArray(parsed)) return coerceScopeList(parsed);
      } catch {
        // Fall through
      }
    }
    return s
      .split(/[\n,]+/)
      .map((item) => unquoteScalar(item))
      .filter((item) => item !== '');
  }
  return [];
}

function extractTasksFromRecord(rec: Readonly<Record<string, unknown>>, fallbackScope?: string): SubTaskSpec[] {
  // Unwrap single nested envelope if present (`{ arguments: { ... } }`)
  for (let i = 0; i < ENVELOPE_KEYS.length; i++) {
    const envKey = ENVELOPE_KEYS[i];
    if (envKey === undefined) continue;
    const envVal = rec[envKey];
    if (isRecord(envVal)) {
      const inner = extractTasksFromRecord(envVal, fallbackScope);
      if (inner.length > 0) return inner;
    } else if (typeof envVal === 'string' && envVal.trim() !== '') {
      const inner = parseFlexibleBranchTasks(envVal, fallbackScope);
      if (inner.length > 0) return inner;
    }
  }

  const explicitScope = pickString(rec, SCOPE_KEYS) ?? fallbackScope;
  const multiScopes = (() => {
    for (let i = 0; i < MULTI_SCOPE_KEYS.length; i++) {
      const k = MULTI_SCOPE_KEYS[i];
      if (k !== undefined && rec[k] !== undefined) {
        const list = coerceScopeList(rec[k]);
        if (list.length > 0) return list;
      }
    }
    if (Array.isArray(rec.scope)) return coerceScopeList(rec.scope);
    return [];
  })();

  // Check container properties (`tasks`, `branches`, `subtasks`, `items`, ...)
  for (let i = 0; i < CONTAINER_KEYS.length; i++) {
    const key = CONTAINER_KEYS[i];
    if (key === undefined || !(key in rec)) continue;
    const containerVal = rec[key];
    if (containerVal === undefined || containerVal === null || containerVal === '') continue;

    // Zip parallel `scopes: [...]` and `tasks: [...]` when lengths match and items have no scope
    const parsedList = parseFlexibleBranchTasks(containerVal, explicitScope);
    if (multiScopes.length > 0 && multiScopes.length === parsedList.length && parsedList.every((item) => item.scope === undefined)) {
      return parsedList.map((item, idx) => {
        const zippedScope = multiScopes[idx];
        return zippedScope !== undefined && zippedScope !== '' ? { scope: zippedScope, task: item.task } : item;
      });
    }
    if (parsedList.length > 0) return parsedList;
  }

  // Single task (or array of tasks under `task`) + optional `scopes` broadcast
  if (Array.isArray(rec.task)) {
    const list = parseFlexibleBranchTasks(rec.task, explicitScope);
    if (multiScopes.length > 0 && multiScopes.length === list.length && list.every((item) => item.scope === undefined)) {
      return list.map((item, idx) => {
        const zippedScope = multiScopes[idx];
        return zippedScope !== undefined && zippedScope !== '' ? { scope: zippedScope, task: item.task } : item;
      });
    }
    if (list.length > 0) return list;
  }

  const singleTask = pickString(rec, TASK_KEYS);
  const explicitCwd = pickCwd(rec, singleTask !== undefined);
  if (singleTask !== undefined) {
    const trimmedTask = stripCodeFence(singleTask);
    if (
      /^<\s*(?:tasks|branches|subtasks|sub_tasks|items|jobs|specs|task|branch|subtask|sub_task|item)\b/i.test(
        trimmedTask,
      ) ||
      trimmedTask.startsWith('[')
    ) {
      const unpacked = parseFlexibleBranchTasks(trimmedTask, explicitScope);
      if (unpacked.length > 0 && (unpacked.length > 1 || unpacked[0]?.task !== trimmedTask)) {
        return explicitCwd !== undefined ? unpacked.map((u) => makeSubTaskSpec(u.task, u.scope, u.cwd ?? explicitCwd)) : unpacked;
      }
    }
    if (multiScopes.length > 0) {
      return multiScopes.map((s) => makeSubTaskSpec(singleTask, s, explicitCwd));
    }
    return [makeSubTaskSpec(singleTask, explicitScope, explicitCwd)];
  }

  // Map-by-scope object: `{ "docs": "Study docs", "packages/engine": { prompt: "Study engine" } }`
  const entries = Object.entries(rec);
  const mapSpecs: SubTaskSpec[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === undefined) continue;
    const [k, v] = entry;
    const cleanKey = k.trim();
    if (cleanKey === '' || RESERVED_MAP_KEYS.has(cleanKey)) continue;
    if (typeof v === 'string' && v.trim() !== '') {
      mapSpecs.push({ scope: cleanKey, task: v.trim() });
    } else if (isRecord(v)) {
      const nestedTask = pickString(v, TASK_KEYS);
      if (nestedTask !== undefined) {
        const nestedScope = pickString(v, SCOPE_KEYS) ?? cleanKey;
        const nestedCwd = pickCwd(v, true);
        mapSpecs.push(makeSubTaskSpec(nestedTask, nestedScope, nestedCwd));
      }
    }
  }
  return mapSpecs;
}

/**
 * Parse any `tasks` payload (array, map object, JSON, XML, TOML, YAML, Markdown list, or shorthand string)
 * into canonical `{ scope?, task }[]` specs. Throws `ToolArgumentError` on explicitly invalid array entries.
 */
export function parseFlexibleBranchTasks(raw: unknown, fallbackScope?: string): SubTaskSpec[] {
  if (raw === undefined || raw === null || raw === '') return [];

  if (Array.isArray(raw)) {
    const out: SubTaskSpec[] = [];
    for (let i = 0; i < raw.length; i++) {
      const item = raw[i];
      if (typeof item === 'string') {
        const trimmed = stripCodeFence(item);
        if (trimmed === '') throw new ToolArgumentError('tasks array cannot contain empty strings');
        if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('<')) {
          const nested = parseFlexibleBranchTasks(trimmed, fallbackScope);
          if (nested.length > 0) {
            out.push(...nested);
            continue;
          }
        }
        const spec = parseShorthandTaskString(trimmed, fallbackScope);
        if (spec === undefined) throw new ToolArgumentError('tasks array cannot contain empty strings');
        out.push(spec);
      } else if (isRecord(item)) {
        const specs = extractTasksFromRecord(item, fallbackScope);
        if (specs.length === 0) {
          throw new ToolArgumentError('task objects in tasks array must contain a non-empty "task" string');
        }
        out.push(...specs);
      } else {
        throw new ToolArgumentError('elements of tasks array must be strings or {scope, task} objects');
      }
    }
    return out;
  }

  if (isRecord(raw)) {
    return extractTasksFromRecord(raw, fallbackScope);
  }

  if (typeof raw === 'string') {
    const body = stripCodeFence(raw);
    if (body === '') return [];

    // 1. JSON array or object
    if (body.startsWith('[') || body.startsWith('{')) {
      try {
        const parsedJson: unknown = parseLooseJSON(body);
        if (Array.isArray(parsedJson) || isRecord(parsedJson)) {
          const res = parseFlexibleBranchTasks(parsedJson, fallbackScope);
          if (res.length > 0) return res;
        }
      } catch {
        // Not JSON (e.g. `[scope=docs] ...` or TOML `[[tasks]]`) — continue
      }
    }

    // 2. XML elements
    if (body.startsWith('<')) {
      const xmlTasks = parseXmlBranchTasks(body, fallbackScope);
      if (xmlTasks !== undefined && xmlTasks.length > 0) return xmlTasks;
    }

    // 3. TOML / INI tables or assignments
    const toml = parseTomlOrIniBranch(body, fallbackScope);
    if (toml !== undefined) {
      if (toml.tasks !== undefined && toml.tasks.length > 0) return [...toml.tasks];
      if (toml.task !== undefined) {
        return [toml.scope !== undefined ? { scope: toml.scope, task: toml.task } : { task: toml.task }];
      }
    }

    // 4. YAML / Markdown list / multi-line items
    if (body.includes('\n')) {
      const yaml = parseYamlOrListBranch(body, fallbackScope);
      if (yaml !== undefined) {
        if (yaml.tasks !== undefined && yaml.tasks.length > 0) return [...yaml.tasks];
        if (yaml.task !== undefined) {
          return [yaml.scope !== undefined ? { scope: yaml.scope, task: yaml.task } : { task: yaml.task }];
        }
      }
      const nonEmptyLines = body
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '');
      if (nonEmptyLines.length > 1 && nonEmptyLines.every((l) => /^\[[^\]]+\]\s+\S/.test(l) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]*\s*:\s+\S/.test(l))) {
        const lineSpecs: SubTaskSpec[] = [];
        for (let i = 0; i < nonEmptyLines.length; i++) {
          const lineSpec = parseShorthandTaskString(nonEmptyLines[i] ?? '', fallbackScope);
          if (lineSpec !== undefined) lineSpecs.push(lineSpec);
        }
        if (lineSpecs.length > 0) return lineSpecs;
      }
    }

    // 5. Single task string (never split prose on commas!)
    const single = parseShorthandTaskString(body, fallbackScope);
    return single !== undefined ? [single] : [];
  }

  throw new ToolArgumentError('argument "tasks" must be a task list');
}

/**
 * Normalize any raw `branch` tool input (object, array, or JSON/XML/TOML/YAML string)
 * into a schema-valid `{ scope?, task?, tasks?, max_steps? }` plain object.
 */
export function normalizeBranchArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};

  if (typeof input === 'string') {
    const cleaned = stripCodeFence(input);
    if (cleaned === '') return {};
    if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
      try {
        const parsed: unknown = parseLooseJSON(cleaned);
        return normalizeBranchArguments(parsed);
      } catch {
        // Fall through to XML / TOML / YAML
      }
    }
    if (cleaned.startsWith('<')) {
      const xmlTasks = parseXmlBranchTasks(cleaned);
      if (xmlTasks !== undefined && xmlTasks.length > 0) {
        const stepTag = /<\s*(?:max_steps|maxSteps|steps|step_budget|budget)\s*>\s*(\d+)\s*<\s*\/\s*(?:max_steps|maxSteps|steps|step_budget|budget)\s*>/i.exec(
          cleaned,
        );
        const stepAttr = /\b(?:max_steps|maxSteps|steps)\s*=\s*["']?(\d+)["']?/i.exec(cleaned);
        const maxStepsRaw = stepTag?.[1] ?? stepAttr?.[1];
        const xmlMaxSteps = maxStepsRaw !== undefined ? Number(maxStepsRaw) : undefined;
        const stepField = xmlMaxSteps !== undefined && Number.isFinite(xmlMaxSteps) ? { max_steps: xmlMaxSteps } : {};
        if (xmlTasks.length === 1) {
          const first = xmlTasks[0];
          return { ...makeSubTaskSpec(first?.task ?? '', first?.scope, first?.cwd), ...stepField };
        }
        return {
          tasks: xmlTasks.map((t) => makeSubTaskSpec(t.task, t.scope, t.cwd)),
          ...stepField,
        };
      }
    }
    const toml = parseTomlOrIniBranch(cleaned);
    if (toml !== undefined) return toPlainBranchRecord(toml);
    const yaml = parseYamlOrListBranch(cleaned);
    if (yaml !== undefined) return toPlainBranchRecord(yaml);
    const single = parseShorthandTaskString(cleaned);
    if (single !== undefined) {
      return single.scope !== undefined ? { scope: single.scope, task: single.task } : { task: single.task };
    }
    return {};
  }

  if (Array.isArray(input)) {
    try {
      const specs = parseFlexibleBranchTasks(input);
      if (specs.length > 0) {
        return { tasks: specs.map((t) => makeSubTaskSpec(t.task, t.scope, t.cwd)) };
      }
    } catch {
      return { tasks: input };
    }
    return {};
  }

  if (!isRecord(input)) return {};

  const maxSteps = pickNumber(input, STEP_KEYS);
  const explicitScope = pickString(input, SCOPE_KEYS);
  const explicitCwd = pickCwd(input, typeof input.task === 'string' || Array.isArray(input.tasks));

  // Preserve explicitly invalid `tasks` array elements so `branch.execute` can surface `ToolArgumentError` if needed,
  // while normalizing every valid object, string, map, XML, TOML, or YAML representation into `{ scope?, task }` objects!
  let hasContainer = false;
  for (let i = 0; i < CONTAINER_KEYS.length; i++) {
    const k = CONTAINER_KEYS[i];
    if (k !== undefined && input[k] !== undefined) {
      hasContainer = true;
      break;
    }
  }

  try {
    const specs = extractTasksFromRecord(input);
    if (specs.length === 0) {
      const out: Record<string, unknown> = {};
      if (explicitScope !== undefined) out.scope = explicitScope;
      if (explicitCwd !== undefined) out.cwd = explicitCwd;
      if (maxSteps !== undefined) out.max_steps = maxSteps;
      return Object.keys(out).length > 0 ? out : { ...input };
    }
    const multiScopes = MULTI_SCOPE_KEYS.some((k) => input[k] !== undefined) || Array.isArray(input.scope);
    if (!hasContainer && !multiScopes && specs.length === 1 && !Array.isArray(input.task)) {
      const only = specs[0];
      const out: Record<string, unknown> = {};
      const finalScope = only?.scope ?? explicitScope;
      const finalCwd = only?.cwd ?? explicitCwd;
      if (finalScope !== undefined) out.scope = finalScope;
      if (only?.task !== undefined) out.task = only.task;
      if (finalCwd !== undefined) out.cwd = finalCwd;
      if (maxSteps !== undefined) out.max_steps = maxSteps;
      return out;
    }
    const out: Record<string, unknown> = {
      tasks: specs.map((t) => makeSubTaskSpec(t.task, t.scope, t.cwd ?? explicitCwd)),
    };
    if (explicitScope !== undefined) out.scope = explicitScope;
    if (explicitCwd !== undefined) out.cwd = explicitCwd;
    if (maxSteps !== undefined) out.max_steps = maxSteps;
    return out;
  } catch {
    return { ...input };
  }
}

function toPlainBranchRecord(norm: NormalizedBranchArgs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (norm.scope !== undefined) out.scope = norm.scope;
  if (norm.task !== undefined) out.task = norm.task;
  if (norm.tasks !== undefined) {
    out.tasks = norm.tasks.map((t) => makeSubTaskSpec(t.task, t.scope, t.cwd));
  }
  if (norm.cwd !== undefined) out.cwd = norm.cwd;
  if (norm.max_steps !== undefined) out.max_steps = norm.max_steps;
  return out;
}
