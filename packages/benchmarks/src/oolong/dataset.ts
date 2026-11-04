import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { asyncBufferFromUrl, cachedAsyncBuffer, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

/** One OOLONG-synth row (oolongbench/oolong-synth). */
export interface OolongRow {
  id: string;
  context_window_id: string;
  dataset: string;
  task_group: string;
  task: string;
  context_len: number;
  context_window_text: string;
  question: string;
  answer: string;
  answer_type: string;
}

export interface FetchOolongOptions {
  split?: 'test' | 'validation';
  dataset?: string; // e.g. trec_coarse
  contextLen?: number; // e.g. 131072
  cacheDir: string;
  hfToken?: string;
  log?: (msg: string) => void;
}

const HF_DATASET = 'oolongbench/oolong-synth';
const COLUMNS = ['id', 'context_window_id', 'dataset', 'task_group', 'task', 'context_len', 'context_window_text', 'question', 'answer', 'answer_type'];

export function oolongCachePath(o: FetchOolongOptions): string {
  return join(o.cacheDir, 'oolong-synth', o.split ?? 'test', `${o.dataset ?? 'all'}-${o.contextLen ?? 'all'}.jsonl`);
}

export function loadCachedOolong(o: FetchOolongOptions): OolongRow[] | undefined {
  const p = oolongCachePath(o);
  if (!existsSync(p)) return undefined;
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as OolongRow);
}

async function listParquetFiles(split: string, token?: string): Promise<string[]> {
  const res = await fetch(`https://datasets-server.huggingface.co/parquet?dataset=${encodeURIComponent(HF_DATASET)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HF parquet listing failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { parquet_files: Array<{ config: string; split: string; url: string }> };
  return json.parquet_files.filter((f) => f.config === 'default' && f.split === split).map((f) => f.url);
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

/**
 * Download the OOLONG-synth rows matching (dataset, context_len) using HTTP
 * range reads on the HF parquet conversion (only the needed column chunks and
 * row groups are fetched), and cache them as JSONL.
 */
export async function fetchOolong(o: FetchOolongOptions): Promise<OolongRow[]> {
  const cached = loadCachedOolong(o);
  if (cached) return cached;
  const log = o.log ?? (() => {});
  const split = o.split ?? 'test';
  const urls = await listParquetFiles(split, o.hfToken);
  log(`found ${urls.length} parquet files for ${HF_DATASET}/${split}`);
  const requestInit: RequestInit | undefined = o.hfToken ? { headers: { authorization: `Bearer ${o.hfToken}` } } : undefined;
  const rows: OolongRow[] = [];
  for (const [fi, url] of urls.entries()) {
    const file = cachedAsyncBuffer(await asyncBufferFromUrl({ url, requestInit }));
    const metadata = await parquetMetadataAsync(file);
    const meta = await parquetReadObjects({ file, metadata, columns: ['dataset', 'context_len'], rowFormat: 'object', compressors });
    const matches: number[] = [];
    meta.forEach((r, i) => {
      if (o.dataset && r.dataset !== o.dataset) return;
      if (o.contextLen && Number(r.context_len) !== o.contextLen) return;
      matches.push(i);
    });
    log(`[${fi + 1}/${urls.length}] ${url.split('/').pop()}: ${meta.length} rows, ${matches.length} match`);
    for (const [start, end] of ranges(matches)) {
      const got = await parquetReadObjects({ file, metadata, columns: COLUMNS, rowStart: start, rowEnd: end, rowFormat: 'object', compressors });
      for (const r of got) {
        rows.push({
          id: String(r.id),
          context_window_id: String(r.context_window_id),
          dataset: String(r.dataset),
          task_group: String(r.task_group ?? ''),
          task: String(r.task ?? ''),
          context_len: Number(r.context_len),
          context_window_text: String(r.context_window_text),
          question: String(r.question),
          answer: String(r.answer),
          answer_type: String(r.answer_type),
        });
      }
    }
  }
  if (rows.length === 0) throw new Error(`no OOLONG rows match dataset=${o.dataset} context_len=${o.contextLen} split=${split}`);
  const p = oolongCachePath(o);
  await new Promise<void>((resolve, reject) => {
    mkdirSync(dirname(p), { recursive: true });
    const ws = createWriteStream(p);
    ws.on('error', reject);
    ws.on('finish', resolve);
    for (const r of rows) ws.write(`${JSON.stringify(r)}\n`);
    ws.end();
  });
  log(`cached ${rows.length} rows → ${p}`);
  return rows;
}
