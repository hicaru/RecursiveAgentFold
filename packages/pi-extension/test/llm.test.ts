import { describe, expect, it, vi } from 'vitest';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import type { ChatMessage, LLMResponse } from '@raf/engine/source';
import {
  addUsage,
  applyCacheBreakpointsToPayload,
  emptyUsage,
  ModelClient,
  modelSpec,
  PrefetchedRootClient,
  reasoningOf,
  supportsExplicitCacheBlocks,
  toEngineResponse,
  toEngineUsage,
  toPiMessages,
} from '../src/llm.js';

const model = {
  id: 'glm-5.3',
  name: 'GLM 5.3',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: true,
  contextWindow: 200_000,
  maxTokens: 16_000,
} as const;

function assistant(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: 'stop',
    timestamp: 1_000,
    ...overrides,
  } as Parameters<typeof toEngineResponse>[0];
}

describe('llm mappers', () => {
  it('formats and resolves model specs', () => {
    expect(modelSpec(model as never)).toBe('zai-coding-cn/glm-5.3');
    expect(reasoningOf(undefined)).toBeUndefined();
    expect(reasoningOf('off')).toBeUndefined();
    expect(reasoningOf('high')).toBe('high');
  });

  it('maps pi usage to engine usage with cache included in prompt tokens', () => {
    const usage = toEngineUsage({
      input: 100,
      output: 50,
      cacheRead: 700,
      cacheWrite: 200,
      reasoning: 20,
      totalTokens: 1050,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    expect(usage).toEqual({ promptTokens: 1000, completionTokens: 50, cachedTokens: 700, reasoningTokens: 20 });
  });

  it('adds usage records including cost', () => {
    const a = addUsage(
      { ...emptyUsage(), input: 1, cost: { ...emptyUsage().cost, total: 0.25 } },
      { ...emptyUsage(), input: 2, output: 3, cost: { ...emptyUsage().cost, total: 0.5 } },
    );
    expect(a.input).toBe(3);
    expect(a.output).toBe(3);
    expect(a.cost.total).toBeCloseTo(0.75);
  });

  it('converts an assistant message to an engine response', () => {
    const response = toEngineResponse(
      assistant({
        content: [
          { type: 'thinking', thinking: 'inner thoughts' },
          { type: 'text', text: '<answer>42</answer>' },
        ],
        usage: { ...emptyUsage(), input: 10, output: 5 },
        stopReason: 'stop',
        durationMs: 1200,
      }),
    );
    expect(response.text).toBe('<answer>42</answer>');
    expect(response.reasoning).toBe('inner thoughts');
    expect(response.latencyMs).toBe(1200);
    expect(response.finishReason).toBe('stop');
    expect(response.usage.promptTokens).toBe(10);
  });

  it('re-encodes a native tool call as protocol text', () => {
    const response = toEngineResponse(
      assistant({
        content: [{ type: 'toolCall', id: 'call_1', name: 'grep', arguments: { pattern: 'key' } }],
        stopReason: 'toolUse',
      }),
    );
    expect(response.text).toContain('<tool_call>');
    expect(response.text).toContain('"name":"grep"');
    expect(response.finishReason).toBe('toolUse');
  });

  it('maps engine chat messages to a pi transcript', () => {
    const messages = toPiMessages(
      [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: 'Q' },
        { role: 'assistant', content: 'A' },
      ],
      model as never,
    );
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
    expect(messages[0]).toMatchObject({ role: 'system', content: 'SYS' });
    expect(messages[2]).toMatchObject({ role: 'assistant', model: 'glm-5.3' });
  });

  it('consumes a prefetched native response only for the exact messages', async () => {
    const usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    const liveResponse: LLMResponse = { text: 'live', model: 'live', latencyMs: 0, usage };
    const live = {
      profile: { name: 'live', contextWindow: 1000, maxOutputTokens: 100 },
      complete: vi.fn(async (): Promise<LLMResponse> => liveResponse),
    };
    const client = new PrefetchedRootClient(live as unknown as ModelClient);
    const messages: ChatMessage[] = [{ role: 'user', content: 'Q' }];
    const native: LLMResponse = { text: 'native', model: 'native', latencyMs: 1, usage };

    client.prefetch(messages, native);
    await expect(client.complete({ messages })).resolves.toBe(native);
    expect(live.complete).not.toHaveBeenCalled();

    client.prefetch(messages, native);
    const clonedFirst: ChatMessage = { role: 'user', content: 'Q' };
    await expect(client.complete({ messages: [clonedFirst] })).resolves.toBe(liveResponse);
    expect(live.complete).toHaveBeenCalledTimes(1);
  });

  it('surfaces the AbortSignal timeout reason instead of generic fetch abort strings', async () => {
    const controller = new AbortController();
    controller.abort(new Error('step timeout after 300000 ms'));
    const registry = {
      find: () => undefined,
      getAvailable: () => [],
      streamSimple: () => ({
        result: async () =>
          assistant({
            stopReason: 'aborted',
            errorMessage: 'This operation was aborted',
          }),
      }),
    } as unknown as ModelRegistry;
    const client = new ModelClient({
      registry,
      model: model as never,
      maxOutputTokens: 1024,
    });
    await expect(
      client.complete({
        messages: [{ role: 'user', content: 'Study scope' }],
        signal: controller.signal,
      }),
    ).rejects.toThrow('step timeout after 300000 ms');
  });

  it('detects compat.cacheControlFormat, emits 1-segment user block array, preserves ttl: 1h, and attaches images', () => {
    const compatModel = {
      id: 'custom-claude',
      name: 'Custom Claude',
      provider: 'custom-proxy',
      api: 'openai-completions',
      input: ['text', 'image'],
      compat: { cacheControlFormat: 'anthropic' },
      contextWindow: 200_000,
      maxTokens: 16_000,
    } as never;
    expect(supportsExplicitCacheBlocks(compatModel)).toBe(true);

    const anthropicModel = {
      id: 'claude-sonnet',
      name: 'Claude Sonnet',
      provider: 'anthropic',
      api: 'anthropic-messages',
      input: ['text', 'image'],
      contextWindow: 200_000,
      maxTokens: 16_000,
    } as never;
    const engineMsgs: ChatMessage[] = [
      { role: 'system', content: 'SYS', cacheBreakpoint: true },
      {
        role: 'user',
        content: 'ZONE1',
        segments: [{ text: 'ZONE1', cacheBreakpoint: true }],
        attachments: [{ kind: 'image', mimeType: 'image/png', data: 'QUJD' }],
      },
    ];
    const piMsgs = toPiMessages(engineMsgs, anthropicModel);
    expect(Array.isArray(piMsgs[1]?.content)).toBe(true);
    expect(piMsgs[1]?.content).toEqual([
      { type: 'text', text: 'ZONE1' },
      { type: 'image', data: 'QUJD', mimeType: 'image/png' },
    ]);

    const payload = {
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      tools: [{ name: 'read', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ZONE1' }] }],
    };
    applyCacheBreakpointsToPayload(payload, engineMsgs, anthropicModel);
    expect(payload.messages[0]?.content[0]).toEqual({
      type: 'text',
      text: 'ZONE1',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });
});
