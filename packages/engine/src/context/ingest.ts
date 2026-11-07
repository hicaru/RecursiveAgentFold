/**
 * Multi-format file & directory ingestion into ContextStore documents.
 */

import { existsSync, type Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defaultEstimator } from '../tokens.js';
import { createLimiter } from '../util/concurrency.js';
import { documentExtFromPath, getAnydoc, type AnydocHandle } from './anydoc.js';
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
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
export const MAX_SKIPPED_REPORTED = 64;

const INGEST_CONCURRENCY = 8;

export interface IngestedFile {
  readonly id: string;
  readonly title: string;
  readonly path: string;
  readonly content: string;
  readonly tokens: number;
  readonly isDocument: boolean;
  readonly converted: boolean;
}

export interface IngestOptions {
  readonly cwd?: string;
  readonly idPrefix?: string;
  readonly signal?: AbortSignal;
  readonly maxWalkFileBytes?: number;
  readonly maxFiles?: number;
  readonly skipRichDocuments?: boolean;
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
    const cleaned = seg.replace(/[^A-Za-z0-9_.\-]+/g, '_').replace(/^_+|_+$/g, '');
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
  if (anydoc === null) {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'no-converter' }) };
  }
  const stamp = await captureStamp(absPath);
  if (stamp === undefined) {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'unreadable' }) };
  }
  if (stamp.size > MAX_DOCUMENT_BYTES) {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'oversized' }) };
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
): Promise<FileIngestOutcome> {
  const docId = makeDocId(idPrefix, relPath);
  try {
    const s = await stat(absPath);
    if (s.size > maxBytes) {
      return { ok: false, skipped: Object.freeze({ path: docId, reason: 'oversized' }) };
    }
    if (await isBinary(absPath)) {
      return { ok: false, skipped: Object.freeze({ path: docId, reason: 'binary' }) };
    }
    const content = await readFile(absPath, 'utf-8');
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
      }),
    };
  } catch {
    return { ok: false, skipped: Object.freeze({ path: docId, reason: 'unreadable' }) };
  }
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
  const resolvedPath = isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded);

  let s: Stats;
  try {
    s = await stat(resolvedPath);
  } catch {
    return { ok: false, error: `add_document: path not found: ${resolvedPath}` };
  }

  const sourceId =
    opts.idPrefix !== undefined
      ? opts.idPrefix === ''
        ? ''
        : sanitizeDocId(opts.idPrefix)
      : deriveSourceId(trimmed, resolvedPath);

  if (s.isDirectory()) {
    const allPaths = await enumerateFiles(resolvedPath, opts.signal);
    const maxFiles = opts.maxFiles !== undefined && opts.maxFiles > 0 ? opts.maxFiles : undefined;
    const paths = maxFiles !== undefined && allPaths.length > maxFiles ? allPaths.slice(0, maxFiles) : allPaths;
    const overflowPaths =
      maxFiles !== undefined && allPaths.length > maxFiles ? allPaths.slice(maxFiles) : [];
    const anydoc = await getAnydoc();
    const limit = createLimiter(INGEST_CONCURRENCY);
    const maxWalkBytes = opts.maxWalkFileBytes ?? MAX_WALK_FILE_BYTES;
    const n = paths.length;
    const slots = new Array<IngestedFile | undefined>(n);
    const drops = new Array<SkippedFile | undefined>(n);

    await Promise.all(
      paths.map((rel, i) =>
        limit(async () => {
          const docPath = makeDocId(sourceId, rel);
          if (opts.signal?.aborted) {
            drops[i] = Object.freeze({ path: docPath, reason: 'aborted' });
            return;
          }
          if (isSensitivePath(rel)) {
            drops[i] = Object.freeze({ path: docPath, reason: 'sensitive' });
            return;
          }
          const abs = join(resolvedPath, rel);
          const safety = await checkPathSafety(abs, resolvedPath);
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
              slots[i] = docRes.value;
            } else {
              drops[i] = docRes.skipped;
            }
            return;
          }
          const textRes = await textToIngestedFile(safety.realAbs, rel, sourceId, maxWalkBytes);
          if (textRes.ok) {
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

    for (let i = 0; i < n; i++) {
      const f = slots[i];
      if (f !== undefined) {
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
  if (opts.idPrefix === undefined && opts.cwd !== undefined && isInsideRoot(resolvedPath, baseCwd)) {
    const relFromCwd = relative(baseCwd, resolvedPath);
    if (relFromCwd !== '' && !relFromCwd.startsWith('..')) {
      rel = relFromCwd;
    }
  }
  if (isSensitivePath(rel) || isSensitivePath(trimmed.replace(/^\.\//, ''))) {
    return { ok: false, error: `add_document: refused sensitive path: ${resolvedPath}` };
  }
  const safety = await checkPathSafety(resolvedPath, dirname(resolvedPath));
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
  /(?:~\/|\.\.?\/|\/)[A-Za-z0-9_.\-/]+|[A-Za-z0-9_.\-]+(?:\/[A-Za-z0-9_.\-]+)+/g;

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
    if (seen.has(abs)) continue;
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
