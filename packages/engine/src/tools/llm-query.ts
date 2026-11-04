import type { Chunk, ContextStore } from '../context/store.js';
import type { UsageTracker } from '../llm/usage.js';
import { LLM_QUERY_SYSTEM, renderChunkMessage, renderQueryMessage, type LLMQueryMode } from '../prompts/llm-query.js';
import { defaultEstimator, truncateToTokens } from '../tokens.js';
import type { LLMClient, ModelProfile } from '../types.js';
import { createLimiter } from '../util/concurrency.js';
import { tryParseLooseJSON } from '../util/json.js';
import { argNumber, argString, argStringList, ToolArgumentError, type Tool } from './types.js';

export interface LLMQueryOptions {
  /** Fraction of the query model's window kept free for prompt + output. Default 0.3. */
  reserveRatio?: number;
  /** Hard cap on chunk size (tokens). Dense tasks (counting) benefit from smaller chunks. */
  maxChunkTokens?: number;
  /** Lower bound for chunk size (tokens). Default 1024. */
  minChunkTokens?: number;
  /** Parallel chunk calls. Default 4. */
  concurrency?: number;
  /** Prefix each line with its number so findings can point to lines. Default true. */
  lineNumbers?: boolean;
  /** Max output tokens per chunk call. Default: model profile maxOutputTokens. */
  maxOutputTokens?: number;
  /** Cap on the aggregated observation returned to the agent. Default 6000. */
  maxReportTokens?: number;
  /** Refuse calls that would scan more than this many tokens. Default 4M. */
  maxScanTokens?: number;
  /** Memoize (chunk, mode, query) results in-process. Default true. */
  memoize?: boolean;
  temperature?: number;
}

export interface ChunkFinding {
  chunk: Chunk;
  relevant: boolean;
  answer: string;
  evidence: Array<{ line?: number; quote: string }>;
  /** Optional per-category integer counts (summed across chunks by the engine). */
  counts?: Record<string, number>;
  error?: string;
  memoHit: boolean;
}

export interface LLMQueryResult {
  mode: LLMQueryMode;
  chunkTokens: number;
  findings: ChunkFinding[];
  report: string;
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

function compressIndexRanges(idx: number[]): string {
  if (!idx.length) return '';
  const parts: string[] = [];
  let s = idx[0]!;
  let p = s;
  for (const i of idx.slice(1).concat([Number.NaN])) {
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

/**
 * The llm_query engine: fan a query out over deterministic chunks of stored
 * documents using a non-thinking model, then aggregate compact findings.
 */
export class LLMQueryEngine {
  private readonly memo = new Map<string, Omit<ChunkFinding, 'chunk' | 'memoHit'>>();
  private readonly limit: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(
    readonly llm: LLMClient,
    readonly store: ContextStore,
    readonly usage: UsageTracker,
    readonly opts: LLMQueryOptions = {},
  ) {
    this.limit = createLimiter(opts.concurrency ?? 4);
  }

  get defaultChunkTokens(): number {
    return computeChunkTokens(this.llm.profile, this.opts);
  }

  selectChunks(docIds: string[], chunkTokens: number, startLine?: number, endLine?: number): Chunk[] {
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
    query: string;
    mode?: LLMQueryMode;
    documents?: string[];
    startLine?: number;
    endLine?: number;
    chunkTokens?: number;
    signal?: AbortSignal;
    /** Usage sink for this call (defaults to the engine's tracker). */
    usage?: UsageTracker;
  }): Promise<LLMQueryResult> {
    const mode: LLMQueryMode = args.mode ?? 'locate';
    const docIds = args.documents?.length ? args.documents : this.store.list().map((d) => d.id);
    for (const id of docIds) this.store.get(id); // validate
    const maxSize = this.defaultChunkTokens;
    const chunkTokens = args.chunkTokens ? quantizeChunkTokens(args.chunkTokens, maxSize, this.opts.minChunkTokens) : maxSize;
    const chunks = this.selectChunks(docIds, chunkTokens, args.startLine, args.endLine);
    const scan = chunks.reduce((a, c) => a + c.tokens, 0);
    if (scan > (this.opts.maxScanTokens ?? 4_000_000)) {
      throw new ToolArgumentError(`llm_query 将扫描约 ${scan} token（上限 ${this.opts.maxScanTokens ?? 4_000_000}）；请缩小文档或行范围`);
    }
    const usage = args.usage ?? this.usage;
    const findings = await Promise.all(chunks.map((c) => this.limit(() => this.runChunk(c, args.query, mode, usage, args.signal))));
    return { mode, chunkTokens, findings, report: this.formatReport(args.query, mode, chunkTokens, findings) };
  }

  private async runChunk(chunk: Chunk, query: string, mode: LLMQueryMode, usage: UsageTracker, signal?: AbortSignal): Promise<ChunkFinding> {
    const lineNumbers = this.opts.lineNumbers !== false;
    const memoKey = `${chunk.key}|${lineNumbers ? 'n' : 'r'}|${mode}|${query}`;
    const hit = this.opts.memoize !== false ? this.memo.get(memoKey) : undefined;
    if (hit) return { ...hit, chunk, memoHit: true };
    const doc = this.store.get(chunk.docId);
    const messages = [
      { role: 'system' as const, content: LLM_QUERY_SYSTEM },
      {
        role: 'user' as const,
        content: renderChunkMessage({
          docId: chunk.docId,
          title: doc.title,
          index: chunk.index,
          total: chunk.total,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          body: this.store.renderChunk(chunk, lineNumbers),
        }),
        cacheBreakpoint: true,
      },
      { role: 'user' as const, content: renderQueryMessage(query, mode) },
    ];
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.llm.complete({
          messages,
          maxTokens: this.opts.maxOutputTokens ?? this.llm.profile.maxOutputTokens,
          temperature: this.opts.temperature ?? 0,
          signal,
          purpose: 'llm_query',
        });
        usage.record('llm_query', res.usage, res.latencyMs);
        const parsed = normalizeFinding(res.text);
        if (this.opts.memoize !== false) this.memo.set(memoKey, parsed);
        return { ...parsed, chunk, memoHit: false };
      } catch (e) {
        usage.recordError('llm_query');
        lastErr = (e as Error).message;
        if (signal?.aborted || (e as { retryable?: boolean }).retryable === false) break;
      }
    }
    return { chunk, relevant: false, answer: '', evidence: [], error: lastErr, memoHit: false };
  }

