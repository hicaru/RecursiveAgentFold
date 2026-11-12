import type { StoredDocument } from './store.js';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const WINDOW_LINES = 40;
export const WINDOW_STRIDE = 20;
export const MAX_WINDOWS = 250_000;
export const PRF_FEEDBACK_DOCS = 3;
export const PRF_EXPANSION_TERMS = 8;
export const PRF_EXPANSION_WEIGHT = 0.4;
export const PRF_MIN_DOCS = 12;
export const PHRASE_BONUS_WEIGHT = 0.25;
export const RERANK_POOL_MULT = 3;
export const RERANK_POOL_CAP = 60;

const STOP_WORDS: Readonly<Record<string, true>> = Object.freeze({
  a: true, an: true, and: true, are: true, as: true, at: true, be: true, by: true,
  for: true, from: true, has: true, he: true, in: true, is: true, it: true, its: true,
  of: true, on: true, or: true, that: true, the: true, to: true, was: true, were: true,
  will: true, with: true, this: true, these: true, those: true, what: true, which: true,
  who: true, whom: true, whose: true, when: true, where: true, why: true, how: true,
});

const SUFFIX_RULES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['ingly', ''],
  ['edly', ''],
  ['ings', ''],
  ['ions', ''],
  ['ments', ''],
  ['ment', ''],
  ['ness', ''],
  ['able', ''],
  ['ible', ''],
  ['ing', ''],
  ['ies', 'y'],
  ['ied', 'y'],
  ['ier', 'y'],
  ['ion', ''],
  ['ize', ''],
  ['ise', ''],
  ['es', ''],
  ['ed', ''],
  ['ly', ''],
  ['er', ''],
  ['s', ''],
]);

/** Strip common English morphological suffixes deterministically. */
export function stemToken(t: string): string {
  const lower = t.toLowerCase();
  if (lower.length < 4) return lower;
  for (let i = 0; i < SUFFIX_RULES.length; i++) {
    const rule = SUFFIX_RULES[i];
    if (!rule) continue;
    const [suffix, replacement] = rule;
    if (lower.endsWith(suffix)) {
      if (suffix === 's' && (lower.endsWith('ss') || lower.endsWith('us') || lower.endsWith('is'))) {
        continue;
      }
      const stem = lower.slice(0, lower.length - suffix.length) + replacement;
      if (stem.length >= 3) {
        if (
          stem.length >= 4 &&
          stem[stem.length - 1] === stem[stem.length - 2] &&
          !'lsz'.includes(stem[stem.length - 1] ?? '')
        ) {
          return stem.slice(0, stem.length - 1);
        }
        return stem;
      }
    }
  }
  return lower;
}

const LATIN_SPLIT_RE = /[^0-9A-Za-z]+/;
const CAMEL_BOUNDARY_RE = /(?<=[a-z0-9])(?=[A-Z])/g;
const HAN_SEQ_RE = /\p{Script=Han}+/gu;

/** Tokenize Latin/numeric terms with stemming and extract CJK unigrams + bigrams. */
export function bm25Tokenize(text: string): string[] {
  const tokens: string[] = [];
  const camelExpanded = text.replace(CAMEL_BOUNDARY_RE, ' ');
  const parts = camelExpanded.split(LATIN_SPLIT_RE);
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i];
    if (!raw || raw.length < 2) continue;
    const lower = raw.toLowerCase();
    if (STOP_WORDS[lower]) continue;
    const stemmed = stemToken(lower);
    if (stemmed.length >= 2 && !STOP_WORDS[stemmed]) {
      tokens.push(stemmed);
    }
  }
  for (const m of text.matchAll(HAN_SEQ_RE)) {
    const seq = Array.from(m[0]);
    for (let i = 0; i < seq.length; i++) {
      const ch = seq[i];
      if (ch && !STOP_WORDS[ch]) {
        tokens.push(ch);
      }
      const next = seq[i + 1];
      if (ch && next) {
        tokens.push(`${ch}${next}`);
      }
    }
  }
  return tokens;
}

export interface SearchWindowHit {
  readonly docId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly score: number;
  readonly snippet: string;
}

export interface SearchOptions {
  readonly docIds?: readonly string[];
  readonly k?: number;
  readonly maxSnippetChars?: number;
}

interface IndexedWindow {
  readonly docId: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lines: readonly string[];
  readonly tokens: readonly string[];
  readonly tf: ReadonlyMap<string, number>;
  readonly bigrams: ReadonlySet<string>;
  readonly dl: number;
}

const DOC_WINDOW_CACHE = new WeakMap<StoredDocument, readonly IndexedWindow[]>();

