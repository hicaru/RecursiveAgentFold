import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { sanitizeDocId, type IngestResult } from '../context/ingest.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool, type ToolContext } from './types.js';

export interface AddDocumentToolOptions {
  readonly cwd?: string;
  readonly onIngest?: (res: IngestResult) => void;
}
export interface DocumentToolOptions {
  /** Max lines returned by one read. Default 80. */
  readonly maxReadLines?: number;
  /** Max tokens returned by one read. Default 2400. */
  readonly maxReadTokens?: number;
  /** Max matching lines listed by grep. Default 25. */
  readonly maxGrepMatches?: number;
  readonly ingest?: AddDocumentToolOptions;
}

export const DEFAULT_DOCUMENT_TOOL_OPTIONS: Readonly<Required<Omit<DocumentToolOptions, 'ingest'>>> = Object.freeze({
  maxReadLines: 80,
  maxReadTokens: 2400,
  maxGrepMatches: 25,
});

async function refreshLiveFileIfPresent(
  rawTarget: string,
  ctx: ToolContext,
  ingest?: AddDocumentToolOptions,
): Promise<string | undefined> {
  if (ingest?.cwd === undefined) return undefined;
  const candidate = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(ingest.cwd, rawTarget);
  const s = await stat(candidate).catch(() => undefined);
  if (!s || !s.isFile()) return undefined;
  try {
    const res = await ctx.store.addPath(rawTarget, {
      cwd: ingest.cwd,
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    ingest.onIngest?.(res);
    return res.files[0]?.id;
  } catch {
    return ctx.store.resolveId(rawTarget);
  }
}

async function ensureTargetIds(
  rawTarget: string,
  ctx: ToolContext,
  ingest?: AddDocumentToolOptions,
): Promise<string[]> {
  const refreshed = await refreshLiveFileIfPresent(rawTarget, ctx, ingest);
  if (refreshed !== undefined) return [refreshed];
  const existing = ctx.store.resolveIds(rawTarget);
  if (existing.length > 0) return existing;
  try {
    const res = await ctx.store.addPath(rawTarget, {
      ...(ingest?.cwd !== undefined ? { cwd: ingest.cwd } : {}),
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
    });
    ingest?.onIngest?.(res);
    const sourceKey = res.sourceId || sanitizeDocId(rawTarget);
    ctx.board?.record({
      agent: ctx.agentName,
      kind: 'tool',
      scope: sourceKey,
      key: `add_document:${sourceKey}`,
      summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${sourceKey}" from ${res.resolvedPath}`,
    });
    return res.files.map((f) => f.id);
  } catch {
    return ctx.store.resolveIds(rawTarget);
  }
}

async function ensureTargetsFromArgs(
  args: Record<string, unknown>,
  ctx: ToolContext,
  ingest?: AddDocumentToolOptions,
): Promise<string[] | undefined> {
  const rawDocs = argStringList(args, 'documents') ?? [];
  const rawPath =
    argString(args, 'document', false) ??
    argString(args, 'path', false) ??
    argString(args, 'file_path', false);
  const targets: string[] = [];
  for (let i = 0; i < rawDocs.length; i++) {
    const d = rawDocs[i]?.trim();
    if (d) targets.push(d);
  }
  if (rawPath && rawPath.trim() !== '' && !targets.includes(rawPath.trim())) {
    targets.push(rawPath.trim());
  }
  if (targets.length === 0) {
    if (ingest?.cwd !== undefined && ctx.store.list().every((d) => d.id === 'session')) {
      try {
        const res = await ctx.store.addPath(ingest.cwd, {
          cwd: ingest.cwd,
          idPrefix: '',
          maxFiles: 300,
          skipRichDocuments: true,
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        ingest.onIngest?.(res);
      } catch {
        // Ignore if workspace directory has no ingestible files.
      }
    }
    return undefined;
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (!t) continue;
    const ids = await ensureTargetIds(t, ctx, ingest);
    if (ids.length === 0) {
      if (!seen.has(t)) {
        seen.add(t);
        resolved.push(t);
      }
    } else {
      for (let j = 0; j < ids.length; j++) {
        const id = ids[j];
        if (id && !seen.has(id)) {
          seen.add(id);
          resolved.push(id);
        }
      }
    }
  }
  return resolved;
}

export function createListDocumentsTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'list_documents',
    description: 'List stored documents (id, title, token count, line count), optionally filtered by id prefix.',
    parameters: {
      type: 'object',
      properties: {
        prefix: { type: 'string', description: 'Optional document ID prefix filter (e.g. "rlm.pi/src").' },
        limit: { type: 'integer', description: 'Maximum number of documents to list (default 200).' },
      },
    },
    async execute(args, ctx) {
      if (opts.ingest?.cwd !== undefined && ctx.store.list().every((d) => d.id === 'session')) {
        await ensureTargetsFromArgs({}, ctx, opts.ingest);
      }
      const prefixRaw = argString(args, 'prefix', false)?.trim();
      const limitRaw = argNumber(args, 'limit');
      if (!prefixRaw && limitRaw === undefined) {
        return ctx.store.manifest();
      }
      const all = ctx.store.list();
      const prefixLower = prefixRaw ? prefixRaw.toLowerCase() : undefined;
      const matchedIds: string[] = [];
      for (let i = 0; i < all.length; i++) {
        const d = all[i];
        if (!d) continue;
        if (prefixLower && !d.id.toLowerCase().startsWith(prefixLower) && !d.id.toLowerCase().includes(prefixLower)) {
          continue;
        }
        matchedIds.push(d.id);
      }
      if (matchedIds.length === 0) {
        return prefixRaw
          ? `(no documents matching prefix "${prefixRaw}")`
          : '(no documents loaded)';
      }
      const cap = limitRaw !== undefined && limitRaw > 0 ? Math.min(matchedIds.length, Math.floor(limitRaw)) : matchedIds.length;
      const sliced = matchedIds.slice(0, cap);
      const rendered = ctx.store.manifestFor(sliced);
      if (matchedIds.length > cap) {
        return `${rendered}\n... and ${matchedIds.length - cap} more matching documents`;
      }
      return rendered;
    },
  };
}

export function createAddDocumentTool(opts: AddDocumentToolOptions = {}): Tool {
  return {
    name: 'add_document',
    description:
      'Load a file or directory (code, markdown, articles, PDF, DOCX, PPTX, XLSX, CSV, EPUB, etc.) from disk into ContextStore so all agents can search, outline, grep, read, branch, and run llm_query on it.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory path to load into ContextStore.' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of file or directory paths to load.',
        },
        id_prefix: { type: 'string', description: 'Optional document ID prefix override.' },
      },
      required: [],
    },
    async execute(args, ctx) {
      const single =
        argString(args, 'path', false) ??
        argString(args, 'source', false) ??
        argString(args, 'file_path', false) ??
        argString(args, 'dir', false);
      const multi = argStringList(args, 'paths') ?? [];
      const idPrefix = argString(args, 'id_prefix', false) ?? argString(args, 'prefix', false);
      const targets: string[] = [];
      if (single && single.trim() !== '') targets.push(single.trim());
      for (let i = 0; i < multi.length; i++) {
        const p = multi[i]?.trim();
        if (p && !targets.includes(p)) targets.push(p);
      }
      if (targets.length === 0) {
        throw new ToolArgumentError('must provide "path" or "paths"');
      }

      const blocks: string[] = [];
      for (let t = 0; t < targets.length; t++) {
        const target = targets[t];
        if (!target) continue;
        const res = await ctx.store.addPath(target, {
          ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(idPrefix !== undefined ? { idPrefix } : {}),
          ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        });
        opts.onIngest?.(res);
        ctx.board?.record({
          agent: ctx.agentName,
          kind: 'tool',
          scope: res.sourceId,
          key: `add_document:${res.sourceId}`,
          summary: `Loaded ${res.files.length} document(s) (~${res.totalTokens.toLocaleString('en-US')} tokens) under prefix "${res.sourceId}" from ${res.resolvedPath}`,
        });

        const lines: string[] = [
          `Added source "${res.source}" (${res.resolvedPath}) as prefix "${res.sourceId}":`,
          `  Files loaded: ${res.files.length} (~${res.totalTokens.toLocaleString('en-US')} tokens, ${res.totalChars.toLocaleString('en-US')} chars)`,
        ];
        if (res.documents > 0) {
          lines.push(`  Rich documents: ${res.documents} (${res.converted} converted via anydoc)`);
        }
        if (res.skipped.length > 0) {
          const byReason: Record<string, number> = {};
          for (let i = 0; i < res.skipped.length; i++) {
            const sk = res.skipped[i];
            if (!sk) continue;
            byReason[sk.reason] = (byReason[sk.reason] ?? 0) + 1;
          }
          const reasonSummary = Object.entries(byReason)
            .map(([r, c]) => `${r}=${c}`)
            .join(', ');
          lines.push(`  Skipped files: ${res.skipped.length} (${reasonSummary})`);
        }
        const showLimit = Math.min(30, res.files.length);
        lines.push('  Ingested document IDs:');
        for (let i = 0; i < showLimit; i++) {
          const f = res.files[i];
          if (!f) continue;
          lines.push(`    - ${f.id} (~${f.tokens.toLocaleString('en-US')} tokens)`);
        }
        if (res.files.length > showLimit) {
          lines.push(
            `    ... and ${res.files.length - showLimit} more (use list_documents with {"prefix": "${res.sourceId}"}, search, outline, or grep to explore)`,
          );
        }
        blocks.push(lines.join('\n'));
      }
      return blocks.join('\n\n');
    },
  };
}

