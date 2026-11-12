import type { Chunk, ContextStore } from '../context/store.js';
import { ResearchBoard } from '../context/board.js';
import type { UsageTracker } from '../llm/usage.js';
import { LLM_QUERY_SYSTEM, renderChunkMessage, renderQueryMessage, type LLMQueryMode } from '../prompts/llm-query.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';
import type { LLMClient, ModelProfile } from '../types.js';
import { createLimiter } from '../util/concurrency.js';
import { tryParseLooseJSON } from '../util/json.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

export interface LLMQueryCache {
  readonly memo: Map<string, Omit<ChunkFinding, 'chunk' | 'memoHit'>>;
  readonly chunkCounts: Map<string, Record<string, number>>;
}

export interface LLMQueryOptions {
  /** Fraction of the query model's window kept free for prompt + output. Default 0.3. */
  readonly reserveRatio?: number;
  /** Hard cap on chunk size (tokens). Dense tasks (counting) benefit from smaller chunks. */
  readonly maxChunkTokens?: number;
  /** Default chunk size (tokens) for mode === 'locate' when maxChunkTokens is not set. Default 32768. */
  readonly defaultLocateChunkTokens?: number;
  /** Default chunk size (tokens) for mode === 'extract'. Default 8192. */
  readonly defaultExtractChunkTokens?: number;
  readonly minChunkTokens?: number;
  /** Parallel chunk calls. Default 4. */
  readonly concurrency?: number;
  /** Prefix each line with its number so findings can point to lines. Default true. */
  readonly lineNumbers?: boolean;
  /** Max output tokens per chunk call. Default: model profile maxOutputTokens. */
  readonly maxOutputTokens?: number;
  /** Cap on the aggregated observation returned to the agent. Default 6000. */
  readonly maxReportTokens?: number;
  /** Refuse calls that would scan more than this many tokens. Default 4M. */
  readonly maxScanTokens?: number;
  /** Memoize (chunk, mode, query) results in-process. Default true. */
  readonly memoize?: boolean;
  readonly temperature?: number;
  readonly board?: ResearchBoard;
  readonly cache?: LLMQueryCache;
}

export interface ChunkFinding {
  readonly chunk: Chunk;
  readonly relevant: boolean;
  readonly answer: string;
  readonly evidence: readonly { readonly line?: number; readonly quote: string }[];
  /** Optional per-category integer counts (summed across chunks by the engine). */
  readonly counts?: Readonly<Record<string, number>>;
  readonly error?: string;
  readonly memoHit: boolean;
}

export interface LLMQueryResult {
  readonly mode: LLMQueryMode;
  readonly chunkTokens: number;
  readonly findings: readonly ChunkFinding[];
  readonly report: string;
}

const SYSTEM_TOKENS = defaultEstimator.count(LLM_QUERY_SYSTEM);
const QUERY_BUDGET_TOKENS = 600;

/**
 * Chunk size for a query model: contextWindow * (1 - reserveRatio), clamped
 * so system + query + output always fit, then capped by maxChunkTokens.
 */
export function computeChunkTokens(profile: ModelProfile, opts: LLMQueryOptions = {}): number {
  const reserve = opts.reserveRatio ?? 0.3;
  if (reserve < 0 || reserve >= 1) throw new Error('reserveRatio must be in [0, 1)');
  const lineFactor = opts.lineNumbers === false ? 1 : 0.92; // "123| " prefixes
  let size = Math.floor(profile.contextWindow * (1 - reserve) * lineFactor);
  const outTokens = opts.maxOutputTokens ?? profile.maxOutputTokens;
  size = Math.min(size, profile.contextWindow - SYSTEM_TOKENS - QUERY_BUDGET_TOKENS - outTokens);
  if (opts.maxChunkTokens) size = Math.min(size, opts.maxChunkTokens);
  return Math.max(size, opts.minChunkTokens ?? 1024);
}

/** Quantize agent-requested chunk sizes to powers of two so chunks (and caches) are reused. */
export function quantizeChunkTokens(requested: number, max: number, min = 1024): number {
  const q = 2 ** Math.round(Math.log2(Math.max(min, requested)));
  return Math.max(min, Math.min(max, q));
}

