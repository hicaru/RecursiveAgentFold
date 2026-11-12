import { CharRatioEstimator, defaultEstimator, type TokenEstimator } from '../tokens.js';
import { Bm25DocumentIndex, type SearchOptions, type SearchWindowHit } from './bm25.js';
import {
  resolveIngestSource,
  resolveIngestSources,
  sanitizeDocId,
  type IngestOptions,
  type IngestResult,
} from './ingest.js';

export const VALID_DOC_ID_RE = /^[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)*$/;
const MAX_MANIFEST_DOCS = 200;
export interface StoredDocument {
  readonly id: string;
  readonly title: string;
  /** Document lines (1-based addressing externally). */
  readonly lines: readonly string[];
  readonly chars: number;
  readonly tokens: number;
  readonly estimator: TokenEstimator;
  /** False keeps the document out of the model manifest while tools can still read it. */
  readonly manifest: boolean;
  /** Monotonic store revision assigned when this document was added or updated. */
  readonly rev: number;
  /** Source filesystem path when ingested from disk. */
  readonly absPath?: string;
  /** Source file modification timestamp in milliseconds when known. */
  readonly mtimeMs?: number;
  /** Source file byte size when known. */
  readonly byteSize?: number;
  /** True for ephemeral per-run artifacts (such as overflow or specialist reports). */
  readonly transient?: boolean;
}

export interface Chunk {
  readonly docId: string;
  /** 0-based chunk index within the document for this chunk size. */
  readonly index: number;
  readonly total: number;
  /** 1-based inclusive line range. */
  readonly startLine: number;
  readonly endLine: number;
  readonly tokens: number;
  readonly chunkTokens: number;
  /** Stable identity: same doc + same chunk size => same key => same prompt prefix. */
  readonly key: string;
}

export interface AddDocumentOptions {
  readonly id?: string;
  readonly title?: string;
  /** Known true token count (calibrates the estimator for this document). */
  readonly tokens?: number;
  /** False keeps the document out of the model manifest while tools can still read it. */
  readonly manifest?: boolean;
  readonly absPath?: string;
  readonly mtimeMs?: number;
  readonly byteSize?: number;
  readonly transient?: boolean;
}

export interface GrepMatch {
  readonly docId: string;
  readonly line: number;
  readonly text: string;
}

export interface ContextStoreOptions {
  readonly estimator?: TokenEstimator;
  /** Lines longer than this are hard-wrapped so chunking stays line-aligned. */
  readonly maxLineChars?: number;
  /** Sample lines shown per document in manifest() when doc has >= previewMinLines. Default 2. */
  readonly previewLines?: number;
  /** Minimum document line count required before manifest() renders sample lines. Default 20. */
  readonly previewMinLines?: number;
  /** Max characters per sample line in manifest(). Default 160. */
  readonly previewLineChars?: number;
}

