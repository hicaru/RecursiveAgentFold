/**
 * Safe directory enumeration and path validation.
 */

import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const BINARY_PROBE_BYTES = 8 * 1024;

export type SkipReason =
  | 'binary'
  | 'sensitive'
  | 'oversized'
  | 'unreadable'
  | 'no-converter'
  | 'aborted'
  | 'symlink-escape'
  | 'unsupported'
  | 'malformed'
  | 'encrypted'
  | 'needsOcr'
  | 'hosted'
  | 'resourceLimit'
  | 'missingPart'
  | 'io'
  | 'convert-failed';

export interface SkippedFile {
  readonly path: string;
  readonly reason: SkipReason;
}

export type PathSafety =
  | { readonly ok: true; readonly realAbs: string }
  | { readonly ok: false; readonly reason: 'sensitive' | 'symlink-escape' | 'unreadable' };

const FALLBACK_IGNORED: Readonly<Record<string, true>> = Object.freeze({
  node_modules: true,
  dist: true,
  build: true,
  out: true,
  target: true,
  coverage: true,
  '.next': true,
  '.nuxt': true,
  '.turbo': true,
  '.cache': true,
  __pycache__: true,
  '.venv': true,
  venv: true,
  vendor: true,
  results: true,
});

const DOT_DIR_ALLOWED: Readonly<Record<string, true>> = Object.freeze({ '.github': true });
const SENSITIVE_BASENAME: readonly RegExp[] = Object.freeze([
  /^\.env$/i,
  /^\.env\..+/i,
  /^id_rsa/i,
  /^id_dsa/i,
  /^id_ecdsa/i,
  /^id_ed25519/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^netrc$/i,
  /^\.git-credentials$/i,
]);

const SENSITIVE_DIR_SEGMENTS: Readonly<Record<string, true>> = Object.freeze({
  '.ssh': true,
  '.aws': true,
  '.gnupg': true,
  '.kube': true,
  '.docker': true,
});

export function isSensitivePath(relPath: string): boolean {
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg !== undefined && SENSITIVE_DIR_SEGMENTS[seg]) return true;
  }
  const base = basename(relPath);
  for (let i = 0; i < SENSITIVE_BASENAME.length; i++) {
    const rx = SENSITIVE_BASENAME[i];
    if (rx !== undefined && rx.test(base)) return true;
  }
  return false;
}

function absKey(path: string): string {
  const r = resolve(path);
  return r.length > 1 && (r.endsWith('/') || r.endsWith('\\')) ? r.slice(0, -1) : r;
}

export function isInsideRoot(fileAbs: string, rootAbs: string): boolean {
  const root = absKey(rootAbs);
  const file = absKey(fileAbs);
  if (file === root) return true;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return file.startsWith(prefix);
}

export async function checkPathSafety(absPath: string, packRoot: string): Promise<PathSafety> {
  try {
    const rootReal = await realpath(packRoot).catch(() => absKey(packRoot));
    const lst = await lstat(absPath);
    if (lst.isSymbolicLink()) {
      let realAbs: string;
      try {
        realAbs = await realpath(absPath);
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
      if (!isInsideRoot(realAbs, rootReal)) {
        return { ok: false, reason: 'symlink-escape' };
      }
      const relFromRoot = relative(rootReal, realAbs).split(sep).join('/');
      if (isSensitivePath(relFromRoot) || isSensitivePath(basename(realAbs))) {
        return { ok: false, reason: 'sensitive' };
      }
      return { ok: true, realAbs };
    }
    const realAbs = await realpath(absPath).catch(() => absKey(absPath));
    return { ok: true, realAbs };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

async function gitFiles(cwd: string, signal?: AbortSignal): Promise<readonly string[] | undefined> {
  try {
    const { stdout } = await execFileP('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
      cwd,
      signal,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    if (stdout.length === 0) return Object.freeze([]);
    const parts = stdout.toString('utf-8').split('\0');
    const out = new Array<string>(parts.length);
    let n = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (p !== undefined && p !== '') out[n++] = p;
    }
    out.length = n;
    return Object.freeze(out);
  } catch {
    return undefined;
  }
}

export async function walkFs(root: string, signal?: AbortSignal): Promise<readonly string[]> {
  const files: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (signal?.aborted) break;
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === '.' || name === '..') continue;
      const abs = join(dir, name);
      if (entry.isDirectory()) {
        if (FALLBACK_IGNORED[name]) continue;
        if (name.startsWith('.') && !DOT_DIR_ALLOWED[name]) continue;
        stack.push(abs);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rel = relative(root, abs).split(sep).join('/');
      if (rel !== '' && !rel.startsWith('..')) files.push(rel);
    }
  }
  return Object.freeze(files);
}

export async function isBinary(absPath: string): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(absPath, 'r');
    const buf = Buffer.allocUnsafe(BINARY_PROBE_BYTES);
    const { bytesRead } = await fh.read(buf, 0, BINARY_PROBE_BYTES, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

export async function enumerateFiles(
  root: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const fromGit = await gitFiles(root, signal);
  if (fromGit !== undefined) return fromGit;
  return await walkFs(root, signal);
}