function compressIndexRanges(idx: readonly number[]): string {
  const first = idx[0];
  if (first === undefined) return '';
  const parts: string[] = [];
  let s = first;
  let p = s;
  for (let k = 1; k <= idx.length; k++) {
    const i = k < idx.length ? (idx[k] ?? Number.NaN) : Number.NaN;
    if (i === p + 1) {
      p = i;
      continue;
    }
    parts.push(s === p ? `#${s + 1}` : `#${s + 1}-${p + 1}`);
    s = i;
    p = i;
  }
  return parts.join(', ');
}

function extractQueryFilterSignature(query: string, canonCats: readonly string[]): string {
  const catSet = new Set(canonCats);
  const tokens: string[] = [];
  for (const m of query.matchAll(/\b(?:\d{4,}|\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,4})?)\b/g)) {
    if (m[0] && !catSet.has(m[0])) tokens.push(`num:${m[0]}`);
  }
  for (const m of query.matchAll(/\b(?:user|id|author|speaker|sender|account|entity)\s*[:=#]?\s*([a-z0-9_-]+)\b/gi)) {
    const id = (m[1] ?? '').toLowerCase();
    if (id && !catSet.has(id)) tokens.push(`ent:${id}`);
  }
  for (const m of query.matchAll(/"([^"\n]{1,80})"|'([^'\n]{1,80})'/g)) {
    const lit = (m[1] ?? m[2] ?? '').trim().toLowerCase();
    if (lit && !catSet.has(lit)) tokens.push(`lit:${lit}`);
  }
  const clause =
    /\b(?:where|after|before|since|until|between|except|excluding|without|only\s+(?:for|from|by)|for\s+[a-z0-9_-]+\s*=)\b[\s\S]*/i.exec(
      query,
    );
  if (clause?.[0]) {
    tokens.push(`clause:${clause[0].trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120)}`);
  }
  if (tokens.length === 0) return '';
  return [...new Set(tokens)].sort().join(';');
}

/** Emit a margin diagnostic when adjacent category counts differ by < 5% of total and < 4% of their sum. */
export function formatMarginNote(totals: Readonly<Record<string, number>>): string | undefined {
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (sorted.length < 2) return undefined;
  let n = 0;
  for (let i = 0; i < sorted.length; i++) {
    n += sorted[i]?.[1] ?? 0;
  }
  if (n <= 0) return undefined;
  const pairs: string[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b) continue;
    const [catA, cA] = a;
    const [catB, cB] = b;
    if (cA + cB <= 0) continue;
    const diff = Math.abs(cA - cB);
    if (diff / n < 0.05 && diff / (cA + cB) < 0.04) {
      pairs.push(`${catA}(${cA}) vs ${catB}(${cB}) margin=${diff} (${((diff / n) * 100).toFixed(1)}% of total)`);
    }
  }
  if (pairs.length === 0) return undefined;
  return `[Margin notice: close counts on ${pairs.join('; ')} — if literal/regex patterns distinguish these categories, verify with tally/grep before answering]`;
}

/**
 * The llm_query engine: fan a query out over deterministic chunks of stored
 * documents using a non-thinking model, then aggregate compact findings.
 */
export class LLMQueryEngine {
  private readonly memo: Map<string, Omit<ChunkFinding, 'chunk' | 'memoHit'>>;
  private readonly inFlight = new Map<string, Promise<Omit<ChunkFinding, 'chunk' | 'memoHit'>>>();
  private readonly chunkCounts: Map<string, Record<string, number>>;
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly board: ResearchBoard;

  constructor(
    readonly llm: LLMClient,
    readonly store: ContextStore,
    readonly usage: UsageTracker,
    readonly opts: LLMQueryOptions = {},
  ) {
    this.limit = createLimiter(opts.concurrency ?? 16);
    this.board = opts.board ?? new ResearchBoard();
    this.memo = opts.cache?.memo ?? new Map();
    this.chunkCounts = opts.cache?.chunkCounts ?? new Map();
  }

