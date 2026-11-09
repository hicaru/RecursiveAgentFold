import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleClient } from '../src/llm/openai-compatible.js';
import { RateLimitCoordinator } from '../src/llm/rate-limit-gate.js';

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

  it('turns a non-retryable failure into a saved fallback report', async () => {
    const sessionId = 'session-retry-fail';
    const harness = await createHarness(sessionId, () => [
      {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'bad request', code: 'HTTP_400' } },
      },
    ]);
    const { blocks, finish } = await runStep(harness, sessionId);
    expect(harness.calls()).toBe(1);
    expect(finish).toEqual({ kind: 'stop' });
    const text = blocks.find((block) => block.type === 'text')?.text;
    expect(typeof text).toBe('string');
    expect(text).toContain('bad request');
  });

  it('queues 12 parallel specialists through 10 consecutive 429/1302 rate-limit responses without dropping any task, and only terminates a solo agent after maxSoloRetries', async () => {
    const gate = new RateLimitCoordinator({
      baseDelayMs: 5,
      maxDelayMs: 25,
      staggerMs: 2,
      maxSoloRetries: 8,
    });
    let rateLimitsRemaining = 10;
    const wakeTimes: number[] = [];
    const client = new OpenAICompatibleClient({
      baseUrl: 'https://mock.provider/v1',
      apiKey: 'test-key',
      model: 'mock-model',
      contextWindow: 128_000,
      maxOutputTokens: 512,
      rateLimitGate: gate,
      fetchImpl: async () => {
        wakeTimes.push(Date.now());
        if (rateLimitsRemaining > 0) {
          rateLimitsRemaining -= 1;
          return new Response(
            JSON.stringify({
              error: {
                code: '1302',
                message: '您的账户已达到速率限制，请您控制请求频率',
              },
            }),
            { status: 429, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            model: 'mock-model',
            choices: [{ message: { content: '<answer>REPORT_OK</answer>' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, idx) => {
        const leave = gate.enterWorker();
        try {
          const res = await client.complete({
            messages: [{ role: 'user', content: `specialist ${idx + 1}` }],
          });
          return res.text;
        } finally {
          leave();
        }
      }),
    );
    expect(results).toHaveLength(12);
    expect(results.every((text) => text === '<answer>REPORT_OK</answer>')).toBe(true);
    expect(gate.activeWorkers).toBe(0);
    expect(gate.inFlight).toBe(0);

    // Now simulate a single solo agent (activeWorkers === 1) hitting 8 consecutive 429/1302 errors
    const soloGate = new RateLimitCoordinator({
      baseDelayMs: 2,
      maxDelayMs: 8,
      staggerMs: 1,
      maxSoloRetries: 8,
    });
    let soloCalls = 0;
    const soloClient = new OpenAICompatibleClient({
      baseUrl: 'https://mock.provider/v1',
      apiKey: 'test-key',
      model: 'mock-model',
      contextWindow: 128_000,
      maxOutputTokens: 512,
      rateLimitGate: soloGate,
      fetchImpl: async () => {
        soloCalls += 1;
        return new Response(
          JSON.stringify({
            error: {
              code: '1302',
              message: '您的账户已达到速率限制，请您控制请求频率',
            },
          }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const leaveSolo = soloGate.enterWorker();
    try {
      await expect(
        soloClient.complete({ messages: [{ role: 'user', content: 'solo request' }] }),
      ).rejects.toThrow(/RATE_LIMIT_EXHAUSTED/);
      expect(soloCalls).toBe(8);
    } finally {
      leaveSolo();
    }
  });
});
