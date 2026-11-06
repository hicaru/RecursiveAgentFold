import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AsyncBuffer, FileMetaData } from 'hyparquet';
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/**
 * One row of LongBench-Pro v1.0 (open-ended answers; the gated TIGER-Lab
 * v1.1 multiple-choice variant is not publicly accessible).
 */
export interface LongBenchProRow {
  readonly _id: string;
  readonly domain: string;
  readonly difficulty: string;
  readonly length: string;
  readonly question: string;
  readonly answer: string;
  readonly context: string;
  readonly token_length: number;
}

export interface FetchLongBenchProOptions {
  domain?: string;
  length?: string;
  limit?: number;
  cacheDir: string;
  hfToken?: string;
  log?: (msg: string) => void;
}

/** TIGER-Lab original (v1.1) is gated; caskcsg is the authors' public v1.0 mirror. */
const DATASETS = Object.freeze(['caskcsg/LongBench-Pro', 'TIGER-Lab/LongBench-Pro']);

export function longBenchProCachePath(o: FetchLongBenchProOptions): string {
  return join(o.cacheDir, 'longbench-pro', `${o.domain ?? 'all'}-${o.length ?? 'all'}.jsonl`);
}

export function loadCachedLongBenchPro(o: FetchLongBenchProOptions): LongBenchProRow[] | undefined {
  const p = longBenchProCachePath(o);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LongBenchProRow);
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

/** Column-name variants per candidate schema, resolved against row 1 keys. */
interface Schema {
  readonly meta: string[];
  readonly all: string[];
  readonly idKey: string;
  readonly questionKey: string;
  readonly answerKey: string;
  readonly domainKey?: string;
  readonly difficultyKey?: string;
  readonly tokenLengthKey?: string;
}

function resolveSchema(keys: readonly string[]): Schema {
  const has = (k: string) => keys.includes(k);
  const idKey = ['_id', 'id', 'filename'].find(has) ?? '_id';
  const questionKey =
    ['question', 'question_nonthinking', 'question_thinking'].find(has) ?? 'question';
  const answerKey = ['answer', 'ground_truth', 'gold'].find(has) ?? 'answer';
  const meta = [idKey, questionKey, answerKey];
  const domainKey = ['domain', 'primary_task'].find(has);
  if (domainKey) meta.push(domainKey);
  const difficultyKey = ['difficulty', 'complexity'].find(has);
  if (difficultyKey) meta.push(difficultyKey);
  const tokenLengthKey = ['token_length', 'length', 'context_length'].find(has);
  if (tokenLengthKey) meta.push(tokenLengthKey);
  const all = [...new Set([...meta, 'context'])];
  return { meta, all, idKey, questionKey, answerKey, domainKey, difficultyKey, tokenLengthKey };
}

/** Map numeric token_length onto LongBench v2-style length buckets. */
function lengthBucket(n: number): string {
  if (n <= 32_000) return 'short';
  if (n <= 128_000) return 'medium';
  return 'long';
}

function toRow(r: Record<string, unknown>, s: Schema): LongBenchProRow {
  const rawLen = s.tokenLengthKey ? Number(r[s.tokenLengthKey] ?? 0) : 0;
  return {
    _id: String(r[s.idKey] ?? ''),
    domain: s.domainKey ? String(r[s.domainKey] ?? '') : '',
    difficulty: s.difficultyKey ? String(r[s.difficultyKey] ?? '') : '',
    length: Number.isFinite(rawLen) && rawLen > 0 ? lengthBucket(rawLen) : 'unknown',
    question: String(r[s.questionKey] ?? ''),
    answer: String(r[s.answerKey] ?? ''),
    context: String(r.context ?? ''),
    token_length: Number.isFinite(rawLen) ? rawLen : 0,
  };
}

