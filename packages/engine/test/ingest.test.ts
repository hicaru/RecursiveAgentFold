import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ContextStore } from '../src/context/store.js';
import { DEFAULT_MAX_WALK_FILES, extractPromptPaths, MTIME_FRESHNESS_WINDOW_MS, type HostFileSystem } from '../src/context/ingest.js';
import { defaultEstimator } from '../src/tokens.js';
import { createGrepTool } from '../src/tools/document-tools.js';
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

describe('Step 3 store deduplication, Unicode prompt paths, line counts, grep, and token estimation', () => {
  it('deduplicates workspace absPath on grep path="." and avoids B4/B9 duplicates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raf-dedup-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src/server.ts'), 'export const PORT = 3000;\n', 'utf8');
      await writeFile(join(dir, 'src/other.ts'), 'export const OTHER = 1;\n', 'utf8');
      const store = new ContextStore();
      await store.addPath(dir, { cwd: dir, idPrefix: '' });
      const initialCount = store.list().length;
      expect(initialCount).toBe(2);

      // Adding same absPath with longer id preserves shorter canonical id
      store.add('export const PORT = 4000;\n', {
        id: 'nested/src/server.ts',
        absPath: join(dir, 'src/server.ts'),
      });
      expect(store.list().length).toBe(2);
      expect(store.has('src/server.ts')).toBe(true);
      expect(store.has('nested/src/server.ts')).toBe(false);
      expect(store.get('src/server.ts').lines).toEqual(['export const PORT = 4000;']);

      // grep with path="." resolves existing docs instead of re-ingesting with basename prefix
      const grepTool = createGrepTool({ ingest: { cwd: dir } });
      const out = await grepTool.execute(
        { pattern: 'const PORT', path: '.' },
        { store, usage: { record() {}, recordError() {} } as never, depth: 0, agentName: 'root', step: 0, emit: () => {} },
      );
      expect(store.list().length).toBe(2);
      expect(out).toContain('1 matching lines across 1 document(s)');
      expect(out).not.toContain('src/other.ts: 0');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('matches wc -l line count on trailing newline files, supports literal/glob/context grep, and clips long lines cleanly (B11, B14, B18)', async () => {
    const store = new ContextStore({ maxLineChars: 20 });
    const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    store.add(tenLines, { id: 'src/a.ts' });
    expect(store.get('src/a.ts').lines.length).toBe(10);
    store.add('alpha (x+y)\nbeta\ngamma\n', { id: 'src/b.ts' });
    store.add('alpha (x+y)\n', { id: 'fixtures/c.json' });
    store.add('x'.repeat(50) + ' needle ' + 'y'.repeat(50) + '\n', { id: 'src/long.ts' });

    expect(store.read('src/long.ts', 1, 1).text).toContain('[+88 chars]');

    const grepTool = createGrepTool();
    const out = await grepTool.execute(
      { pattern: '(x+y)', literal: true, glob: '*.ts', context: 1 },
      { store, usage: { record() {}, recordError() {} } as never, depth: 0, agentName: 'root', step: 0, emit: () => {} },
    );
    expect(out).toContain('1 matching lines across 1 document(s)');
    expect(out).toContain('src/b.ts:1| alpha (x+y)');
    expect(out).toContain('  src/b.ts:2: beta');
    expect(out).not.toContain('fixtures/c.json');

    const longGrep = store.grep('needle', { maxLineChars: 30 });
    expect(longGrep.matches[0]?.text).toContain('[+');
    expect(longGrep.matches[0]?.text).toContain('chars]');
  });

  it('bounds Unknown document error message, extracts Unicode prompt paths, and estimates Cyrillic tokens (B12, BUG-PI-05)', async () => {
    const store = new ContextStore();
    for (let i = 0; i < 60; i++) store.add('x', { id: `dir/file_${i}.ts` });
    let errMsg = '';
    try {
      store.get('file_5\n<tool_call>');
    } catch (e) {
      errMsg = (e as Error).message;
    }
    expect(errMsg.length).toBeLessThanOrEqual(600);
    expect(errMsg).toContain('newline or XML markup');
    expect(errMsg).toContain('60 documents total');
    expect(errMsg).toContain('file_5.ts');

    const dir = await mkdtemp(join(tmpdir(), 'raf-unicode-path-'));
    try {
      const pdfPath = join(dir, 'Самосбор_документ.pdf');
      await writeFile(pdfPath, 'dummy', 'utf8');
      const found = extractPromptPaths(`Please inspect ${pdfPath} and also check /tmp`, dir);
      expect(found).toContain(pdfPath);
      expect(found).not.toContain('/tmp');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    // Cyrillic token estimation (~1.8 chars/token)
    const ru = 'Абвгдежзиклмнопрстуфхцчшщъыьэюя'.repeat(10); // 310 chars
    expect(defaultEstimator.count(ru)).toBeGreaterThanOrEqual(150);

    // HostFileSystem seam & MTIME_FRESHNESS_WINDOW_MS
    expect(MTIME_FRESHNESS_WINDOW_MS).toBe(2_000);
    const mockFs: HostFileSystem = {
      async stat() {
        return { mtimeMs: 1000, size: 12, isFile: () => true, isDirectory: () => false };
      },
      async readFile() {
        return 'HOST_FS = 1\n';
      },
    };
    const fsStore = new ContextStore();
    await fsStore.addPath('/virtual/remote.ts', { fs: mockFs });
    expect(fsStore.get('remote.ts').lines).toEqual(['HOST_FS = 1']);
  });
});
