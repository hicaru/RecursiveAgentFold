import { CharRatioEstimator, defaultEstimator, type TokenEstimator } from '../tokens.js';

export interface StoredDocument {
  id: string;
  title: string;
  /** Lines after hard-wrapping of overlong lines (1-based addressing externally). */
  lines: string[];
  chars: number;
  tokens: number;
  estimator: TokenEstimator;
}

export interface Chunk {
  docId: string;
  /** 0-based chunk index within the document for this chunk size. */
  index: number;
  total: number;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  tokens: number;
  chunkTokens: number;
  /** Stable identity: same doc + same chunk size => same key => same prompt prefix. */
  key: string;
}

export interface AddDocumentOptions {
  id?: string;
  title?: string;
  /** Known true token count (calibrates the estimator for this document). */
  tokens?: number;
}

export interface GrepMatch {
  docId: string;
  line: number;
  text: string;
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
  private readonly chunkCache = new Map<string, Chunk[]>();
  private readonly estimator: TokenEstimator;
  private readonly maxLineChars: number;
  private readonly previewLines: number;
  private readonly previewMinLines: number;
  private readonly previewLineChars: number;

  constructor(opts: ContextStoreOptions = {}) {
    this.estimator = opts.estimator ?? defaultEstimator;
    this.maxLineChars = opts.maxLineChars ?? 2000;
    this.previewLines = opts.previewLines ?? 2;
    this.previewMinLines = opts.previewMinLines ?? 20;
    this.previewLineChars = opts.previewLineChars ?? 160;
  }

  add(text: string, opts: AddDocumentOptions = {}): StoredDocument {
    const id = opts.id ?? `doc${this.docs.size + 1}`;
    if (!/^[A-Za-z0-9_.\-]+$/.test(id)) throw new Error(`invalid document id "${id}"`);
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
    const doc: StoredDocument = {
      id,
      title: opts.title ?? id,
      lines,
      chars: text.length,
      tokens: opts.tokens ?? baseCount,
      estimator,
    };
    this.docs.set(id, doc);
    for (const k of [...this.chunkCache.keys()]) if (k.startsWith(`${id}@`)) this.chunkCache.delete(k);
    return doc;
  }

  has(id: string): boolean {
    return this.docs.has(id);
  }

  get(id: string): StoredDocument {
    const d = this.docs.get(id);
    if (!d) throw new Error(`未知文档 "${id}"。可用：${[...this.docs.keys()].join('、') || '（无）'}`);
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

  /** Stable manifest rendered into the agent prompt (part of the cached prefix). */
  manifest(): string {
    if (this.docs.size === 0) return '（未加载文档）';
    const out: string[] = [];
    for (const d of this.docs.values()) {
      out.push(`- id: \`${d.id}\` — ${d.title} — 约 ${d.tokens.toLocaleString('en-US')} token，${d.lines.length.toLocaleString('en-US')} 行`);
      if (this.previewLines > 0 && d.lines.length >= this.previewMinLines) {
        out.push('  示例首行：');
        let shown = 0;
        for (let i = 0; i < d.lines.length && shown < this.previewLines; i++) {
          const line = d.lines[i] ?? '';
          if (!line.trim()) continue;
          out.push(`  ${i + 1}| ${line.length > this.previewLineChars ? `${line.slice(0, this.previewLineChars)}…` : line}`);
          shown++;
        }
      }
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
        out.push({ docId, index: out.length, startLine: start + 1, endLine: i, tokens: acc, chunkTokens: size, key: `${docId}@${size}#${out.length}` });
        start = i;
        acc = 0;
      }
      acc += t;
    }
    if (acc > 0 || out.length === 0) {
      out.push({ docId, index: out.length, startLine: start + 1, endLine: Math.max(start + 1, doc.lines.length), tokens: acc, chunkTokens: size, key: `${docId}@${size}#${out.length}` });
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

  grep(
    pattern: string,
    opts: { docIds?: string[]; ignoreCase?: boolean; maxMatches?: number; maxLineChars?: number } = {},
  ): { matches: GrepMatch[]; total: number; perDoc: Record<string, number> } {
    const re = new RegExp(pattern, opts.ignoreCase === false ? '' : 'i');
    const max = opts.maxMatches ?? 50;
    const maxChars = opts.maxLineChars ?? 300;
    const matches: GrepMatch[] = [];
    const perDoc: Record<string, number> = {};
    let total = 0;
    const ids = opts.docIds?.length ? opts.docIds : [...this.docs.keys()];
    for (const id of ids) {
      const doc = this.get(id);
      perDoc[id] = 0;
      for (let i = 0; i < doc.lines.length; i++) {
        const line = doc.lines[i] ?? '';
        if (re.test(line)) {
          total++;
          perDoc[id]++;
          if (matches.length < max) {
            matches.push({ docId: id, line: i + 1, text: line.length > maxChars ? `${line.slice(0, maxChars)}…` : line });
          }
        }
      }
    }
    return { matches, total, perDoc };
  }

  /**
   * Exact tally of regex capture-group values (group 1, or the whole match)
   * across documents — deterministic aggregation the LLM should not do by hand.
   */
  tally(
    pattern: string,
    opts: { docIds?: string[]; ignoreCase?: boolean } = {},
  ): { counts: Array<[string, number]>; totalMatches: number; distinct: number } {
    const re = new RegExp(pattern, opts.ignoreCase === false ? 'g' : 'gi');
    const counts = new Map<string, number>();
    let totalMatches = 0;
    const ids = opts.docIds?.length ? opts.docIds : [...this.docs.keys()];
    for (const id of ids) {
      for (const line of this.get(id).lines) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          const key = m[1] ?? m[0];
          counts.set(key, (counts.get(key) ?? 0) + 1);
          totalMatches++;
        }
      }
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return { counts: sorted, totalMatches, distinct: sorted.length };
  }
}
