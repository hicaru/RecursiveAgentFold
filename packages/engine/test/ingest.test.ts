import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/context/store.js';
import { DEFAULT_MAX_WALK_FILES } from '../src/context/ingest.js';

async function tempFiles(count: number, body = 'x'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'raf-ingest-'));
  await Promise.all(
    Array.from({ length: count }, (_value, index) =>
      writeFile(join(dir, `f${String(index).padStart(5, '0')}.txt`), body),
    ),
  );
  return dir;
}

describe('directory ingest limits', () => {
  it('caps a directory without an explicit maxFiles', async () => {
    const dir = await tempFiles(DEFAULT_MAX_WALK_FILES + 1);
    try {
      const store = new ContextStore();
      const result = await store.addPath(dir);
      expect(result.files).toHaveLength(DEFAULT_MAX_WALK_FILES);
      expect(result.skipped[0]?.reason).toBe('oversized');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stops reading files after the total character budget', async () => {
    const dir = await tempFiles(3, 'abc');
    try {
      const store = new ContextStore();
      const result = await store.addPath(dir, { maxTotalChars: 4 });
      expect(result.files).toHaveLength(1);
      expect(result.skipped.some((skipped) => skipped.reason === 'resourceLimit')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
