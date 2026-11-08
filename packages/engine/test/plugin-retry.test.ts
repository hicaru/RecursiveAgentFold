import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

type StreamChunk = Record<string, unknown>;
type Interceptor = (
  options: Record<string, unknown>,
  next: () => AsyncIterable<StreamChunk>,
) => AsyncIterable<StreamChunk>;

interface Harness {
  readonly interceptor: Interceptor;
  readonly calls: () => number;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function createHarness(sessionId: string, script: (call: number) => StreamChunk[]): Promise<Harness> {
  const profileDir = await mkdtemp(join(tmpdir(), 'raf-retry-test-'));
  const previousProfileDir = process.env.DSH_PROFILE_DIR;
  process.env.DSH_PROFILE_DIR = profileDir;
  cleanups.push(async () => {
    if (previousProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
    else process.env.DSH_PROFILE_DIR = previousProfileDir;
    await rm(profileDir, { recursive: true, force: true });
  });
  await mkdir(join(profileDir, 'raf-engine'), { recursive: true });
  await writeFile(
    join(profileDir, 'raf-engine', 'state.json'),
    JSON.stringify({
      version: 1,
      defaultEngine: 'raf',
      engines: { [sessionId]: 'raf' },
      settings: { depth: 2, reserve: 0.3, concurrency: 4 },
    }),
    'utf8',
  );

  let markReady: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let interceptor: Interceptor | undefined;
  let calls = 0;
  const agent = {
    id: sessionId,
    session: {
      id: sessionId,
      header: { cwd: profileDir },
      log: [{ type: 'turn/start', data: { turn: 1 } }],
      append: () => {},
    },
  };
  const ctx = {
    tools: {
      register(definition: { name?: string }) {
        if (definition.name === 'branch') markReady?.();
        return () => {};
      },
    },
    get(service: string) {
      if (service === 'agents') return { get: () => agent, list: () => [agent] };
      if (service === 'workingDirectory') return { get: () => profileDir };
      return undefined;
    },
    effect(fn: () => unknown) {
      fn();
    },
    on(event: string, handler: Interceptor) {
      if (event === 'llm/stream') interceptor = handler;
      return () => {};
    },
    inject() {},
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      async resolveModelInfo() {
        return {};
      },
      async *stream() {
        calls += 1;
        for (const chunk of script(calls)) yield chunk;
      },
    },
  };
  const plugin = (await import('../../dsh-plugin/index.js' as string)) as { apply: (scope: unknown) => void };
  plugin.apply(ctx);
  await ready;
  if (interceptor === undefined) throw new Error('plugin did not register an llm/stream interceptor');
  return { interceptor, calls: () => calls };
}

async function runStep(
  harness: Harness,
  sessionId: string,
): Promise<{ blocks: Array<Record<string, unknown>>; finish: unknown }> {
  const stream = harness.interceptor(
    {
      sessionId,
      provider: 'mock',
      model: 'mock-model',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          content: [{ type: 'text', text: 'Answer the question.' }],
          source: { kind: 'user' },
        },
      ],
    },
    () => {
      throw new Error('interceptor must not fall through');
    },
  );
  const blocks: Array<Record<string, unknown>> = [];
  let finish: unknown;
  for await (const chunk of stream) {
    if (chunk.type === 'block-end' && chunk.block !== null && typeof chunk.block === 'object') {
      blocks.push(chunk.block as Record<string, unknown>);
    } else if (chunk.type === 'finish') {
      finish = chunk.reason;
    }
  }
  return { blocks, finish };
}

describe('RAF LLM retry', () => {
  it('retries a transport failure and returns the successful answer', async () => {
    const sessionId = 'session-retry-ok';
    const harness = await createHarness(sessionId, (call) =>
      call === 1
        ? [
            { type: 'reasoning-delta', text: 'FAILED-REASONING' },
            {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: { message: 'DeepSeek Messages transport failed', code: 'TRANSPORT' },
              },
            },
          ]
        : [
            { type: 'reasoning-delta', text: 'GOOD-REASONING' },
            { type: 'text-delta', text: '<motivation>answer</motivation><answer>DONE</answer>' },
            { type: 'finish', reason: { kind: 'stop' } },
          ],
    );
    const { blocks, finish } = await runStep(harness, sessionId);
    expect(harness.calls()).toBe(2);
    expect(finish).toEqual({ kind: 'stop' });
    expect(blocks.some((block) => block.type === 'text' && block.text === 'DONE')).toBe(true);
    // The failed attempt's reasoning prefix must not leak into the final block.
    expect(blocks.find((block) => block.type === 'reasoning')?.text).toBe('GOOD-REASONING');
  });

  it('does not turn a non-retryable failure into an answer', async () => {
    const sessionId = 'session-retry-fail';
    const harness = await createHarness(sessionId, () => [
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'bad request', code: 'HTTP_400' } },
      },
    ]);
    const { blocks, finish } = await runStep(harness, sessionId);
    expect(harness.calls()).toBe(1);
    expect(blocks).toHaveLength(0);
    expect(finish).toEqual({ kind: 'error', failure: { message: 'bad request', code: 'ERROR' } });
  });
});