  get defaultChunkTokens(): number {
    const computed = computeChunkTokens(this.llm.profile, this.opts);
    if (this.opts.maxChunkTokens !== undefined) return computed;
    return Math.min(computed, this.opts.defaultLocateChunkTokens ?? 32_768);
  }

  get defaultExtractChunkTokens(): number {
    return Math.min(this.defaultChunkTokens, this.opts.defaultExtractChunkTokens ?? 8192);
  }
  selectChunks(docIds: readonly string[], chunkTokens: number, startLine?: number, endLine?: number): Chunk[] {
    const out: Chunk[] = [];
    for (const id of docIds) {
      for (const c of this.store.chunks(id, chunkTokens)) {
        // Whole fixed chunks overlapping the range: keeps prompts cache-identical.
        if (startLine !== undefined && c.endLine < startLine) continue;
        if (endLine !== undefined && c.startLine > endLine) continue;
        out.push(c);
      }
    }
    return out;
  }

  async query(args: {
    readonly query: string;
    readonly mode?: LLMQueryMode;
    readonly documents?: readonly string[];
    readonly startLine?: number;
    readonly endLine?: number;
    readonly chunkTokens?: number;
    readonly signal?: AbortSignal;
    /** Usage sink for this call (defaults to the engine's tracker). */
    readonly usage?: UsageTracker;
    readonly agent?: string;
    readonly categories?: readonly string[];
  }): Promise<LLMQueryResult> {
    const mode: LLMQueryMode = args.mode ?? 'locate';
    const docIds = args.documents?.length ? args.documents : this.store.listManifest().map((d) => d.id);
    for (const id of docIds) this.store.get(id); // validate
    const modeMax = mode === 'extract' ? this.defaultExtractChunkTokens : this.defaultChunkTokens;
    const chunkTokens = args.chunkTokens
      ? quantizeChunkTokens(args.chunkTokens, modeMax, this.opts.minChunkTokens)
      : modeMax;
    const chunks = this.selectChunks(docIds, chunkTokens, args.startLine, args.endLine);
    const scan = chunks.reduce((a, c) => a + c.tokens, 0);
    if (scan > (this.opts.maxScanTokens ?? 4_000_000)) {
      throw new ToolArgumentError(`llm_query would scan ~${scan} tokens (limit ${this.opts.maxScanTokens ?? 4_000_000}); narrow documents or line range`);
    }
    const usage = args.usage ?? this.usage;
    const findings = await Promise.all(chunks.map((c) => this.limit(() => this.runChunk(c, args.query, mode, usage, args.signal, args.categories))));
    const errors = findings.filter((f) => f.error);
    if (errors.length === 0) {
      const scope = `${docIds.join(',')}@${chunkTokens}:${args.startLine ?? 1}-${args.endLine ?? 'end'}`;
      const totals = sumCounts(findings);
      this.board.record({
        agent: args.agent ?? 'agent',
        kind: 'llm_query',
        scope,
        key: `${mode}:${args.query.slice(0, 160)}`,
        summary: totals
          ? `counts(${findings.filter((f) => f.counts).length}/${findings.length} chunks): ` +
            Object.entries(totals)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
          : `relevant ${findings.filter((f) => f.relevant).length}/${findings.length} chunks`,
        ...(totals ? { counts: Object.freeze({ ...totals }) } : {}),
      });
    }
    return { mode, chunkTokens, findings, report: this.formatReport(args.query, mode, chunkTokens, findings) };
  }

