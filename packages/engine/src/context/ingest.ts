/**
 * Multi-format file & directory ingestion into ContextStore documents.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultEstimator } from '../tokens.js';
import { createLimiter } from '../util/concurrency.js';
import { convertPdfFallback, documentExtFromPath, getAnydoc, type AnydocHandle } from './anydoc.js';
import { captureStamp, readMdCache, writeMdCache } from './md-cache.js';
import {
  checkPathSafety,
  enumerateFiles,
  isBinary,
  isInsideRoot,
  isSensitivePath,
  type SkipReason,
  type SkippedFile,
} from './walk.js';

export const MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_WALK_FILE_BYTES = 1_048_576;
export const DEFAULT_MAX_WALK_FILES = 1200;
export const DEFAULT_MAX_TOTAL_CHARS = 32 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_SKIPPED_REPORTED = 64;
export const MTIME_FRESHNESS_WINDOW_MS = 2_000;

const INGEST_CONCURRENCY = 8;

export interface HostFileStat {
  readonly mtimeMs: number;
  readonly size: number;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface HostFileSystem {
  stat(path: string): Promise<HostFileStat>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readdir?(
    path: string,
    opts: { withFileTypes: true },
  ): Promise<readonly { readonly name: string; isFile(): boolean; isDirectory(): boolean }[]>;
  lstat?(path: string): Promise<HostFileStat & { isSymbolicLink(): boolean }>;
  realpath?(path: string): Promise<string>;
  readBytes?(path: string, maxBytes: number): Promise<Uint8Array>;
}

const DEFAULT_HOST_FS: HostFileSystem = Object.freeze({
  stat: (p: string) => stat(p),
  readFile: (p: string, encoding: 'utf8') => readFile(p, encoding),
});
export interface IngestedFile {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly content: string;
  readonly tokens: number;
  readonly isDocument: boolean;
  readonly converted: boolean;
  readonly mtimeMs?: number;
  readonly byteSize?: number;
}

export interface IngestOptions {
  readonly cwd?: string;
  readonly idPrefix?: string;
  readonly signal?: AbortSignal;
  readonly maxWalkFileBytes?: number;
  readonly maxFiles?: number;
  readonly maxTotalChars?: number;
  readonly skipRichDocuments?: boolean;
  readonly fs?: HostFileSystem;
}
export interface IngestResult {
  readonly source: string;
  readonly resolvedPath: string;
  readonly sourceId: string;
  readonly files: readonly IngestedFile[];
  readonly totalTokens: number;
  readonly totalChars: number;
  readonly documents: number;
  readonly converted: number;
  readonly skipped: readonly SkippedFile[];
}

export function sanitizeDocId(raw: string): string {
  const normalized = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!normalized) return 'doc';
  const rawSegments = normalized.split('/');
  const cleanSegments: string[] = [];
  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    if (!seg || seg === '.' || seg === '..') continue;
    const cleaned = seg
      .replace(/^[^A-Za-z0-9_.\-]+|[^A-Za-z0-9_.\-]+$/g, '')
      .replace(/[^A-Za-z0-9_.\-]+/g, '_');
    if (cleaned.length > 0) cleanSegments.push(cleaned);
  }
  return cleanSegments.length > 0 ? cleanSegments.join('/') : 'doc';
}

export function deriveSourceId(sourcePath: string, resolvedPath: string): string {
  const base = basename(resolvedPath) || basename(sourcePath) || 'source';
  return sanitizeDocId(base);
}

export function makeDocId(prefix: string | undefined, relPath: string): string {
  const cleanRel = sanitizeDocId(relPath);
  if (!prefix) return cleanRel;
  const cleanPrefix = sanitizeDocId(prefix);
  if (!cleanPrefix || cleanRel === cleanPrefix || cleanRel.startsWith(`${cleanPrefix}/`)) return cleanRel;
  return `${cleanPrefix}/${cleanRel}`;
}

function skipReasonFromError(err: unknown): SkipReason {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code: unknown = err.code;
    if (
      code === 'unsupported' ||
      code === 'malformed' ||
      code === 'encrypted' ||
      code === 'resourceLimit' ||
      code === 'missingPart' ||
      code === 'io' ||
      code === 'needsOcr' ||
      code === 'hosted'
    ) {
      return code;
    }
  }
  return 'convert-failed';
}

type FileIngestOutcome =
  | { readonly ok: true; readonly value: IngestedFile }
  | { readonly ok: false; readonly skipped: SkippedFile };

async function documentToIngestedFile(
  absPath: string,
  relPath: string,
  idPrefix: string | undefined,
  anydoc: AnydocHandle | null,
): Promise<FileIngestOutcome> {
  const docId = makeDocId(idPrefix, relPath);
  const stamp = await captureStamp(absPath);
  if (stamp === undefined) {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'unreadable' }) };
  }
  if (stamp.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'oversized' }) };
  }
  if (anydoc === null) {
    if (documentExtFromPath(absPath) === 'pdf') {
      const cachedPdf = await readMdCache(absPath);
      if (cachedPdf !== undefined) {
        return {
          ok: true,
          value: Object.freeze({
            id: docId,
            title: docId,
            path: absPath,
            content: cachedPdf,
            tokens: defaultEstimator.count(cachedPdf),
            isDocument: true,
            converted: false,
            mtimeMs: stamp.mtimeMs,
            byteSize: stamp.size,
          }),
        };
      }
      const pdfText = await convertPdfFallback(absPath);
      if (pdfText !== null) {
        await writeMdCache(absPath, pdfText, stamp).catch(() => {});
        return {
          ok: true,
          value: Object.freeze({
            id: docId,
            title: docId,
            path: absPath,
            content: pdfText,
            tokens: defaultEstimator.count(pdfText),
            isDocument: true,
            converted: true,
            mtimeMs: stamp.mtimeMs,
            byteSize: stamp.size,
          }),
        };
      }
    }
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'no-converter' }) };
  }
  try {
    const cached = await readMdCache(absPath);
    if (cached !== undefined) {
      return {
        ok: true,
        value: Object.freeze({
          id: docId,
          title: docId,
          path: absPath,
          content: cached,
          tokens: defaultEstimator.count(cached),
          isDocument: true,
          converted: false,
          mtimeMs: stamp.mtimeMs,
          byteSize: stamp.size,
        }),
      };
    }
    const markdown = await anydoc.toMarkdown(absPath);
    await writeMdCache(absPath, markdown, stamp);
    return {
      ok: true,
      value: Object.freeze({
        id: docId,
        title: docId,
        path: absPath,
        content: markdown,
        tokens: defaultEstimator.count(markdown),
        isDocument: true,
        converted: true,
        mtimeMs: stamp.mtimeMs,
        byteSize: stamp.size,
      }),
    };
  } catch (err: unknown) {
    return {
      ok: false,
      skipped: Object.freeze({ path: docId, reason: skipReasonFromError(err) }),
    };
  }
}

async function textToIngestedFile(
  absPath: string,
  relPath: string,
  idPrefix: string | undefined,
  maxBytes: number,
  fsImpl: HostFileSystem,
): Promise<FileIngestOutcome> {
  const docId = makeDocId(idPrefix, relPath);
  try {
    const s = await fsImpl.stat(absPath);
    if (s.size > maxBytes) {
      return { ok: false, skipped: Object.freeze({ path: docId, reason: 'oversized' }) };
    }
    if (fsImpl === DEFAULT_HOST_FS) {
      if (await isBinary(absPath)) {
        return { ok: false, skipped: Object.freeze({ path: docId, reason: 'binary' }) };
      }
    } else if (fsImpl.readBytes !== undefined) {
      const buf = await fsImpl.readBytes(absPath, 8192);
      if (buf.includes(0)) {
        return { ok: false, skipped: Object.freeze({ path: docId, reason: 'binary' }) };
      }
    }
    const content = await fsImpl.readFile(absPath, 'utf8');
    if (fsImpl !== DEFAULT_HOST_FS && fsImpl.readBytes === undefined && content.includes('\0')) {
      return { ok: false, skipped: Object.freeze({ path: docId, reason: 'binary' }) };
    }
    return {
      ok: true,
      value: Object.freeze({
        id: docId,
        title: docId,
        path: absPath,
        content,
        tokens: defaultEstimator.count(content),
        isDocument: false,
        converted: false,
        mtimeMs: s.mtimeMs,
        byteSize: s.size,
      }),
    };
  } catch {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'unreadable' }) };
  }
}

async function enumerateWithHostFs(
  rootAbs: string,
  fsImpl: HostFileSystem,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const readdirFn = fsImpl.readdir;
  if (readdirFn === undefined) return enumerateFiles(rootAbs, signal);
  const out: string[] = [];
  const walkDir = async (dirAbs: string, relDir: string): Promise<void> => {
    if (signal?.aborted) return;
    const entries = await readdirFn(dirAbs, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted) return;
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      const abs = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        await walkDir(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  await walkDir(rootAbs, '');
  out.sort();
  return out;
}

function expandHome(rawPath: string): string {
  if (rawPath === '~') return homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return join(homedir(), rawPath.slice(2));
  }
  return rawPath;
}

export async function resolveIngestSource(
  source: string,
  opts: IngestOptions = {},
): Promise<
  | { readonly ok: true; readonly value: IngestResult }
  | { readonly ok: false; readonly error: string }
> {
  const trimmed = source.trim();
  if (trimmed === '') {
    return { ok: false, error: 'add_document: empty path' };
  }
  const expanded = expandHome(trimmed);
  const baseCwd = opts.cwd ?? process.cwd();
  const absCwd = resolve(baseCwd);
  const fsImpl = opts.fs ?? DEFAULT_HOST_FS;
  let resolvedPath = isAbsolute(expanded) ? resolve(expanded) : resolve(absCwd, expanded);

  let s: HostFileStat;
  try {
    s = await fsImpl.stat(resolvedPath);
  } catch {
    if (!isAbsolute(expanded) && (expanded.startsWith('Users/') || expanded.startsWith('home/'))) {
      const rooted = resolve('/', expanded);
      try {
        s = await fsImpl.stat(rooted);
        resolvedPath = rooted;
      } catch {
        return { ok: false, error: `add_document: path not found: ${resolvedPath}` };
      }
    } else {
      return { ok: false, error: `add_document: path not found: ${resolvedPath}` };
    }
  }

  const sourceId =
    opts.idPrefix !== undefined
      ? opts.idPrefix === ''
        ? ''
        : sanitizeDocId(opts.idPrefix)
      : opts.cwd !== undefined
        ? resolvedPath === absCwd
          ? ''
          : isInsideRoot(resolvedPath, absCwd)
            ? sanitizeDocId(relative(absCwd, resolvedPath))
            : deriveSourceId(trimmed, resolvedPath)
        : deriveSourceId(trimmed, resolvedPath);

  if (s.isDirectory()) {
    const allPaths =
      opts.fs?.readdir !== undefined
        ? await enumerateWithHostFs(resolvedPath, fsImpl, opts.signal)
        : await enumerateFiles(resolvedPath, opts.signal);
    const maxFiles = opts.maxFiles !== undefined && opts.maxFiles > 0 ? opts.maxFiles : DEFAULT_MAX_WALK_FILES;
    const maxTotalChars =
      opts.maxTotalChars !== undefined && opts.maxTotalChars > 0 ? opts.maxTotalChars : DEFAULT_MAX_TOTAL_CHARS;
    const paths = allPaths.length > maxFiles ? allPaths.slice(0, maxFiles) : allPaths;
    const overflowPaths = allPaths.length > maxFiles ? allPaths.slice(maxFiles) : [];
    const anydoc = await getAnydoc();
    const limit = createLimiter(INGEST_CONCURRENCY);
    const maxWalkBytes = opts.maxWalkFileBytes ?? MAX_WALK_FILE_BYTES;
    const n = paths.length;
    const slots = new Array<IngestedFile | undefined>(n);
    const drops = new Array<SkippedFile | undefined>(n);
    let readChars = 0;

    await Promise.all(
      paths.map((rel, i) =>
        limit(async () => {
          const docPath = makeDocId(sourceId, rel);
          if (opts.signal?.aborted) {
            drops[i] = Object.freeze({ path: docPath, reason: 'aborted' });
            return;
          }
          if (readChars >= maxTotalChars) {
            drops[i] = Object.freeze({ path: docPath, reason: 'resourceLimit' });
            return;
          }
          if (isSensitivePath(rel)) {
            drops[i] = Object.freeze({ path: docPath, reason: 'sensitive' });
            return;
          }
          const abs = join(resolvedPath, rel);
          const safety =
            fsImpl === DEFAULT_HOST_FS
              ? await checkPathSafety(abs, resolvedPath)
              : { ok: true as const, realAbs: abs };
          if (!safety.ok) {
            drops[i] = Object.freeze({ path: docPath, reason: safety.reason });
            return;
          }
          const format = anydoc?.formatFromPath(rel) ?? documentExtFromPath(rel);
          if (format !== null) {
            if (opts.skipRichDocuments === true) {
              drops[i] = Object.freeze({ path: docPath, reason: 'unsupported' });
              return;
            }
            const docRes = await documentToIngestedFile(safety.realAbs, rel, sourceId, anydoc);
            if (docRes.ok) {
              readChars += docRes.value.content.length;
              slots[i] = docRes.value;
            } else {
              drops[i] = docRes.skipped;
            }
            return;
          }
          const textRes = await textToIngestedFile(safety.realAbs, rel, sourceId, maxWalkBytes, fsImpl);
          if (textRes.ok) {
            readChars += textRes.value.content.length;
            slots[i] = textRes.value;
          } else {
            drops[i] = textRes.skipped;
          }
        }),
      ),
    );

    const files = new Array<IngestedFile>(n);
    const skipped = new Array<SkippedFile>(Math.min(n + overflowPaths.length, MAX_SKIPPED_REPORTED));
    let fi = 0;
    let si = 0;
    let totalTokens = 0;
    let totalChars = 0;
    let documents = 0;
    let converted = 0;
    let budgetExceeded = false;

    for (let i = 0; i < n; i++) {
      const f = slots[i];
      if (f !== undefined) {
        if (budgetExceeded || totalChars + f.content.length > maxTotalChars) {
          budgetExceeded = true;
          if (si < MAX_SKIPPED_REPORTED) {
            skipped[si++] = Object.freeze({ path: f.id, reason: 'resourceLimit' });
          }
          continue;
        }
        files[fi++] = f;
        totalTokens += f.tokens;
        totalChars += f.content.length;
        if (f.isDocument) documents++;
        if (f.converted) converted++;
      } else {
        const d = drops[i];
        if (d !== undefined && si < MAX_SKIPPED_REPORTED) {
          skipped[si++] = d;
        }
      }
    }
    for (let i = 0; i < overflowPaths.length && si < MAX_SKIPPED_REPORTED; i++) {
      const rel = overflowPaths[i];
      if (rel !== undefined) {
        skipped[si++] = Object.freeze({ path: makeDocId(sourceId, rel), reason: 'oversized' });
      }
    }
    files.length = fi;
    skipped.length = si;

    return {
      ok: true,
      value: Object.freeze({
        source: trimmed,
        resolvedPath,
        sourceId,
        files: Object.freeze(files),
        totalTokens,
        totalChars,
        documents,
        converted,
        skipped: Object.freeze(skipped),
      }),
    };
  }

  // Single file
  let rel = basename(resolvedPath);
  if (opts.idPrefix === undefined && opts.cwd !== undefined && isInsideRoot(resolvedPath, absCwd)) {
    const relFromCwd = relative(absCwd, resolvedPath);
    if (relFromCwd !== '' && !relFromCwd.startsWith('..')) {
      rel = relFromCwd;
    }
  }
  if (isSensitivePath(rel) || isSensitivePath(trimmed.replace(/^\.\//, ''))) {
    return { ok: false, error: `add_document: refused sensitive path: ${resolvedPath}` };
  }
  const safety =
    fsImpl === DEFAULT_HOST_FS
      ? await checkPathSafety(resolvedPath, dirname(resolvedPath))
      : { ok: true as const, realAbs: resolvedPath };
  if (!safety.ok) {
    return {
      ok: false,
      error: `add_document: refused ${resolvedPath} (${safety.reason})`,
    };
  }

  const singlePrefix = opts.idPrefix ? sanitizeDocId(opts.idPrefix) : undefined;
  const anydoc = await getAnydoc();
  const format = anydoc?.formatFromPath(resolvedPath) ?? documentExtFromPath(resolvedPath);
  if (format !== null) {
    const docRes = await documentToIngestedFile(safety.realAbs, rel, singlePrefix, anydoc);
    if (!docRes.ok) {
      return {
        ok: false,
        error: `add_document: could not convert ${resolvedPath} (${docRes.skipped.reason})`,
      };
    }
    const f = docRes.value;
    return {
      ok: true,
      value: Object.freeze({
        source: trimmed,
        resolvedPath,
        sourceId: f.id,
        files: Object.freeze([f]),
        totalTokens: f.tokens,
        totalChars: f.content.length,
        documents: 1,
        converted: f.converted ? 1 : 0,
        skipped: Object.freeze([]),
      }),
    };
  }

  const textRes = await textToIngestedFile(
    safety.realAbs,
    rel,
    singlePrefix,
    MAX_SINGLE_FILE_BYTES,
    fsImpl,
  );
  if (!textRes.ok) {
    return {
      ok: false,
      error: `add_document: could not read ${resolvedPath} (${textRes.skipped.reason})`,
    };
  }
  const f = textRes.value;
  return {
    ok: true,
    value: Object.freeze({
      source: trimmed,
      resolvedPath,
      sourceId: f.id,
      files: Object.freeze([f]),
      totalTokens: f.tokens,
      totalChars: f.content.length,
      documents: 0,
      converted: 0,
      skipped: Object.freeze([]),
    }),
  };
}

const PROMPT_PATH_TOKEN_RE =
  /(?:~\/|\.\.?\/|\/)[\p{L}\p{N}_.\-/]+|[\p{L}\p{N}_.\-]+(?:\/[\p{L}\p{N}_.\-]+)+/gu;

const EXCLUDED_PROMPT_DIRS: ReadonlySet<string> = new Set([
  resolve(homedir()),
  resolve(homedir(), 'Downloads'),
  resolve(homedir(), 'Desktop'),
  resolve(homedir(), 'Documents'),
  '/tmp',
  '/var',
  '/Users',
  '/home',
]);

export function extractPromptPaths(text: string, cwd: string = process.cwd()): readonly string[] {
  if (!text) return Object.freeze([]);
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = text.match(PROMPT_PATH_TOKEN_RE);
  if (!matches) return Object.freeze([]);
  for (let i = 0; i < matches.length; i++) {
    const raw = matches[i];
    if (!raw) continue;
    const cleaned = raw.replace(/[.,;:!?)'"`\]}>]+$/, '');
    if (!cleaned || cleaned === '/' || cleaned === '.' || cleaned === '..') continue;
    if (/^[a-z]+:\/\//i.test(cleaned)) continue;
    const expanded = expandHome(cleaned);
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    if (seen.has(abs) || EXCLUDED_PROMPT_DIRS.has(abs)) continue;
    try {
      if (existsSync(abs)) {
        seen.add(abs);
        out.push(abs);
      }
    } catch {
      // Ignore inaccessible candidate paths.
    }
  }
  return Object.freeze(out);
}

/** Resolve multiple source paths in parallel while preserving deterministic input order. */
export async function resolveIngestSources(
  sources: readonly string[],
  opts: IngestOptions = {},
): Promise<
  ReadonlyArray<
    | { readonly source: string; readonly ok: true; readonly value: IngestResult }
    | { readonly source: string; readonly ok: false; readonly error: string }
  >
> {
  if (sources.length === 0) return Object.freeze([]);
  const limit = createLimiter(INGEST_CONCURRENCY);
  const out = new Array<
    | { readonly source: string; readonly ok: true; readonly value: IngestResult }
    | { readonly source: string; readonly ok: false; readonly error: string }
  >(sources.length);
  await Promise.all(
    sources.map((src, idx) =>
      limit(async () => {
        const res = await resolveIngestSource(src, opts);
        out[idx] = res.ok
          ? Object.freeze({ source: src, ok: true, value: res.value })
          : Object.freeze({ source: src, ok: false, error: res.error });
      }),
    ),
  );
  return Object.freeze(out);
}