function matchesMeta(r: Record<string, unknown>, s: Schema, o: FetchLongBenchProOptions): boolean {
  if (!String(r[s.answerKey] ?? '').trim()) return false;
  if (o.domain && s.domainKey && !String(r[s.domainKey] ?? '').toLowerCase().includes(o.domain.toLowerCase())) return false;
  if (o.length && s.tokenLengthKey) {
    const n = Number(r[s.tokenLengthKey] ?? 0);
    if (!(Number.isFinite(n) && n > 0 && lengthBucket(n) === o.length.toLowerCase())) return false;
  }
  return true;
}

/**
 * Download LongBench-Pro rows via HTTP range reads on the HF parquet
 * conversion: row 1 resolves the schema, a meta-column pass filters, then
 * only matched full rows are fetched. Cached as JSONL.
 */
export async function fetchLongBenchPro(o: FetchLongBenchProOptions): Promise<LongBenchProRow[]> {
  const cached = loadCachedLongBenchPro(o);
  if (cached && cached.length > 0) {
    o.log?.(`loaded ${cached.length} cached LongBench-Pro rows`);
    return o.limit ? cached.slice(0, o.limit) : cached;
  }
  const log = o.log ?? (() => {});
  const maxRows = o.limit ?? 24;
  const requestInit: RequestInit | undefined = o.hfToken
    ? { headers: { authorization: `Bearer ${o.hfToken}` } }
    : undefined;

  let file: AsyncBuffer | undefined;
  let metadata: FileMetaData | undefined;
  let schema: Schema | undefined;
  let dataset = '';
  for (const ds of DATASETS) {
    try {
      const res = await fetch(`https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(ds)}`, {
        headers: requestInit?.headers,
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const json = (await res.json()) as { parquet_files: Array<{ split: string; url: string }> };
      const url = json.parquet_files.find((f) => f.split === 'test')?.url ?? json.parquet_files[0]?.url;
      if (!url) throw new Error('no parquet files');
      const candidate = cachedAsyncBuffer(await asyncBufferFromUrl({ url, requestInit }));
      const candidateMeta = await parquetMetadataAsync(candidate);
      const probe = await parquetReadObjects({
        file: candidate,
        metadata: candidateMeta,
        rowStart: 0,
        rowEnd: 1,
        rowFormat: 'object',
        compressors,
      });
      const keys = Object.keys(probe[0] ?? {});
      if (!keys.includes('context') && !keys.includes('answer')) {
        throw new Error(`unexpected schema: ${keys.join(',')}`);
      }
      file = candidate;
      metadata = candidateMeta;
      schema = resolveSchema(keys);
      dataset = ds;
      break;
    } catch (err) {
      log(`${ds} unavailable (${(err as Error).message}); trying next mirror`);
    }
  }
  if (!file || !metadata || !schema) throw new Error('no accessible LongBench-Pro mirror (both gated?)');

  const rows: LongBenchProRow[] = [];
  const meta = await parquetReadObjects({ file, metadata, columns: schema.meta, rowFormat: 'object', compressors });
  const matches: number[] = [];
  meta.forEach((r, i) => {
    if (matches.length >= maxRows) return;
    if (matchesMeta(r, schema as Schema, o)) matches.push(i);
  });
  log(`${dataset}: ${meta.length} rows, ${matches.length} match filters (${schema.meta.join(',')})`);

  for (const [start, end] of ranges(matches)) {
    const got = await parquetReadObjects({
      file,
      metadata,
      columns: schema.all,
      rowStart: start,
      rowEnd: end,
      rowFormat: 'object',
      compressors,
    });
    for (const r of got) rows.push(toRow(r, schema));
  }
  const usable = rows.filter((r) => r.question && r.context && r.answer);
  if (usable.length === 0) {
    throw new Error(`no LongBench-Pro rows matched domain=${o.domain ?? 'all'} length=${o.length ?? 'all'}`);
  }

  const p = longBenchProCachePath(o);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${usable.map((r) => JSON.stringify(r)).join('\n')}\n`);
  log(`cached ${usable.length} LongBench-Pro rows -> ${p}`);
  return o.limit ? usable.slice(0, o.limit) : usable;
}