function getDocumentWindows(doc: StoredDocument): readonly IndexedWindow[] {
  const cached = DOC_WINDOW_CACHE.get(doc);
  if (cached !== undefined) return cached;
  const nLines = doc.lines.length;
  if (nLines === 0) {
    const empty: readonly IndexedWindow[] = Object.freeze([]);
    DOC_WINDOW_CACHE.set(doc, empty);
    return empty;
  }
  const docWindows: IndexedWindow[] = [];
  for (let start = 0; start < nLines; start += WINDOW_STRIDE) {
    const end = Math.min(nLines, start + WINDOW_LINES);
    const slice = doc.lines.slice(start, end);
    const tokens = bm25Tokenize(slice.join('\n'));
    if (tokens.length === 0) {
      if (end >= nLines) break;
      continue;
    }
    const tf = new Map<string, number>();
    const bigrams = new Set<string>();
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok) continue;
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
      const next = tokens[i + 1];
      if (next) bigrams.add(`${tok}\u0000${next}`);
    }
    docWindows.push({
      docId: doc.id,
      startLine: start + 1,
      endLine: end,
      lines: slice,
      tokens,
      tf,
      bigrams,
      dl: tokens.length,
    });
    if (end >= nLines) break;
  }
  const frozen = Object.freeze(docWindows);
  DOC_WINDOW_CACHE.set(doc, frozen);
  return frozen;
}

/** Deterministic Okapi BM25 V2 index with Rocchio PRF and adjacent phrase bonus. */
export class Bm25DocumentIndex {
  private readonly windows: readonly IndexedWindow[];
  private readonly idfMap: ReadonlyMap<string, number>;
  private readonly avgdl: number;

  constructor(docs: readonly StoredDocument[]) {
    const windows: IndexedWindow[] = [];
    const df = new Map<string, number>();
    let totalTokens = 0;

    for (let d = 0; d < docs.length && windows.length < MAX_WINDOWS; d++) {
      const doc = docs[d];
      if (!doc || doc.lines.length === 0) continue;
      const docWindows = getDocumentWindows(doc);
      for (let w = 0; w < docWindows.length && windows.length < MAX_WINDOWS; w++) {
        const win = docWindows[w];
        if (!win) continue;
        for (const term of win.tf.keys()) {
          df.set(term, (df.get(term) ?? 0) + 1);
        }
        totalTokens += win.dl;
        windows.push(win);
      }
    }

    const n = windows.length;
    const idfMap = new Map<string, number>();
    for (const [term, docFreq] of df.entries()) {
      const idf = Math.log(1 + (n - docFreq + 0.5) / (docFreq + 0.5));
      idfMap.set(term, idf);
    }

    this.windows = windows;
    this.idfMap = idfMap;
    this.avgdl = n > 0 ? totalTokens / n : 1;
  }

  search(query: string, opts: SearchOptions = {}): SearchWindowHit[] {
    const queryTokens = bm25Tokenize(query);
    if (queryTokens.length === 0 || this.windows.length === 0) return [];

    const k = Math.max(1, Math.min(30, Math.floor(opts.k ?? 10)));
    const maxSnippetChars = opts.maxSnippetChars ?? 360;
    const allowedDocs = opts.docIds && opts.docIds.length > 0 ? new Set(opts.docIds) : undefined;

    const uniqueQueryTerms: string[] = [];
    const seenTerms = new Set<string>();
    for (let i = 0; i < queryTokens.length; i++) {
      const t = queryTokens[i];
      if (t && !seenTerms.has(t)) {
        seenTerms.add(t);
        uniqueQueryTerms.push(t);
      }
    }

    const queryBigrams: Array<readonly [string, string]> = [];
    const seenBigrams = new Set<string>();
    for (let i = 0; i + 1 < queryTokens.length; i++) {
      const a = queryTokens[i];
      const b = queryTokens[i + 1];
      if (!a || !b || a === b) continue;
      const key = `${a}\u0000${b}`;
      if (!seenBigrams.has(key)) {
        seenBigrams.add(key);
        queryBigrams.push([a, b]);
      }
    }

    const candidates: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < this.windows.length; i++) {
      const w = this.windows[i];
      if (!w) continue;
      if (allowedDocs && !allowedDocs.has(w.docId)) continue;
      const s = this.scoreWindowTerms(w, uniqueQueryTerms);
      if (s > 0) candidates.push({ idx: i, score: s });
    }
    if (candidates.length === 0) return [];

    candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);

    if (this.windows.length >= PRF_MIN_DOCS) {
      const feedbackCount = Math.min(PRF_FEEDBACK_DOCS, candidates.length);
      const feedbackTf = new Map<string, number>();
      for (let f = 0; f < feedbackCount; f++) {
        const cand = candidates[f];
        const w = cand ? this.windows[cand.idx] : undefined;
        if (!w) continue;
        for (const [term, count] of w.tf.entries()) {
          if (seenTerms.has(term)) continue;
          feedbackTf.set(term, (feedbackTf.get(term) ?? 0) + count);
        }
      }
      const expansionCandidates: Array<{ term: string; weight: number }> = [];
      for (const [term, count] of feedbackTf.entries()) {
        const idf = this.idfMap.get(term) ?? 0;
        if (idf > 0) expansionCandidates.push({ term, weight: count * idf });
      }
      expansionCandidates.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
      const expansionTerms = Array.from(
        { length: Math.min(PRF_EXPANSION_TERMS, expansionCandidates.length) },
        (_, i) => expansionCandidates[i]?.term ?? '',
      ).filter((t) => t.length > 0);

      if (expansionTerms.length > 0) {
        for (let i = 0; i < candidates.length; i++) {
          const cand = candidates[i];
          const w = cand ? this.windows[cand.idx] : undefined;
          if (!cand || !w) continue;
          cand.score += PRF_EXPANSION_WEIGHT * this.scoreWindowTerms(w, expansionTerms);
        }
        candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
      }
    }

    const rerankPool = Math.min(candidates.length, Math.min(RERANK_POOL_CAP, k * RERANK_POOL_MULT));
    if (queryBigrams.length > 0) {
      for (let i = 0; i < rerankPool; i++) {
        const cand = candidates[i];
        const w = cand ? this.windows[cand.idx] : undefined;
        if (!cand || !w) continue;
        for (let b = 0; b < queryBigrams.length; b++) {
          const pair = queryBigrams[b];
          if (!pair) continue;
          const [t1, t2] = pair;
          if (w.bigrams.has(`${t1}\u0000${t2}`)) {
            const idf1 = this.idfMap.get(t1) ?? 0;
            const idf2 = this.idfMap.get(t2) ?? 0;
            cand.score += PHRASE_BONUS_WEIGHT * Math.max(idf1, idf2);
          }
        }
      }
      candidates.sort((a, b) => b.score - a.score || a.idx - b.idx);
    }

    const selected: SearchWindowHit[] = [];
    const keptRanges: Array<{ docId: string; startLine: number; endLine: number }> = [];
    for (let i = 0; i < candidates.length && selected.length < k; i++) {
      const cand = candidates[i];
      const w = cand ? this.windows[cand.idx] : undefined;
      if (!cand || !w) continue;
      let overlaps = false;
      const wSpan = Math.max(1, w.endLine - w.startLine + 1);
      for (let j = 0; j < keptRanges.length; j++) {
        const prev = keptRanges[j];
        if (!prev || prev.docId !== w.docId) continue;
        const overlapStart = Math.max(w.startLine, prev.startLine);
        const overlapEnd = Math.min(w.endLine, prev.endLine);
        if (overlapEnd >= overlapStart) {
          const overlapLines = overlapEnd - overlapStart + 1;
          const prevSpan = Math.max(1, prev.endLine - prev.startLine + 1);
          if (overlapLines / Math.min(wSpan, prevSpan) >= 0.5) {
            overlaps = true;
            break;
          }
        }
      }
      if (overlaps) continue;
      keptRanges.push({ docId: w.docId, startLine: w.startLine, endLine: w.endLine });
      selected.push({
        docId: w.docId,
        startLine: w.startLine,
        endLine: w.endLine,
        score: cand.score,
        snippet: this.formatSnippet(w, uniqueQueryTerms, maxSnippetChars),
      });
    }

    return selected;
  }

  private scoreWindowTerms(w: IndexedWindow, terms: readonly string[]): number {
    let score = 0;
    const norm = BM25_K1 * (1 - BM25_B + BM25_B * (w.dl / this.avgdl));
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      if (!term) continue;
      const tf = w.tf.get(term) ?? 0;
      if (tf <= 0) continue;
      const idf = this.idfMap.get(term) ?? 0;
      if (idf <= 0) continue;
      score += idf * ((tf * (BM25_K1 + 1)) / (tf + norm));
    }
    return score;
  }

  private formatSnippet(w: IndexedWindow, queryTerms: readonly string[], maxSnippetChars: number): string {
    const querySet = new Set(queryTerms);
    let bestLineIdx = 0;
    let bestLineScore = -1;
    for (let i = 0; i < w.lines.length; i++) {
      const line = w.lines[i] ?? '';
      if (!line.trim()) continue;
      const lineToks = bm25Tokenize(line);
      let s = 0;
      for (let t = 0; t < lineToks.length; t++) {
        const tok = lineToks[t];
        if (tok && querySet.has(tok)) {
          s += this.idfMap.get(tok) ?? 1;
        }
      }
      if (s > bestLineScore) {
        bestLineScore = s;
        bestLineIdx = i;
      }
    }

    const startOffset = Math.max(0, bestLineIdx - 2);
    const endOffset = Math.min(w.lines.length, startOffset + 6);
    const out: string[] = [];
    let chars = 0;
    for (let i = startOffset; i < endOffset; i++) {
      const rawLine = w.lines[i] ?? '';
      const trimmed = rawLine.length > 160 ? `${rawLine.slice(0, 160)}…` : rawLine;
      const formatted = `  ${w.startLine + i}| ${trimmed}`;
      if (out.length > 0 && chars + formatted.length > maxSnippetChars) break;
      out.push(formatted);
      chars += formatted.length + 1;
    }
    return out.join('\n');
  }
}