  formatReport(query: string, mode: LLMQueryMode, chunkTokens: number, findings: ChunkFinding[]): string {
    const relevant = findings.filter((f) => f.relevant && !f.error);
    const errors = findings.filter((f) => f.error);
    const fmt = (f: ChunkFinding) => {
      const ev = f.evidence
        .slice(0, 5)
        .map((e) => `L${e.line ?? '?'} "${e.quote.length > 160 ? `${e.quote.slice(0, 160)}…` : e.quote}"`)
        .join('；');
      return `#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] ${f.answer.replace(/\s+/g, ' ').trim()}${ev ? ` | 证据：${ev}` : ''}`;
    };
    const lines: string[] = [];
    lines.push(
      `llm_query（${mode}，模型 ${this.llm.profile.name}）扫描 ${findings.length} 个分块（约 ${chunkTokens.toLocaleString('en-US')} token）；相关 ${relevant.length}；错误 ${errors.length}；缓存 ${findings.filter((f) => f.memoHit).length}`,
    );
    lines.push(`查询：${query}`);
    if (mode === 'extract') {
      lines.push('各分块结果（请自行汇总）：');
      for (const f of findings) lines.push(f.error ? `#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] 错误：${f.error}` : fmt(f));
      const totals = sumCounts(findings);
      if (totals) {
        const withCounts = findings.filter((f) => f.counts).length;
        lines.push(
          `"counts" 已汇总（${withCounts}/${findings.length} 块）：` +
            Object.entries(totals)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]) => `${k}=${v}`)
              .join(', ') +
            (withCounts < findings.length ? '（警告：部分分块未给出 counts）' : ''),
        );
      }
    } else {
      if (relevant.length) {
        lines.push('相关分块：');
        for (const f of relevant) lines.push(fmt(f));
      } else lines.push('没有分块报告相关内容。');
      const irrelevant = findings.filter((f) => !f.relevant && !f.error).map((f) => f.chunk.index);
      if (irrelevant.length) lines.push(`不相关：${compressIndexRanges(irrelevant)}`);
      for (const f of errors) lines.push(`#${f.chunk.index + 1} [${f.chunk.docId} L${f.chunk.startLine}-${f.chunk.endLine}] 错误：${f.error}`);
    }
    return truncateToTokens(lines.join('\n'), this.opts.maxReportTokens ?? 6000).text;
  }
}