  private async runChunk(
    chunk: Chunk,
    query: string,
    mode: LLMQueryMode,
    usage: UsageTracker,
    signal?: AbortSignal,
    categories?: readonly string[],
  ): Promise<ChunkFinding> {
    const lineNumbers = this.opts.lineNumbers !== false;
    const canonCats =
      mode === 'extract' && categories && categories.length > 0
        ? [...new Set(categories.map((x) => x.trim().toLowerCase()).filter(Boolean))].sort()
        : undefined;
    const filterSig = canonCats ? extractQueryFilterSignature(query, canonCats) : '';
    const chunkCountKey = filterSig
      ? `${chunk.key}|${lineNumbers ? 'n' : 'r'}|${filterSig}`
      : `${chunk.key}|${lineNumbers ? 'n' : 'r'}`;
    if (canonCats && canonCats.length > 0) {
      const cachedCounts = this.chunkCounts.get(chunkCountKey);
      if (cachedCounts) {
        const hasAll = canonCats.every((cat) => Object.prototype.hasOwnProperty.call(cachedCounts, cat));
        if (hasAll) {
          const subsetCounts: Record<string, number> = {};
          for (const cat of canonCats) subsetCounts[cat] = cachedCounts[cat] ?? 0;
          return {
            chunk,
            relevant: true,
            answer: Object.entries(subsetCounts).map(([k, v]) => `${k}=${v}`).join(', '),
            evidence: [],
            counts: Object.freeze(subsetCounts),
            memoHit: true,
          };
        }
      }
    }
    const memoKey = `${chunk.key}|${lineNumbers ? 'n' : 'r'}|${mode}|${query}`;
    if (this.opts.memoize !== false) {
      const hit = this.memo.get(memoKey);
      if (hit) return { ...hit, chunk, memoHit: true };
    }
    const running = this.inFlight.get(memoKey);
    if (running) {
      const shared = await running;
      return { ...shared, chunk, memoHit: true };
    }

    const execPromise = (async () => {
      const doc = this.store.get(chunk.docId);
      const baseQueryContent = renderQueryMessage(query, mode, categories);
      const chunkContent = renderChunkMessage({
        docId: chunk.docId,
        title: doc.title,
        index: chunk.index,
        total: chunk.total,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        body: this.store.renderChunk(chunk, lineNumbers),
      });
      const systemMsg = {
        role: 'system' as const,
        content: LLM_QUERY_SYSTEM,
        cacheBreakpoint: true,
        segments: Object.freeze([Object.freeze({ text: LLM_QUERY_SYSTEM, cacheBreakpoint: true })]),
      };
      const chunkMsg = {
        role: 'user' as const,
        content: chunkContent,
        cacheBreakpoint: true,
        segments: Object.freeze([Object.freeze({ text: chunkContent, cacheBreakpoint: true })]),
      };
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        const queryContent =
          attempt > 0 && lastErr === 'reader response truncated or empty'
            ? `${baseQueryContent}\nCRITICAL: Your previous response ran out of tokens during thinking. Keep internal thinking under 50 words and output ONLY the XML tags (<relevant>, <counts>, <answer>, <evidence>) immediately.`
            : baseQueryContent;
        const messages = [
          systemMsg,
          chunkMsg,
          {
            role: 'user' as const,
            content: queryContent,
          },
        ];
        try {
          const res = await this.llm.complete({
            messages,
            maxTokens: this.opts.maxOutputTokens ?? this.llm.profile.maxOutputTokens,
            temperature: this.opts.temperature ?? 0,
            signal,
            purpose: 'llm_query',
            priority: 2,
            cacheKey: chunk.key,
          });
          usage.record('llm_query', res.usage, res.latencyMs);
          const trimmedRes = res.text.trim();
          const hasValidXml =
            parseXmlChunkFinding(trimmedRes) !== undefined &&
            (res.finishReason !== 'length' || /<\s*\/\s*(?:answer|counts|evidence|relevant)\s*>/i.test(trimmedRes));
          const hasValidJson = tryParseLooseJSON(trimmedRes) !== undefined;
          if (trimmedRes === '' || (res.finishReason === 'length' && !hasValidXml && !hasValidJson)) {
            throw new Error('reader response truncated or empty');
          }
          const parsed = normalizeFinding(trimmedRes);
          if (parsed.counts) {
            const existing = this.chunkCounts.get(chunkCountKey) ?? {};
            this.chunkCounts.set(chunkCountKey, { ...existing, ...parsed.counts });
          }
          if (this.opts.memoize !== false) this.memo.set(memoKey, parsed);
          return parsed;
        } catch (e) {
          usage.recordError('llm_query');
          lastErr = (e as Error).message;
          if (signal?.aborted || (e && typeof e === 'object' && 'retryable' in e && e.retryable === false)) break;
        }
      }
      return { relevant: false, answer: '', evidence: [], error: lastErr };
    })();

