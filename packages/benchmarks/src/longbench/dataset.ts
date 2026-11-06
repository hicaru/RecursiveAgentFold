import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/** One row from HuggingFace `zai-org/LongBench-v2`. */
export interface LongBenchRow {
  readonly _id: string;
  readonly domain: string;
  readonly sub_domain: string;
  readonly difficulty: string;
  readonly length: string;
  readonly question: string;
  readonly choice_A: string;
  readonly choice_B: string;
  readonly choice_C: string;
  readonly choice_D: string;
  readonly answer: string;
  readonly context: string;
}

export interface FetchLongBenchOptions {
  readonly domain?: string;
  readonly difficulty?: string;
  readonly length?: string;
  readonly limit?: number;
  readonly cacheDir: string;
  readonly hfToken?: string;
  readonly log?: (msg: string) => void;
}

const HF_DATASET = 'zai-org/LongBench-v2';
const META_COLUMNS = ['_id', 'domain', 'sub_domain', 'difficulty', 'length'];
const ALL_COLUMNS = [
  '_id',
  'domain',
  'sub_domain',
  'difficulty',
  'length',
  'question',
  'choice_A',
  'choice_B',
  'choice_C',
  'choice_D',
  'answer',
  'context',
];
const DEFAULT_DOMAINS = Object.freeze(['code repository understanding', 'multi-document qa']);

function matchesFilter(
  r: Record<string, unknown>,
  o: FetchLongBenchOptions,
): boolean {
  const dom = String(r.domain ?? '').toLowerCase();
  const sub = String(r.sub_domain ?? '').toLowerCase();
  if (o.domain && o.domain !== 'all') {
    const wanted = o.domain
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const domMatch = wanted.some((w) => dom.includes(w) || sub.includes(w));
    if (!domMatch) return false;
  } else if (!o.domain) {
    const domMatch = DEFAULT_DOMAINS.some((w) => dom.includes(w) || sub.includes(w));
    if (!domMatch) return false;
  }
  if (o.difficulty && String(r.difficulty ?? '').toLowerCase() !== o.difficulty.toLowerCase()) {
    return false;
  }
  if (o.length && String(r.length ?? '').toLowerCase() !== o.length.toLowerCase()) {
    return false;
  }
  return true;
}

export function longBenchCachePath(o: FetchLongBenchOptions): string {
  const domSlug = (o.domain ?? 'code-multidoc').replace(/[^a-z0-9_-]+/gi, '_').toLowerCase();
  const diffSlug = (o.difficulty ?? 'all').toLowerCase();
  const lenSlug = (o.length ?? 'all').toLowerCase();
  return join(o.cacheDir, 'longbench-v2', `${domSlug}-${diffSlug}-${lenSlug}.jsonl`);
}

export function loadCachedLongBench(o: FetchLongBenchOptions): LongBenchRow[] | undefined {
  const p = longBenchCachePath(o);
  if (!existsSync(p)) return undefined;
  const rows = readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LongBenchRow);
  if (o.limit && rows.length < o.limit) return undefined;
  return o.limit ? rows.slice(0, o.limit) : rows;
}

async function listParquetUrls(token?: string): Promise<string[]> {
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
  const apiRes = await fetch(`https://huggingface.co/api/datasets/${HF_DATASET}/parquet/default/train`, { headers });
  if (apiRes.ok) {
    const urls = (await apiRes.json()) as unknown;
    if (Array.isArray(urls) && urls.every((u) => typeof u === 'string')) {
      return urls as string[];
    }
  }
  const dsRes = await fetch(`https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(HF_DATASET)}`, {
    headers,
  });
  if (!dsRes.ok) throw new Error(`HF parquet listing failed: ${dsRes.status}`);
  const json = (await dsRes.json()) as { parquet_files: Array<{ split: string; url: string }> };
  return json.parquet_files.filter((f) => f.split === 'train').map((f) => f.url);
}

function ranges(indices: number[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const i of indices.sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

function toRow(r: Record<string, unknown>): LongBenchRow {
  return {
    _id: String(r._id ?? ''),
    domain: String(r.domain ?? ''),
    sub_domain: String(r.sub_domain ?? ''),
    difficulty: String(r.difficulty ?? ''),
    length: String(r.length ?? ''),
    question: String(r.question ?? ''),
    choice_A: String(r.choice_A ?? ''),
    choice_B: String(r.choice_B ?? ''),
    choice_C: String(r.choice_C ?? ''),
    choice_D: String(r.choice_D ?? ''),
    answer: String(r.answer ?? ''),
    context: String(r.context ?? ''),
  };
}

export async function fetchLongBenchV2(o: FetchLongBenchOptions): Promise<LongBenchRow[]> {
  const cached = loadCachedLongBench(o);
  if (cached && cached.length > 0) return cached;
  const log = o.log ?? (() => {});
  const maxRows = o.limit ?? 24;
  const rows: LongBenchRow[] = [];
  const requestInit: RequestInit | undefined = o.hfToken
    ? { headers: { authorization: `Bearer ${o.hfToken}` } }
    : undefined;

  try {
    const urls = await listParquetUrls(o.hfToken);
    log(`found ${urls.length} parquet file(s) for ${HF_DATASET}`);
    for (const [fi, url] of urls.entries()) {
      if (rows.length >= maxRows) break;
      const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, requestInit }));
      const metadata = await parquetMetadataAsync(file);
      const meta = await parquetReadObjects({
        file,
        metadata,
        columns: META_COLUMNS,
        rowFormat: 'object',
        compressors,
      });
      const matches: number[] = [];
      meta.forEach((r, i) => {
        if (matches.length + rows.length >= maxRows) return;
        if (matchesFilter(r, o)) matches.push(i);
      });
      log(`[${fi + 1}/${urls.length}] ${url.split('/').pop()}: ${meta.length} rows, ${matches.length} selected`);
      for (const [start, end] of ranges(matches)) {
        const got = await parquetReadObjects({
          file,
          metadata,
          columns: ALL_COLUMNS,
          rowStart: start,
          rowEnd: end,
          rowFormat: 'object',
          compressors,
        });
        for (const r of got) rows.push(toRow(r));
      }
    }
  } catch (err) {
    log(`parquet fetch failed (${(err as Error).message}); falling back to data.json`);
    const fallbackUrl = `https://huggingface.co/datasets/${HF_DATASET}/resolve/main/data.json`;
    const res = await fetch(fallbackUrl, requestInit);
    if (!res.ok) throw new Error(`LongBench-v2 fetch failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of data) {
      if (rows.length >= maxRows) break;
      if (matchesFilter(r, o)) rows.push(toRow(r));
    }
  }

  if (rows.length === 0) {
    throw new Error(`no LongBench-v2 rows matched domain=${o.domain ?? 'default'} difficulty=${o.difficulty ?? 'all'} length=${o.length ?? 'all'}`);
  }

  const p = longBenchCachePath(o);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  log(`cached ${rows.length} LongBench-v2 rows → ${p}`);
  return o.limit ? rows.slice(0, o.limit) : rows;
}
