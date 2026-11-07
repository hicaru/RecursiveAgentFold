/**
 * On-disk Markdown cache for anydoc conversions, keyed by pre-conversion (size, mtimeMs).
 * Cache dir: $XDG_CACHE_HOME/raf/anydoc (else ~/.cache/raf/anydoc).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface FileStamp {
  readonly size: number;
  readonly mtimeMs: number;
}

interface CacheStamp {
  readonly source: string;
  readonly size: number;
  readonly mtimeMs: number;
}

function cacheRoot(): string {
  const xdg = process.env['XDG_CACHE_HOME']?.trim();
  if (xdg && xdg.length > 0) return join(xdg, 'raf', 'anydoc');
  return join(homedir(), '.cache', 'raf', 'anydoc');
}

function entryBase(absPath: string): string {
  const name = basename(absPath).replace(/[^\w.-]+/g, '-').slice(0, 80) || 'doc';
  const sha8 = createHash('sha256').update(absPath).digest('hex').slice(0, 8);
  return `${name}-${sha8}`;
}

function isStamp(value: unknown): value is CacheStamp {
  if (value === null || typeof value !== 'object') return false;
  if (!('source' in value) || !('size' in value) || !('mtimeMs' in value)) return false;
  return (
    typeof value.source === 'string' &&
    typeof value.size === 'number' &&
    typeof value.mtimeMs === 'number'
  );
}

export async function captureStamp(absPath: string): Promise<FileStamp | undefined> {
  try {
    const s = await stat(absPath);
    return Object.freeze({ size: s.size, mtimeMs: s.mtimeMs });
  } catch {
    return undefined;
  }
}

export async function readMdCache(absPath: string): Promise<string | undefined> {
  try {
    const base = join(cacheRoot(), entryBase(absPath));
    const stampRaw = await readFile(`${base}.json`, 'utf-8');
    const stamp: unknown = JSON.parse(stampRaw);
    if (!isStamp(stamp)) return undefined;
    const s = await stat(absPath);
    if (s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs) return undefined;
    return await readFile(`${base}.md`, 'utf-8');
  } catch {
    return undefined;
  }
}

export async function writeMdCache(
  absPath: string,
  markdown: string,
  stamp: FileStamp,
): Promise<void> {
  try {
    const s = await stat(absPath);
    if (s.size !== stamp.size || s.mtimeMs !== stamp.mtimeMs) return;

    const root = cacheRoot();
    await mkdir(root, { recursive: true });
    const base = join(root, entryBase(absPath));
    await writeFile(`${base}.md`, markdown, 'utf-8');
    const out: CacheStamp = Object.freeze({
      source: absPath,
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
    });
    await writeFile(`${base}.json`, `${JSON.stringify(out)}\n`, 'utf-8');
  } catch {
    // Cache is an optimization only.
  }
}