    this.inFlight.set(memoKey, execPromise);
    try {
      const result = await execPromise;
      return { ...result, chunk, memoHit: false };
    } finally {
      this.inFlight.delete(memoKey);
    }
  }

  formatReport(query: string, mode: LLMQueryMode, chunkTokens: number, findings: readonly ChunkFinding[]): string {
    const relevant = findings.filter((f) => f.relevant && !f.error);
    const errors = findings.filter((f) => f.error);
    const fmt = (f: ChunkFinding) => {
      const ev = f.evidence
        .slice(0, 5)
        .map((e) => `L${e.line ?? '?'} "${e.quote.length > 160 ? `${e.quote.slice(0, 160)}…` : e.quote}"`)
        .join('; ');
      const textAnswer = f.answer.replace(/\s+/g, ' ').trim();
      const ans =
        textAnswer === '' && f.counts
          ? Object.entries(f.counts)
              .map(([k, v]) => `${k}=${v}`)
              .join(', ')
          : textAnswer;
      return `#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] ${ans}${ev ? ` | evidence: ${ev}` : ''}`;
    };
    const lines: string[] = [];
    lines.push(
      `llm_query (${mode}, model ${this.llm.profile.name}) scanned ${findings.length} chunks (~${chunkTokens.toLocaleString('en-US')} tokens); relevant ${relevant.length}; errors ${errors.length}; cached ${findings.filter((f) => f.memoHit).length}`,
    );
    lines.push(`Query: ${query}`);
    if (mode === 'extract') {
      lines.push('Per-chunk findings (aggregate as needed):');
      for (const f of findings) lines.push(f.error ? `#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] error: ${f.error}` : fmt(f));
      const totals = sumCounts(findings);
      if (totals) {
        const withCounts = findings.filter((f) => f.counts).length;
        const marginNote = formatMarginNote(totals);
        lines.push(
          `Summed "counts" (${withCounts}/${findings.length} chunks): ` +
            Object.entries(totals)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}=${v}`)
              .join(', ') +
            (withCounts < findings.length ? ' (warning: some chunks omitted counts)' : ''),
        );
        if (marginNote) lines.push(marginNote);
      }
    } else {
      if (relevant.length) {
        const compactIndex = relevant
          .map((f) => `#${f.chunk.index + 1}[${f.chunk.docId}:L${f.chunk.startLine}-${f.chunk.endLine}, ev=${f.evidence.length}]`)
          .join(', ');
        lines.push(`Relevant chunk index (${relevant.length}): ${compactIndex}`);
        lines.push('Relevant chunks:');
        for (const f of relevant) lines.push(fmt(f));
      } else lines.push('No chunks reported relevant content.');
      const irrelevant = findings.filter((f) => !f.relevant && !f.error).map((f) => f.chunk.index);
      if (irrelevant.length) lines.push(`Irrelevant: ${compressIndexRanges(irrelevant)}`);
      for (const f of errors) lines.push(`#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] error: ${f.error}`);
    }
    return truncateToTokens(lines.join('\n'), this.opts.maxReportTokens ?? 6000).text;
  }
}

const NEGATIVE_FINDING_RE =
  /^(?:no\b|none\b|nothing\b|not\s+relevant\b|irrelevant\b|n\/a\b|0\s+matches\b|does\s+not\s+(?:contain|mention)\b|there\s+(?:is|are)\s+no\b)/i;

