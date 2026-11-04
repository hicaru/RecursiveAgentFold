import { truncateToTokens } from '../tokens.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

export interface DocumentToolOptions {
  /** Max lines returned by one read. Default 200. */
  maxReadLines?: number;
  /** Max tokens returned by one read. Default 4000. */
  maxReadTokens?: number;
  /** Max matching lines listed by grep. Default 40. */
  maxGrepMatches?: number;
}

export function createListDocumentsTool(): Tool {
  return {
    name: 'list_documents',
    description: 'List stored documents (id, title, size in tokens and lines).',
    parameters: { type: 'object', properties: {} },
    async execute(_args, ctx) {
      return ctx.store.manifest();
    },
  };
}

export function createGrepTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'grep',
    description:
      'Regex search over stored documents (JavaScript regex, case-insensitive by default). Returns total match count per document and the first matching lines with line numbers. Use for exact strings/patterns or to count pattern occurrences.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        documents: { type: 'array', items: { type: 'string' }, description: 'Document ids (default: all).' },
        case_sensitive: { type: 'boolean', default: false },
        max_matches: { type: 'integer', description: `Lines to list (default ${opts.maxGrepMatches ?? 40}, max 200).` },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern')!;
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`invalid regex: ${(e as Error).message}`);
      }
      const max = Math.min(200, argNumber(args, 'max_matches') ?? opts.maxGrepMatches ?? 40);
      const r = ctx.store.grep(pattern, {
        docIds: argStringList(args, 'documents'),
        ignoreCase: args.case_sensitive !== true,
        maxMatches: max,
      });
      const head = `grep /${pattern}/: ${r.total} matching line(s) — ${Object.entries(r.perDoc)
        .map(([d, n]) => `${d}: ${n}`)
        .join(', ')}`;
      const body = r.matches.map((m) => `${m.docId}:${m.line}| ${m.text}`).join('\n');
      const more = r.total > r.matches.length ? `\n… ${r.total - r.matches.length} more matching line(s) not shown` : '';
      return truncateToTokens(`${head}${body ? `\n${body}` : ''}${more}`, opts.maxReadTokens ?? 4000).text;
    },
  };
}

export function createTallyTool(): Tool {
  return {
    name: 'tally',
    description:
      'Exact frequency count of regex matches across stored documents. If the pattern has a capture group, counts each distinct value of group 1 (e.g. "User: (\\\\d+)" → occurrences per user id); otherwise counts the whole match. Returns the most frequent values first.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, optionally with one capture group.' },
        documents: { type: 'array', items: { type: 'string' } },
        case_sensitive: { type: 'boolean', default: false },
        top: { type: 'integer', description: 'How many values to list (default 25, max 200).' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern')!;
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`invalid regex: ${(e as Error).message}`);
      }
      const top = Math.min(200, argNumber(args, 'top') ?? 25);
      const r = ctx.store.tally(pattern, { docIds: argStringList(args, 'documents'), ignoreCase: args.case_sensitive !== true });
      const rows = r.counts.slice(0, top).map(([k, n]) => `${n}\t${k}`);
      return `tally /${pattern}/: ${r.totalMatches} match(es), ${r.distinct} distinct value(s)${r.distinct > top ? ` (top ${top} shown)` : ''}\ncount\tvalue\n${rows.join('\n')}`;
    },
  };
}

export function createReadTool(opts: DocumentToolOptions = {}): Tool {
  const maxLines = opts.maxReadLines ?? 200;
  return {
    name: 'read',
    description: `Read an exact line range of a stored document (max ${maxLines} lines per call). Use only for precise follow-up on locations found by llm_query or grep.`,
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string' },
        start_line: { type: 'integer', description: '1-based, inclusive.' },
        end_line: { type: 'integer', description: '1-based, inclusive.' },
      },
      required: ['document', 'start_line', 'end_line'],
    },
    async execute(args, ctx) {
      const doc = argString(args, 'document')!;
      const s = argNumber(args, 'start_line') ?? 1;
      let e = argNumber(args, 'end_line') ?? s + maxLines - 1;
      let note = '';
      if (e - s + 1 > maxLines) {
        e = s + maxLines - 1;
        note = ` (clamped to ${maxLines} lines)`;
      }
      const r = ctx.store.read(doc, s, e);
      const header = `${doc} lines ${r.startLine}-${r.endLine} of ${r.totalLines}${note}`;
      return truncateToTokens(`${header}\n${r.text}`, opts.maxReadTokens ?? 4000).text;
    },
  };
}