export function createSearchTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'search',
    description:
      'Rank 40-line document windows against a natural-language or keyword query using Okapi BM25 V2 (stemming + query expansion + phrase bonus). Free (0 LLM tokens); use before llm_query or when exact grep regexes are uncertain.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language or keyword query.' },
        documents: { type: 'array', items: { type: 'string' }, description: 'Document ids (default: all).' },
        path: { type: 'string', description: 'Optional file or directory path/prefix to search (auto-loaded if needed).' },
        k: { type: 'integer', description: 'Number of top windows to return (default 10, max 30).' },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = (argString(args, 'query') ?? '').trim();
      if (!query) throw new ToolArgumentError('search requires a non-empty "query" string.');
      const k = Math.max(1, Math.min(30, Math.floor(argNumber(args, 'k') ?? 10)));
      const docIds = await ensureTargetsFromArgs(args, ctx, opts.ingest);
      const hits = ctx.store.search(query, {
        ...(docIds !== undefined ? { docIds } : {}),
        k,
      });
      if (hits.length === 0) {
        return `search "${query}": 0 matching windows.`;
      }
      const blocks = Array.from(
        { length: hits.length },
        (_, i) => {
          const h = hits[i];
          if (!h) return '';
          return `[#${i + 1}] ${h.docId}:L${h.startLine}-${h.endLine} (score=${h.score.toFixed(2)})\n${h.snippet}`;
        },
      );
      const out = `search "${query}": top ${hits.length} window(s)\n${blocks.join('\n')}`;
      return truncateToTokens(out, opts.maxReadTokens ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens).text;
    },
  };
}

