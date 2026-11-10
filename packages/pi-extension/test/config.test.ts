import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configEquals, DEFAULT_CONFIG, loadConfig, sanitizeConfig, saveConfig } from '../src/config.js';

describe('config', () => {
  it('fills defaults for garbage input', () => {
    expect(sanitizeConfig(undefined)).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig('nope')).toEqual(DEFAULT_CONFIG);
    expect(sanitizeConfig({ depth: 'x', reserve: null })).toEqual(DEFAULT_CONFIG);
  });

  it('clamps numeric ranges and snaps reserve to steps', () => {
    const c = sanitizeConfig({ depth: 9, reserve: 0.33, concurrency: 99 });
    expect(c.depth).toBe(3);
    expect(c.reserve).toBeCloseTo(0.35);
    expect(c.concurrency).toBe(8);
    const low = sanitizeConfig({ depth: 0, reserve: 0.01, concurrency: 0 });
    expect(low.depth).toBe(1);
    expect(low.reserve).toBeCloseTo(0.1);
    expect(low.concurrency).toBe(1);
  });

  it('accepts only provider/id model specs and valid thinking levels', () => {
    const c = sanitizeConfig({ branchModel: 'zai-coding-cn/glm-5.3-flash', readerModel: 'nonsense', branchThinking: 'high' });
    expect(c.branchModel).toBe('zai-coding-cn/glm-5.3-flash');
    expect(c.readerModel).toBe('');
    expect(c.branchThinking).toBe('high');
    expect(sanitizeConfig({ branchThinking: 'ultra' }).branchThinking).toBe('inherit');
    expect(sanitizeConfig({ branchThinking: 'off' }).branchThinking).toBe('off');
  });

  it('round-trips through the config file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'raf-pi-'));
    const path = join(dir, 'raf.json');
    const wanted = sanitizeConfig({ depth: 3, branchModel: 'a/b', deepStudy: true, indexWorkspace: false });
    expect(saveConfig(path, wanted).ok).toBe(true);
    const loaded = loadConfig(path);
    expect(loaded).toEqual(wanted);
    expect(configEquals(loaded, wanted)).toBe(true);
    expect(configEquals(loaded, { ...wanted, depth: 1 })).toBe(false);
    await writeFile(path, '{broken', 'utf8');
    expect(loadConfig(path)).toEqual(DEFAULT_CONFIG);
    await rm(dir, { recursive: true, force: true });
  });
});