function hashLines(lines: readonly string[], start: number, end: number): string {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    const s = lines[i] ?? '';
    for (let j = 0; j < s.length; j++) {
      h ^= s.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 10;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const OUTLINE_HEADER_RE =
  /^(?:\s*#{1,6}\s+\S|\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|enum|def|struct|impl|mod|module|package)\s+[A-Za-z0-9_]+|\s*(?:Chapter|Section|Part|Article|Table|Appendix|Annual Report)\b|\s*\d+(?:\.\d+)*\s+[A-Z\p{Script=Han}])/u;
/**
 * Holds the (possibly mega-large) contexts outside of every agent window.
 * Agents only see a manifest; content reaches models through llm_query
 * chunks or bounded read/grep windows.
 *
 * Chunking is deterministic and line-aligned, so the same chunk always renders
 * to the byte-identical prompt prefix — this is what keeps the provider prefix
 * cache warm across repeated llm_query calls (unlike RLM-style ad-hoc slices).
 */
export class ContextStore {
  private readonly docs = new Map<string, StoredDocument>();
  private readonly pathIndex = new Map<string, string>();
  private readonly chunkCache = new Map<string, Chunk[]>();
  private bm25Index: Bm25DocumentIndex | undefined;
  private _rev = 0;
  private readonly estimator: TokenEstimator;
  private readonly maxLineChars: number;
  private readonly previewLines: number;
  private readonly previewMinLines: number;
  private readonly previewLineChars: number;

  constructor(opts: ContextStoreOptions = {}) {
    this.estimator = opts.estimator ?? defaultEstimator;
    this.maxLineChars = opts.maxLineChars ?? 8000;
    this.previewLines = opts.previewLines ?? 2;
    this.previewMinLines = opts.previewMinLines ?? 20;
    this.previewLineChars = opts.previewLineChars ?? 160;
  }

  get revision(): number {
    return this._rev;
  }

  add(text: string, opts: AddDocumentOptions = {}): StoredDocument {
    const id = opts.id ?? `doc${this.docs.size + 1}`;
    if (!VALID_DOC_ID_RE.test(id)) throw new Error(`invalid document id "${id}"`);
    const prev = this.docs.get(id);
    const lines: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      if (raw.length <= this.maxLineChars) lines.push(raw);
      else for (let i = 0; i < raw.length; i += this.maxLineChars) lines.push(raw.slice(i, i + this.maxLineChars));
    }
    const baseCount = this.estimator.count(text);
    const calibratedRatio =
      opts.tokens && opts.tokens > 0 && text.length > 0 ? Math.max(0.8, text.length / opts.tokens) : undefined;
    const estimator =
      calibratedRatio !== undefined && opts.tokens !== baseCount
        ? new CharRatioEstimator(calibratedRatio, Math.min(calibratedRatio, 1.4))
        : this.estimator;
    const rev = ++this._rev;
    const absPath = opts.absPath ?? prev?.absPath;
    const mtimeMs = opts.mtimeMs;
    const byteSize = opts.byteSize;
    const transient = opts.transient ?? prev?.transient;
    const doc: StoredDocument = {
      id,
      title: opts.title ?? prev?.title ?? id,
      lines,
      chars: text.length,
      tokens: opts.tokens ?? baseCount,
      estimator,
      manifest: opts.manifest ?? prev?.manifest ?? true,
      rev,
      ...(absPath !== undefined ? { absPath } : {}),
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
      ...(byteSize !== undefined ? { byteSize } : {}),
      ...(transient !== undefined ? { transient } : {}),
    };
    if (prev?.absPath && prev.absPath !== absPath) {
      this.pathIndex.delete(prev.absPath);
    }
    if (absPath !== undefined) {
      this.pathIndex.set(absPath, id);
    }
    this.docs.set(id, doc);
    for (const k of [...this.chunkCache.keys()]) if (k.startsWith(`${id}@`)) this.chunkCache.delete(k);
    this.bm25Index = undefined;
    return doc;
  }

  delete(id: string): boolean {
    const prev = this.docs.get(id);
    if (!prev) return false;
    this.docs.delete(id);
    if (prev.absPath !== undefined) {
      this.pathIndex.delete(prev.absPath);
    }
    for (const k of [...this.chunkCache.keys()]) if (k.startsWith(`${id}@`)) this.chunkCache.delete(k);
    this.bm25Index = undefined;
    this._rev += 1;
    return true;
  }

  /** Remove ephemeral documents (such as specialist or overflow reports) between independent runs. */
  clearTransient(): number {
    let removed = 0;
    for (const [id, doc] of [...this.docs.entries()]) {
      if (doc.transient === true || (doc.manifest === false && id.startsWith('branch_report_'))) {
        this.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  findByAbsPath(absPath: string): StoredDocument | undefined {
    const id = this.pathIndex.get(absPath);
    return id !== undefined ? this.docs.get(id) : undefined;
  }

  async addPath(sourcePath: string, opts: IngestOptions = {}): Promise<IngestResult> {
    const res = await resolveIngestSource(sourcePath, opts);
    if (!res.ok) {
      throw new Error(res.error);
    }
    if (res.value.files.length === 0) {
      throw new Error(`add_document produced no readable files from "${sourcePath}"`);
    }
    for (let i = 0; i < res.value.files.length; i++) {
      const f = res.value.files[i];
      if (!f) continue;
      this.add(f.content, {
        id: f.id,
        title: f.title,
        tokens: f.tokens,
        absPath: f.path,
        ...(f.mtimeMs !== undefined ? { mtimeMs: f.mtimeMs } : {}),
        ...(f.byteSize !== undefined ? { byteSize: f.byteSize } : {}),
      });
    }
    return res.value;
  }

  /** Ingest multiple paths in parallel and commit documents in deterministic input order. */
  async addPaths(sourcePaths: readonly string[], opts: IngestOptions = {}): Promise<readonly IngestResult[]> {
    const settled = await resolveIngestSources(sourcePaths, opts);
    const results: IngestResult[] = [];
    for (let i = 0; i < settled.length; i++) {
      const item = settled[i];
      if (!item || !item.ok) continue;
      for (let j = 0; j < item.value.files.length; j++) {
        const f = item.value.files[j];
        if (!f) continue;
        this.add(f.content, {
          id: f.id,
          title: f.title,
          tokens: f.tokens,
          absPath: f.path,
          ...(f.mtimeMs !== undefined ? { mtimeMs: f.mtimeMs } : {}),
          ...(f.byteSize !== undefined ? { byteSize: f.byteSize } : {}),
        });
      }
      results.push(item.value);
    }
    return Object.freeze(results);
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  /** Resolve a raw document identifier, relative path, or unambiguous suffix to a stored document ID. */
  resolveId(raw: string): string | undefined {
    const trimmed = raw.trim().replace(/^\.\/+|^\/+/, '');
    if (!trimmed) return undefined;
    if (this.docs.has(trimmed)) return trimmed;
    const clean = sanitizeDocId(trimmed);
    if (this.docs.has(clean)) return clean;
    for (const doc of this.docs.values()) {
      if (doc.title === trimmed || sanitizeDocId(doc.title) === clean) return doc.id;
    }
    const suffixMatches: string[] = [];
    for (const doc of this.docs.values()) {
      if (doc.id.endsWith(`/${clean}`) || clean.endsWith(`/${doc.id}`)) {
        suffixMatches.push(doc.id);
      }
    }
    return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
  }

  /** Resolve a document ID, path, or directory prefix to one or more stored document IDs. */
  resolveIds(raw: string): string[] {
    const single = this.resolveId(raw);
    if (single !== undefined) return [single];
    const clean = sanitizeDocId(raw.trim().replace(/^\.\/+|^\/+/, ''));
    if (!clean) return [];
    const prefix = `${clean}/`;
    const matches: string[] = [];
    for (const doc of this.docs.values()) {
      if (doc.id.startsWith(prefix)) matches.push(doc.id);
    }
    return matches;
  }

  get(id: string): StoredDocument {
    const direct = this.docs.get(id);
    if (direct) return direct;
    const resolvedId = this.resolveId(id);
    const d = resolvedId !== undefined ? this.docs.get(resolvedId) : undefined;
    if (!d) throw new Error(`Unknown document "${id}". Available: ${[...this.docs.keys()].join(', ') || '(none)'}`);
    return d;
  }

  list(): StoredDocument[] {
    return [...this.docs.values()];
  }

  totalTokens(): number {
    let t = 0;
    for (const d of this.docs.values()) t += d.tokens;
    return t;
  }

  /** Token total for documents visible in the manifest (excludes stored reports). */
  manifestTokens(): number {
    let t = 0;
    for (const d of this.docs.values()) if (d.manifest) t += d.tokens;
    return t;
  }

  /** Documents that participate in the model manifest. */
  listManifest(): StoredDocument[] {
    return this.list().filter((doc) => doc.manifest);
  }

  /** Stable manifest rendered into the agent prompt (part of the cached prefix). */
  manifest(): string {
    return this.manifestFor();
  }

  /** Render a manifest for a specific subset of document IDs (or all documents when omitted). */
  manifestFor(docIds?: readonly string[]): string {
    const docs: StoredDocument[] = [];
    if (docIds !== undefined) {
      for (let i = 0; i < docIds.length; i++) {
        const id = docIds[i];
        if (!id) continue;
        const d = this.docs.get(id);
        if (d) docs.push(d);
      }
    } else {
      for (const d of this.docs.values()) if (d.manifest) docs.push(d);
    }
    if (docs.length === 0) return '(no documents loaded)';
    const out: string[] = [];
    const includeSamples = docs.length <= 20 && this.previewLines > 0;
    const limit = Math.min(docs.length, MAX_MANIFEST_DOCS);
    for (let idx = 0; idx < limit; idx++) {
      const d = docs[idx];
      if (!d) continue;
      out.push(
        `- id: \`${d.id}\` — ${d.title} — ~${d.tokens.toLocaleString('en-US')} tokens, ${d.lines.length.toLocaleString('en-US')} lines`,
      );
      if (includeSamples && d.lines.length >= this.previewMinLines) {
        out.push('  Sample lines:');
        let shown = 0;
        for (let i = 0; i < d.lines.length && shown < this.previewLines; i++) {
          const line = d.lines[i] ?? '';
          if (!line.trim()) continue;
          out.push(
            `  ${i + 1}| ${line.length > this.previewLineChars ? `${line.slice(0, this.previewLineChars)}…` : line}`,
          );
          shown++;
        }
      }
    }
    if (docs.length > MAX_MANIFEST_DOCS) {
      const remaining = docs.length - MAX_MANIFEST_DOCS;
      out.push(
        `... and ${remaining} more documents (use list_documents, search, outline, or grep to explore)`,
      );
    }
    return out.join('\n');
  }

  /** Deterministic line-aligned chunking, memoized per (doc, chunkTokens). */
  chunks(docId: string, chunkTokens: number): Chunk[] {
    const doc = this.get(docId);
    const size = Math.max(64, Math.floor(chunkTokens));
    const cacheKey = `${docId}@${size}`;
    const cached = this.chunkCache.get(cacheKey);
    if (cached) return cached;
    const out: Omit<Chunk, 'total'>[] = [];
    let start = 0;
    let acc = 0;
    const lineTok = (i: number) => doc.estimator.count(doc.lines[i] ?? '') + 1;
    for (let i = 0; i < doc.lines.length; i++) {
      const t = lineTok(i);
      if (acc > 0 && acc + t > size) {
        out.push({ docId, index: out.length, startLine: start + 1, endLine: i, tokens: acc, chunkTokens: size, key: `${docId}@${size}#${out.length}:${hashLines(doc.lines, start, i)}` });
        start = i;
        acc = 0;
      }
      acc += t;
    }
    if (acc > 0 || out.length === 0) {
      const endIdx = Math.max(start + 1, doc.lines.length);
      out.push({ docId, index: out.length, startLine: start + 1, endLine: endIdx, tokens: acc, chunkTokens: size, key: `${docId}@${size}#${out.length}:${hashLines(doc.lines, start, endIdx)}` });
    }
    const chunks = out.map((c) => ({ ...c, total: out.length }));
    this.chunkCache.set(cacheKey, chunks);
    return chunks;
  }

  /** Render a chunk. Byte-identical for identical chunks (cache-stable). */
  renderChunk(chunk: Chunk, lineNumbers = true): string {
    const doc = this.get(chunk.docId);
    const body = doc.lines.slice(chunk.startLine - 1, chunk.endLine);
    return lineNumbers ? body.map((l, i) => `${chunk.startLine + i}| ${l}`).join('\n') : body.join('\n');
  }

  read(docId: string, startLine: number, endLine: number): { text: string; startLine: number; endLine: number; totalLines: number } {
    const doc = this.get(docId);
    const s = Math.max(1, Math.floor(startLine));
    const e = Math.min(doc.lines.length, Math.floor(endLine));
    if (e < s) return { text: '', startLine: s, endLine: e, totalLines: doc.lines.length };
    const text = doc.lines
      .slice(s - 1, e)
      .map((l, i) => `${s + i}| ${l}`)
      .join('\n');
    return { text, startLine: s, endLine: e, totalLines: doc.lines.length };
  }

  /** Rank 40-line document windows against a query using Okapi BM25 V2. */
  search(query: string, opts: SearchOptions = {}): SearchWindowHit[] {
    const docIds = opts.docIds !== undefined && opts.docIds.length > 0
      ? opts.docIds
      : this.listManifest().map((d) => d.id);
    if (docIds.length === 0) return [];
    if (!this.bm25Index) {
      this.bm25Index = new Bm25DocumentIndex(this.list());
    }
    return this.bm25Index.search(query, { ...opts, docIds });
  }

  /** Extract structural headings, section titles, and definitions with 1-based line numbers. */
  outline(
    docId: string,
    opts: { maxEntries?: number } = {},
  ): { docId: string; totalLines: number; entries: Array<{ line: number; text: string }> } {
    const doc = this.get(docId);
    const maxEntries = Math.max(1, Math.min(200, Math.floor(opts.maxEntries ?? 60)));
    const totalLines = doc.lines.length;
    if (totalLines === 0) return { docId, totalLines: 0, entries: [] };
    const matched: Array<{ line: number; text: string }> = [];
    for (let i = 0; i < totalLines; i++) {
      const raw = doc.lines[i] ?? '';
      const trimmed = raw.trim();
      if (!trimmed) continue;
      if (OUTLINE_HEADER_RE.test(raw)) {
        matched.push({ line: i + 1, text: trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed });
      }
    }
    if (matched.length === 0) {
      const targetLandmarks = Math.min(20, maxEntries);
      const step = Math.max(1, Math.ceil(totalLines / targetLandmarks));
      const landmarks: Array<{ line: number; text: string }> = [];
      for (let i = 0; i < totalLines && landmarks.length < maxEntries; i += step) {
        const raw = (doc.lines[i] ?? '').trim();
        if (raw) {
          landmarks.push({ line: i + 1, text: raw.length > 160 ? `${raw.slice(0, 160)}…` : raw });
        }
      }
      return { docId, totalLines, entries: landmarks };
    }
    if (matched.length <= maxEntries) {
      return { docId, totalLines, entries: matched };
    }
    const sampled = Array.from({ length: maxEntries }, (_, idx) => {
      const pos = Math.min(matched.length - 1, Math.floor((idx * (matched.length - 1)) / Math.max(1, maxEntries - 1)));
      return matched[pos] ?? { line: 1, text: '' };
    });
    return { docId, totalLines, entries: sampled };
  }

  grep(
    pattern: string,
    opts: { docIds?: string[]; ignoreCase?: boolean; maxMatches?: number; maxLineChars?: number } = {},
  ): { matches: GrepMatch[]; total: number; perDoc: Record<string, number> } {
    const re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
    const max = opts.maxMatches ?? 50;
    const maxChars = opts.maxLineChars ?? 300;
    const perDocMatches: GrepMatch[][] = [];
    const perDoc: Record<string, number> = {};
    let total = 0;
    const ids = opts.docIds?.length ? opts.docIds : this.listManifest().map((d) => d.id);
    for (const id of ids) {
      const doc = this.get(id);
      perDoc[id] = 0;
      const docMatches: GrepMatch[] = [];
      for (let i = 0; i < doc.lines.length; i++) {
        const line = doc.lines[i] ?? '';
        const m = re.exec(line);
        if (m) {
          total++;
          perDoc[id]++;
          if (docMatches.length < max) {
            let text: string;
            if (line.length <= maxChars) {
              text = line;
            } else {
              const matchIdx = m.index;
              const matchLen = m[0].length;
              if (matchIdx + matchLen <= maxChars) {
                text = `${line.slice(0, maxChars)}…`;
              } else {
                const start = Math.max(0, Math.min(line.length - maxChars, matchIdx - Math.floor(maxChars / 3)));
                const end = Math.min(line.length, start + maxChars);
                text = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
              }
            }
            docMatches.push({ docId: id, line: i + 1, text });
          }
        }
      }
      if (docMatches.length > 0) perDocMatches.push(docMatches);
    }
    if (perDocMatches.length <= 1) {
      return { matches: perDocMatches[0] ?? [], total, perDoc };
    }
    const selected: Array<GrepMatch & { readonly _docOrder: number }> = [];
    let round = 0;
    while (selected.length < max) {
      let added = false;
      for (let d = 0; d < perDocMatches.length && selected.length < max; d++) {
        const item = perDocMatches[d]?.[round];
        if (item) {
          selected.push({ ...item, _docOrder: d });
          added = true;
        }
      }
      if (!added) break;
      round++;
    }
    selected.sort((a, b) => a._docOrder - b._docOrder || a.line - b.line);
    const matches = selected.map(({ _docOrder: _, ...m }) => m);
    return { matches, total, perDoc };
  }

  /**
   * Exact tally of regex capture-group values (group 1, or the whole match)
   * across documents — deterministic aggregation the LLM should not do by hand.
   */
  tally(
    pattern: string,
    opts: { docIds?: string[]; ignoreCase?: boolean } = {},
  ): {
    counts: Array<[string, number]>;
    totalMatches: number;
    distinct: number;
    caseFoldedCounts?: Array<[string, number, Readonly<Record<string, number>>]>;
  } {
    const re = new RegExp(pattern, opts.ignoreCase === false ? 'g' : 'gi');
    const counts = new Map<string, number>();
    const folded = new Map<string, { total: number; variants: Record<string, number> }>();
    let totalMatches = 0;
    const ids = opts.docIds?.length ? opts.docIds : this.listManifest().map((d) => d.id);
    for (const id of ids) {
      for (const line of this.get(id).lines) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const key = m[1] ?? m[0];
          counts.set(key, (counts.get(key) ?? 0) + 1);
          const lowerKey = key.toLowerCase();
          let entry = folded.get(lowerKey);
          if (!entry) {
            entry = { total: 0, variants: {} };
            folded.set(lowerKey, entry);
          }
          entry.total++;
          entry.variants[key] = (entry.variants[key] ?? 0) + 1;
          totalMatches++;
        }
      }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const caseFoldedCounts: Array<[string, number, Readonly<Record<string, number>>]> = [...folded.entries()]
      .sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0]))
      .map(([k, v]) => [k, v.total, v.variants]);
    return { counts: sorted, totalMatches, distinct: sorted.length, caseFoldedCounts };
  }
}
