import { defaultEstimator, truncateToTokens } from '../tokens.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

export interface DocumentToolOptions {
  /** Max lines returned by one read. Default 80. */
  readonly maxReadLines?: number;
  /** Max tokens returned by one read. Default 2400. */
  readonly maxReadTokens?: number;
  /** Max matching lines listed by grep. Default 25. */
  readonly maxGrepMatches?: number;
}

export const DEFAULT_DOCUMENT_TOOL_OPTIONS: Readonly<Required<DocumentToolOptions>> = Object.freeze({
  maxReadLines: 80,
  maxReadTokens: 2400,
  maxGrepMatches: 25,
});

export function createListDocumentsTool(): Tool {
  return {
    name: 'list_documents',
    description: 'List stored documents (id, title, token count, line count).',
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
      'Search stored documents with a JavaScript regex (case-insensitive by default). Returns total matching lines per document and the top matching lines with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression.' },
        documents: { type: 'array', items: { type: 'string' }, description: 'Document ids (default: all).' },
        case_sensitive: { type: 'boolean', default: false },
        max_matches: { type: 'integer', description: `Max matching lines to list (default ${opts.maxGrepMatches ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxGrepMatches}, max 100).` },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern') ?? '';
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`Invalid regex: ${(e as Error).message}`);
      }
      const max = Math.min(100, argNumber(args, 'max_matches') ?? opts.maxGrepMatches ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxGrepMatches);
      const r = ctx.store.grep(pattern, {
        docIds: argStringList(args, 'documents'),
        ignoreCase: args.case_sensitive !== true,
        maxMatches: max,
      });
      const head = `grep /${pattern}/: ${r.total} matching lines — ${Object.entries(r.perDoc)
        .map(([d, n]) => `${d}: ${n}`)
        .join(', ')}`;
      const body = r.matches.map((m) => `${m.docId}:${m.line}| ${m.text}`).join('\n');
      const more = r.total > r.matches.length ? `\n… ${r.total - r.matches.length} more matching lines omitted` : '';
      return truncateToTokens(`${head}${body ? `\n${body}` : ''}${more}`, opts.maxReadTokens ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens).text;
    },
  };
}

export function createTallyTool(): Tool {
  return {
    name: 'tally',
    description:
      'Deterministically count regex matches across stored documents. If the regex has a capture group, counts distinct values of group 1 (e.g. "User: (\\\\d+)"); otherwise counts full matches, sorted by frequency descending.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex, optionally with one capture group.' },
        documents: { type: 'array', items: { type: 'string' } },
        case_sensitive: { type: 'boolean', default: false },
        top: { type: 'integer', description: 'Max distinct values to list (default 25, max 200).' },
      },
      required: ['pattern'],
    },
    async execute(args, ctx) {
      const pattern = argString(args, 'pattern') ?? '';
      try {
        new RegExp(pattern);
      } catch (e) {
        throw new ToolArgumentError(`Invalid regex: ${(e as Error).message}`);
      }
      const top = Math.min(200, argNumber(args, 'top') ?? 25);
      const r = ctx.store.tally(pattern, { docIds: argStringList(args, 'documents'), ignoreCase: args.case_sensitive !== true });
      if (ctx.board) {
        const topCounts: Record<string, number> = {};
        for (const [k, n] of r.counts.slice(0, 10)) topCounts[k] = n;
        ctx.board.record({
          agent: ctx.agentName,
          kind: 'tally',
          scope: (argStringList(args, 'documents') ?? ['all']).join(','),
          key: pattern,
          summary: `/${pattern}/ → ${r.totalMatches} matches, ${r.distinct} distinct: ` +
            r.counts.slice(0, 5).map(([k, n]) => `${k}=${n}`).join(', '),
          counts: topCounts,
        });
      }
      const rows = r.counts.slice(0, top).map(([k, n]) => `${n}\t${k}`);
      return `tally /${pattern}/: ${r.totalMatches} matches, ${r.distinct} distinct values${r.distinct > top ? ` (showing top ${top})` : ''}\ncount\tvalue\n${rows.join('\n')}`;
    },
  };
}

export function createReadTool(opts: DocumentToolOptions = {}): Tool {
  const maxLines = opts.maxReadLines ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadLines;
  return {
    name: 'read',
    description: `Read an exact line range from a stored document (up to ${maxLines} lines per call). Use to verify regions located by grep or llm_query.`,
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string' },
        start_line: { type: 'integer', description: '1-based inclusive start line.' },
        end_line: { type: 'integer', description: '1-based inclusive end line.' },
      },
      required: ['document', 'start_line', 'end_line'],
    },
    async execute(args, ctx) {
      const doc = argString(args, 'document') ?? '';
      const s = Math.max(1, Math.floor(argNumber(args, 'start_line') ?? 1));
      const requestedEnd = Math.floor(argNumber(args, 'end_line') ?? s + maxLines - 1);
      const cappedEnd = Math.min(requestedEnd, s + maxLines - 1);
      const r = ctx.store.read(doc, s, cappedEnd);
      const maxTokens = opts.maxReadTokens ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens;
      const rawLines = r.text ? r.text.split('\n') : [];
      const keptLines: string[] = [];
      let usedTokens = 40;
      let stoppedByTokens = false;
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i] ?? '';
        const lineTokens = defaultEstimator.count(line) + 1;
        if (keptLines.length > 0 && usedTokens + lineTokens > maxTokens) {
          stoppedByTokens = true;
          break;
        }
        if (keptLines.length === 0 && usedTokens + lineTokens > maxTokens) {
          keptLines.push(truncateToTokens(line, Math.max(64, maxTokens - 40), defaultEstimator).text);
          stoppedByTokens = rawLines.length > 1;
          break;
        }
        keptLines.push(line);
        usedTokens += lineTokens;
      }
      const actualEnd = keptLines.length > 0 ? r.startLine + keptLines.length - 1 : r.endLine;
      const notes: string[] = [];
      if (stoppedByTokens && actualEnd < r.endLine) {
        notes.push(`stopped at line ${actualEnd} due to token limit; read from ${actualEnd + 1} to continue`);
      } else if (requestedEnd > cappedEnd && r.endLine === cappedEnd) {
        notes.push(`capped to ${maxLines} lines`);
      }
      const noteStr = notes.length > 0 ? ` (${notes.join('; ')})` : '';
      const header = `${doc} lines ${r.startLine}-${actualEnd} of ${r.totalLines}${noteStr}`;
      return keptLines.length > 0 ? `${header}\n${keptLines.join('\n')}` : header;
    },
  };
}