function parseXmlChunkFinding(text: string): Omit<ChunkFinding, 'chunk' | 'memoHit'> | undefined {
  const relMatch = /<\s*relevant(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*relevant\s*>/i.exec(text);
  const countsMatch = /<\s*counts(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*counts\s*>/i.exec(text);
  const ansMatch = /<\s*answer(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*answer\s*>/i.exec(text);
  const evMatch = /<\s*evidence(?:\s[^>]*)?>([\s\S]*?)<\s*\/\s*evidence\s*>/i.exec(text);
  if (!relMatch && !countsMatch && !ansMatch && !evMatch) return undefined;

  let counts: Record<string, number> | undefined;
  if (countsMatch?.[1] !== undefined) {
    const rawCounts = countsMatch[1].trim();
    if (rawCounts.startsWith('{')) {
      const parsed = tryParseLooseJSON<Record<string, unknown>>(rawCounts);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        counts = {};
        for (const [k, v] of Object.entries(parsed)) {
          const n = typeof v === 'number' ? v : Number(v);
          if (Number.isFinite(n)) counts[k.trim().toLowerCase()] = n;
        }
      }
    } else {
      counts = {};
      const segments = rawCounts.includes('\n') ? rawCounts.split('\n') : rawCounts.split(',');
      for (const seg of segments) {
        const m = /^\s*(?:[-*]\s*)?([^:=\n]+?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(seg);
        if (m && m[1] !== undefined && m[2] !== undefined) {
          const key = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
          const n = Number(m[2]);
          if (key && Number.isFinite(n)) counts[key] = n;
        }
      }
    }
    if (counts && Object.keys(counts).length === 0) counts = undefined;
  }

  const evidence: Array<{ line: number | undefined; quote: string }> = [];
  if (evMatch?.[1] !== undefined) {
    const rawEv = evMatch[1].trim();
    const lines = rawEv.split('\n');
    for (const lineStr of lines) {
      const trimmed = lineStr.trim();
      if (!trimmed || /^(?:none|n\/a|-)$/i.test(trimmed)) continue;
      const m = /^(?:[-*]\s*)?(?:L|line\s*)?(\d+)\s*[:|-]\s*(.+)$/i.exec(trimmed);
      if (m && m[1] !== undefined && m[2] !== undefined) {
        const lineNum = Number(m[1]);
        const quote = m[2].trim().replace(/^["']|["']$/g, '');
        evidence.push({ line: Number.isFinite(lineNum) ? lineNum : undefined, quote });
      } else {
        evidence.push({ line: undefined, quote: trimmed.replace(/^[-*]\s*/, '') });
      }
    }
  }

  const answer = ansMatch?.[1]?.trim() ?? '';
  const relStr = relMatch?.[1]?.trim().toLowerCase();
  const relevant =
    relStr === 'true' || relStr === 'yes' || relStr === '1'
      ? true
      : relStr === 'false' || relStr === 'no' || relStr === '0'
        ? counts !== undefined
        : counts !== undefined || evidence.length > 0 || (answer !== '' && !NEGATIVE_FINDING_RE.test(answer));

  return { relevant, answer, evidence, counts };
}

function normalizeFinding(text: string): Omit<ChunkFinding, 'chunk' | 'memoHit'> {
  const xmlFinding = parseXmlChunkFinding(text);
  if (xmlFinding !== undefined) return xmlFinding;

  const obj = tryParseLooseJSON<Record<string, unknown>>(text);
  if (!obj || typeof obj !== 'object') {
    const t = text.trim();
    const negative = NEGATIVE_FINDING_RE.test(t) || t === '';
    return { relevant: !negative, answer: t.slice(0, 2000), evidence: [] };
  }
  let counts: Record<string, number> | undefined;
  if (obj.counts && typeof obj.counts === 'object' && !Array.isArray(obj.counts)) {
    counts = {};
    for (const [k, v] of Object.entries(obj.counts)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) counts[k.trim().toLowerCase()] = n;
    }
    if (!Object.keys(counts).length) counts = undefined;
  }
  const relevantRaw = obj.relevant;
  const relevant =
    typeof relevantRaw === 'boolean'
      ? relevantRaw
      : counts !== undefined || String(relevantRaw).toLowerCase() === 'true';
  const answer = typeof obj.answer === 'string' ? obj.answer : obj.answer === undefined ? '' : JSON.stringify(obj.answer);
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .map((e) => {
          if (typeof e === 'string') return { quote: e };
          if (e && typeof e === 'object') {
            const line = 'line' in e ? Number(e.line) : Number.NaN;
            const quote = 'quote' in e ? String(e.quote) : 'text' in e ? String(e.text) : '';
            return { line: Number.isFinite(line) ? line : undefined, quote };
          }
          return undefined;
        })
        .filter((e): e is { line: number | undefined; quote: string } => !!e)
    : [];
  return { relevant, answer, evidence, counts };
}

function sumCounts(findings: readonly ChunkFinding[]): Record<string, number> | undefined {
  let hasCounts = false;
  const totals: Record<string, number> = {};
  for (const f of findings) {
    if (!f.counts) continue;
    hasCounts = true;
    for (const [k, v] of Object.entries(f.counts)) totals[k] = (totals[k] ?? 0) + v;
  }
  return hasCounts ? totals : undefined;
}

export function createLLMQueryTool(engine: LLMQueryEngine): Tool {
  return {
    name: 'llm_query',
    description:
      `Scan large documents in parallel using fast chunk reader model (${engine.llm.profile.name}, ${engine.llm.profile.contextWindow.toLocaleString('en-US')} token window). Default chunk size: ~${engine.defaultChunkTokens.toLocaleString('en-US')} tokens for "locate", ~${engine.defaultExtractChunkTokens.toLocaleString('en-US')} tokens for "extract". Mode "locate" finds matching lines/quotes; mode "extract" classifies/counts items across all chunks and sums "counts".`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Self-contained instruction applied to each chunk, specifying what to locate or count.' },
        mode: { type: 'string', enum: ['locate', 'extract'], default: 'locate', description: 'locate = find relevant lines; extract = classify/count across all chunks.' },
        documents: { type: 'array', items: { type: 'string' }, description: 'Document ids (default: all).' },
        start_line: { type: 'integer', description: 'Optional: only scan chunks overlapping this line range (single document only).' },
        end_line: { type: 'integer' },
        chunk_tokens: { type: 'integer', description: `Optional: smaller power-of-2 chunk size for dense tasks (max ${engine.defaultChunkTokens} for locate, ${engine.defaultExtractChunkTokens} for extract).` },
        categories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional (required for extract counting/classification): exact category names to count and sum across chunks.',
        },
      },
      required: ['query'],
    },
    isConcurrencySafe: () => true,
    async execute(args, ctx) {
      const query = argString(args, 'query') ?? '';
      const modeRaw = argString(args, 'mode', false) ?? 'locate';
      if (modeRaw !== 'locate' && modeRaw !== 'extract') throw new ToolArgumentError('mode must be "locate" or "extract"');
      const documents = argStringList(args, 'documents');
      const startLine = argNumber(args, 'start_line');
      const endLine = argNumber(args, 'end_line');
      if ((startLine !== undefined || endLine !== undefined) && (documents?.length ?? engine.store.listManifest().length) !== 1) {
        throw new ToolArgumentError('start_line/end_line requires exactly one document');
      }
      const categories = argStringList(args, 'categories');
      const before = ctx.usage.byRole()['llm_query'];
      const res = await engine.query({
        query,
        mode: modeRaw,
        documents,
        startLine,
        endLine,
        chunkTokens: argNumber(args, 'chunk_tokens'),
        categories,
        signal: ctx.signal,
        usage: ctx.usage,
        agent: ctx.agentName,
      });
      const after = ctx.usage.byRole()['llm_query'];
      const delta = {
        promptTokens: (after?.promptTokens ?? 0) - (before?.promptTokens ?? 0),
        completionTokens: (after?.completionTokens ?? 0) - (before?.completionTokens ?? 0),
        cachedTokens: (after?.cachedTokens ?? 0) - (before?.cachedTokens ?? 0),
        reasoningTokens: (after?.reasoningTokens ?? 0) - (before?.reasoningTokens ?? 0),
      };
      ctx.emit({
        type: 'llm_query',
        agent: ctx.agentName,
        step: ctx.step,
        query,
        mode: modeRaw,
        chunks: res.findings.length,
        relevant: res.findings.filter((f) => f.relevant).length,
        errors: res.findings.filter((f) => f.error).length,
        memoHits: res.findings.filter((f) => f.memoHit).length,
        chunkTokens: res.chunkTokens,
        calls: (after?.calls ?? 0) - (before?.calls ?? 0),
        usage: delta,
      });
      return res.report;
    },
  };
}