function normalizeFinding(text: string): Omit<ChunkFinding, 'chunk' | 'memoHit'> {
  const obj = tryParseLooseJSON<Record<string, unknown>>(text);
  if (!obj || typeof obj !== 'object') {
    const t = text.trim();
    const negative = /^(no|none|not relevant|irrelevant)\b/i.test(t) || /^(无|没有|否|不相关)/.test(t) || t === '';
    return { relevant: !negative, answer: t.slice(0, 2000), evidence: [] };
  }
  const relevantRaw = obj.relevant;
  const relevant = typeof relevantRaw === 'boolean' ? relevantRaw : String(relevantRaw).toLowerCase() === 'true';
  const answer = typeof obj.answer === 'string' ? obj.answer : obj.answer === undefined ? '' : JSON.stringify(obj.answer);
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .map((e) => {
          if (typeof e === 'string') return { quote: e };
          if (e && typeof e === 'object') {
            const r = e as Record<string, unknown>;
            const line = Number(r.line);
            return { line: Number.isFinite(line) ? line : undefined, quote: String(r.quote ?? r.text ?? '') };
          }
          return undefined;
        })
        .filter((e): e is { line: number | undefined; quote: string } => !!e)
    : [];
  let counts: Record<string, number> | undefined;
  if (obj.counts && typeof obj.counts === 'object' && !Array.isArray(obj.counts)) {
    counts = {};
    for (const [k, v] of Object.entries(obj.counts as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) counts[k.trim().toLowerCase()] = n;
    }
    if (!Object.keys(counts).length) counts = undefined;
  }
  return { relevant, answer, evidence, counts };
}

function sumCounts(findings: ChunkFinding[]): Record<string, number> | undefined {
  let any = false;
  const totals: Record<string, number> = {};
  for (const f of findings) {
    if (!f.counts) continue;
    any = true;
    for (const [k, v] of Object.entries(f.counts)) totals[k] = (totals[k] ?? 0) + v;
  }
  return any ? totals : undefined;
}

export function createLLMQueryTool(engine: LLMQueryEngine): Tool {
  return {
    name: 'llm_query',
    description:
      `用快速非推理阅读器模型（${engine.llm.profile.name}，${engine.llm.profile.contextWindow.toLocaleString('en-US')} token 窗口）扫描大文档。文档按约 ${engine.defaultChunkTokens.toLocaleString('en-US')} token 固定分块，查询并行作用于每个分块，返回带行号的各块发现。mode "locate"：定位内容；mode "extract"：在全部块上做抽取/分类/计数（由你汇总）。`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '自包含指令，作用于每个分块，并写明所需输出形式。' },
        mode: { type: 'string', enum: ['locate', 'extract'], default: 'locate', description: 'locate=定位；extract=抽取/分类/计数。' },
        documents: { type: 'array', items: { type: 'string' }, description: '文档 id（默认：全部）。' },
        start_line: { type: 'integer', description: '可选：只扫描与此行区间重叠的分块（仅限单个文档）。' },
        end_line: { type: 'integer' },
        chunk_tokens: { type: 'integer', description: `可选：密集任务用更小的分块（2 的幂，最大 ${engine.defaultChunkTokens}）。` },
      },
      required: ['query'],
    },
    async execute(args, ctx) {
      const query = argString(args, 'query')!;
      const modeRaw = argString(args, 'mode', false) ?? 'locate';
      if (modeRaw !== 'locate' && modeRaw !== 'extract') throw new ToolArgumentError('mode 必须是 "locate" 或 "extract"');
      const documents = argStringList(args, 'documents');
      const startLine = argNumber(args, 'start_line');
      const endLine = argNumber(args, 'end_line');
      if ((startLine !== undefined || endLine !== undefined) && (documents?.length ?? engine.store.list().length) !== 1) {
        throw new ToolArgumentError('start_line/end_line 要求恰好一个文档');
      }
      const res = await engine.query({
        query,
        mode: modeRaw,
        documents,
        startLine,
        endLine,
        chunkTokens: argNumber(args, 'chunk_tokens'),
        signal: ctx.signal,
        usage: ctx.usage,
      });
      ctx.emit({
        type: 'llm_query',
        agent: ctx.agentName,
        query,
        mode: modeRaw,
        chunks: res.findings.length,
        relevant: res.findings.filter((f) => f.relevant).length,
        errors: res.findings.filter((f) => f.error).length,
        memoHits: res.findings.filter((f) => f.memoHit).length,
        chunkTokens: res.chunkTokens,
      });
      return res.report;
    },
  };
}