export function createOutlineTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'outline',
    description:
      'Extract structural headings, section titles, and code definitions with line numbers for a document (or all documents if omitted). Use to orient on document structure and section boundaries.',
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Document id (default: all documents).' },
        path: { type: 'string', description: 'Alias for document: file or directory path to outline.' },
        file_path: { type: 'string', description: 'Alias for document: file path to outline.' },
        max_entries: { type: 'integer', description: 'Max structural entries to return (default 60, max 200).' },
      },
    },
    async execute(args, ctx) {
      const targetIds = await ensureTargetsFromArgs(args, ctx, opts.ingest);
      const maxEntries = Math.max(1, Math.min(200, Math.floor(argNumber(args, 'max_entries') ?? 60)));
      const maxTokens = opts.maxReadTokens ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens;
      if (targetIds !== undefined && targetIds.length === 1) {
        const singleId = targetIds[0] ?? '';
        const r = ctx.store.outline(singleId, { maxEntries });
        const body = r.entries.map((e) => `L${e.line}: ${e.text}`).join('\n');
        return truncateToTokens(
          `outline ${r.docId} (${r.totalLines} lines, ${r.entries.length} entries):\n${body}`,
          maxTokens,
        ).text;
      }
      const ids = targetIds ?? ctx.store.list().map((d) => d.id);
      if (ids.length === 0) return '(no documents loaded)';
      const perDocMax = Math.max(15, Math.floor(maxEntries / ids.length));
      const sections: string[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        const r = ctx.store.outline(id, { maxEntries: perDocMax });
        const body = r.entries.map((e) => `  L${e.line}: ${e.text}`).join('\n');
        sections.push(`outline ${r.docId} (${r.totalLines} lines, ${r.entries.length} entries):\n${body}`);
      }
      return truncateToTokens(sections.join('\n\n'), maxTokens).text;
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
        path: { type: 'string', description: 'Optional file or directory path/prefix to search (auto-loaded if needed).' },
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
      const docIds = await ensureTargetsFromArgs(args, ctx, opts.ingest);
      const r = ctx.store.grep(pattern, {
        docIds,
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

export function createTallyTool(opts: DocumentToolOptions = {}): Tool {
  return {
    name: 'tally',
    description:
      'Deterministically count regex matches across stored documents. If the regex has a capture group, counts distinct values of group 1 (e.g. "User: (\\\\d+)"); otherwise counts full matches, sorted by frequency descending.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regex, optionally with one capture group.' },
        documents: { type: 'array', items: { type: 'string' } },
        path: { type: 'string', description: 'Optional file or directory path/prefix to tally.' },
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
      const docIds = await ensureTargetsFromArgs(args, ctx, opts.ingest);
      const r = ctx.store.tally(pattern, { docIds, ignoreCase: args.case_sensitive !== true });
      if (ctx.board) {
        const topCounts: Record<string, number> = {};
        for (const [k, n] of r.counts.slice(0, 10)) topCounts[k] = n;
        ctx.board.record({
          agent: ctx.agentName,
          kind: 'tally',
          scope: (docIds ?? ['all']).join(','),
          key: pattern,
          summary: `/${pattern}/ → ${r.totalMatches} matches, ${r.distinct} distinct: ` +
            r.counts.slice(0, 5).map(([k, n]) => `${k}=${n}`).join(', '),
          counts: topCounts,
        });
      }
      const rows = r.counts.slice(0, top).map(([k, n]) => `${n}\t${k}`);
      const multiCaseLines: string[] = [];
      if (args.case_sensitive !== true && r.caseFoldedCounts) {
        const foldedSlice = r.caseFoldedCounts.slice(0, top);
        for (let i = 0; i < foldedSlice.length; i++) {
          const item = foldedSlice[i];
          if (!item) continue;
          const [lowerKey, total, variants] = item;
          const variantEntries = Object.entries(variants);
          if (variantEntries.length > 1) {
            variantEntries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
            const breakdown = variantEntries.map(([v, c]) => `${v}=${c}`).join(', ');
            multiCaseLines.push(`${lowerKey}: ${total} total (exact-case: ${breakdown})`);
          }
        }
      }
      const caseSuffix =
        multiCaseLines.length > 0
          ? `\nCase-folded summary (when task is case-insensitive vs exact-case):\n${multiCaseLines.join('\n')}`
          : '';
      return `tally /${pattern}/: ${r.totalMatches} matches, ${r.distinct} distinct values${r.distinct > top ? ` (showing top ${top})` : ''}\ncount\tvalue\n${rows.join('\n')}${caseSuffix}`;
    },
  };
}

export function createReadTool(opts: DocumentToolOptions = {}): Tool {
  const maxLines = opts.maxReadLines ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadLines;
  const maxTokens = opts.maxReadTokens ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens;
  return {
    name: 'read',
    description:
      `Read a line range from a document or workspace file (up to ${maxLines} lines and ~${maxTokens} tokens per call). ` +
      'Accepts "document" or "file_path"/"path" (auto-loads workspace files into ContextStore if needed), with "start_line"/"end_line" or "offset"/"limit".',
    parameters: {
      type: 'object',
      properties: {
        document: { type: 'string', description: 'Document ID or workspace file path to read.' },
        file_path: { type: 'string', description: 'Alias for document: workspace file path to read.' },
        path: { type: 'string', description: 'Alias for document: workspace file path to read.' },
        start_line: { type: 'integer', description: '1-based inclusive start line (default 1).' },
        end_line: { type: 'integer', description: `1-based inclusive end line (default start_line + 39, max ${maxLines} lines per call).` },
        offset: { type: 'integer', description: 'Alias for start_line: 1-based first line to read.' },
        limit: { type: 'integer', description: `Alias for line count: number of lines to read (capped at ${maxLines}).` },
      },
      required: [],
    },
    async execute(args, ctx) {
      const rawDoc = (
        argString(args, 'document', false) ??
        argString(args, 'file_path', false) ??
        argString(args, 'path', false)
      )?.trim();
      if (!rawDoc) {
        throw new ToolArgumentError('Missing or invalid string argument "document" (or "file_path" / "path")');
      }
      const s = Math.max(1, Math.floor(argNumber(args, 'start_line') ?? argNumber(args, 'offset') ?? 1));
      const limit = argNumber(args, 'limit');
      const defaultWindow = Math.min(40, maxLines);
      const requestedEnd = Math.floor(
        argNumber(args, 'end_line') ??
          (limit !== undefined ? s + Math.max(1, limit) - 1 : s + defaultWindow - 1),
      );
      const cappedEnd = Math.min(requestedEnd, s + maxLines - 1);
      const refreshed = await refreshLiveFileIfPresent(rawDoc, ctx, opts.ingest);
      let docId = refreshed ?? ctx.store.resolveId(rawDoc);
      if (docId === undefined) {
        const ids = await ensureTargetIds(rawDoc, ctx, opts.ingest);
        if (ids.length === 1) {
          docId = ids[0];
        } else if (ids.length > 1) {
          return `Loaded ${ids.length} documents from directory "${rawDoc}": ${ids.slice(0, 20).join(', ')}${ids.length > 20 ? ` ... (+${ids.length - 20} more)` : ''}. Call outline, search, grep, or read on a specific document ID.`;
        } else {
          docId = rawDoc;
        }
      }
      const targetDoc = docId ?? rawDoc;
      const r = ctx.store.read(targetDoc, s, cappedEnd);
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
      const header = `${targetDoc} lines ${r.startLine}-${actualEnd} of ${r.totalLines}${noteStr}`;
      return keptLines.length > 0 ? `${header}\n${keptLines.join('\n')}` : header;
    },
  };
}
