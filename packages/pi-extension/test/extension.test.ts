import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionToolContext,
  ModelRegistry,
  Theme,
  ToolDefinition,
  ToolInfo,
} from '@earendil-works/pi-coding-agent';
import { createGrepToolDefinition, createReadToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import rafExtension from '../src/index.js';
import { emptyUsage, type ChatModel } from '../src/llm.js';
import type { AgentMessage } from '../src/pi-types.js';
import { ENTRY_MODE, ENTRY_RUN, ENTRY_STATE } from '../src/state.js';

const MODEL = Object.freeze({
  id: 'glm-5.3-flash',
  name: 'GLM 5.3 Flash',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: true,
  thinkingLevelMap: { max: 'max' },
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
}) as unknown as ChatModel;

const READER_MODEL = Object.freeze({
  id: 'glm-5.3',
  name: 'GLM 5.3',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
}) as unknown as ChatModel;

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raf-pi-ext-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Harness {
  readonly pi: ExtensionAPI;
  readonly ctx: ExtensionCommandContext;
  readonly tools: Map<string, ToolDefinition>;
  readonly getActiveTools: () => string[];
  readonly entries: Array<{ type: 'custom'; customType: string; data: unknown }>;
  readonly messages: AgentMessage[];
  readonly widgets: Map<string, { factory: unknown; options?: { placement?: string } }>;
  readonly getHeaderLines: () => string[] | undefined;
  readonly getWidgetLines: (key: string) => string[] | undefined;
  readonly emit: (eventName: string, event: Record<string, unknown>) => Promise<unknown>;
  readonly runCommand: (name: string, args: string) => Promise<void>;
  readonly runShortcut: (key: string) => Promise<void>;
}

function createHarness(cwd: string, configPath: string): Harness {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown>>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
  const shortcuts = new Map<string, { handler: (ctx: ExtensionContext) => Promise<void> }>();
  const entries: Array<{ type: 'custom'; customType: string; data: unknown }> = [];
  const messages: AgentMessage[] = [];
  const widgets = new Map<string, { factory: unknown; options?: { placement?: string } }>();
  let headerFactory: ((tui: TUI, theme: Theme) => { render(width: number): string[] }) | undefined;

  // Pre-seed native pi builtins (read, grep, bash).
  const builtinRead = createReadToolDefinition(cwd) as unknown as ToolDefinition;
  const builtinGrep = createGrepToolDefinition(cwd) as unknown as ToolDefinition;
  const builtinBash = {
    name: 'bash',
    label: 'bash',
    description: 'Execute shell commands',
    parameters: { type: 'object', properties: { command: { type: 'string' } } },
    execute: vi.fn(),
  } as unknown as ToolDefinition;
  tools.set('read', builtinRead);
  tools.set('grep', builtinGrep);
  tools.set('bash', builtinBash);
  let activeTools = ['read', 'grep', 'bash'];

  const catalog = [MODEL, READER_MODEL];
  const registry = {
    find: (provider: string, id: string) => catalog.find((m) => m.provider === provider && m.id === id),
    getAvailable: () => catalog,
    streamSimple: () => {
      throw new Error('Unexpected streamSimple call');
    },
  } as unknown as ModelRegistry;

  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const ctx = {
    cwd,
    hasUI: true,
    mode: 'tui',
    model: MODEL,
    thinkingLevel: 'max',
    scopedModels: [],
    modelRegistry: registry,
    sessionManager: {
      getBranch: () => entries,
      getSessionId: () => 'sess_ext',
      buildSessionProjection: () => ({ messages }),
    },
    ui: {
      notify: vi.fn(),
      setHeader: vi.fn((factory: typeof headerFactory) => {
        headerFactory = factory;
      }),
      setWidget: vi.fn((key: string, value: unknown, options?: { placement?: string }) => {
        if (value === undefined) widgets.delete(key);
        else widgets.set(key, { factory: value, ...(options !== undefined ? { options } : {}) });
      }),
    },
  } as unknown as ExtensionCommandContext;

  const pi = {
    on(event: string, handler: (ev: unknown, c: ExtensionContext) => Promise<unknown> | unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(next: string[]) {
      activeTools = [...next];
    },
    getAllTools(): ToolInfo[] {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        exposure: tool.exposure ?? 'direct',
        sourceInfo: { path: tool.name, source: 'extension', scope: 'user', origin: 'top-level' },
      }));
    },
    appendEntry(customType: string, data?: unknown) {
      entries.push({ type: 'custom', customType, data });
    },
    registerMarkdownTransformer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerCommand(name: string, def: { handler: (args: string, c: ExtensionCommandContext) => Promise<void> }) {
      commands.set(name, def);
    },
    registerShortcut(key: string, def: { handler: (c: ExtensionContext) => Promise<void> }) {
      shortcuts.set(key, def);
    },
  } as unknown as ExtensionAPI;

  rafExtension(pi, { configPath });

  return {
    pi,
    ctx,
    tools,
    getActiveTools: () => [...activeTools],
    entries,
    messages,
    widgets,
    getHeaderLines: () => headerFactory?.(tui, plainTheme).render(200),
    getWidgetLines: (key: string) => {
      const entry = widgets.get(key);
      const factory = entry?.factory as ((t: TUI, th: Theme) => { render(width: number): string[]; dispose?: () => void }) | undefined;
      if (factory === undefined) return undefined;
      const inst = factory(tui, plainTheme);
      const lines = inst.render(200);
      inst.dispose?.();
      return lines;
    },
    async emit(eventName: string, event: Record<string, unknown>) {
      let last: unknown;
      for (const handler of handlers.get(eventName) ?? []) {
        last = await handler(event, ctx);
      }
      return last;
    },
    async runCommand(name: string, args: string) {
      const cmd = commands.get(name);
      if (cmd === undefined) throw new Error(`Missing command ${name}`);
      await cmd.handler(args, ctx);
    },
    async runShortcut(key: string) {
      const sc = shortcuts.get(key);
      if (sc === undefined) throw new Error(`Missing shortcut ${key}`);
      await sc.handler(ctx);
    },
  };
}

describe('rafExtension integration', () => {
  it('renders the clean 4-line header, never mounts RAF ○ idle, and restores native read/grep when toggled off', async () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, 'notes.txt'), 'line one\nneedle-token\nline three\n', 'utf8');
    const configPath = join(cwd, 'raf.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        enabledByDefault: true,
        readerModel: 'zai-coding-cn/glm-5.3',
      }),
      'utf8',
    );

    const harness = createHarness(cwd, configPath);
    await harness.emit('session_start', { type: 'session_start' });

    // Top-of-scrollback header is never used; RAF card is mounted aboveEditor!
    expect(harness.getHeaderLines()).toBeUndefined();
    expect(harness.widgets.get('raf-live')?.options?.placement).toBe('aboveEditor');
    expect(harness.getWidgetLines('raf-live')).toEqual([
      'RAF ctr+sh+S',
      '    ◉ glm-5.3-flash:max /model',
      '    ⑂ glm-5.3-flash:max /raf',
      '    ⟂ glm-5.3',
    ]);

    // `RAF ○ idle` (`raf-stats`) widget is never registered.
    expect(harness.widgets.has('raf-stats')).toBe(false);

    // RAF tools are active, branch declares `reachesTools: () => "all"`, and prepareArguments normalizes any format.
    expect(harness.getActiveTools()).toContain('branch');
    expect(harness.getActiveTools()).toContain('llm_query');
    expect(harness.tools.get('branch')?.reachesTools?.({})).toBe('all');
    expect(
      harness.tools.get('branch')?.prepareArguments?.(
        '[[tasks]]\nscope = "packages/engine"\ntask = "Audit engine"\n[[tasks]]\nscope = "packages/pi-extension"\ntask = "Audit UI"',
      ),
    ).toEqual({
      tasks: [
        { scope: 'packages/engine', task: 'Audit engine' },
        { scope: 'packages/pi-extension', task: 'Audit UI' },
      ],
    });

    // Outside a turn while RAF is enabled, `read` still works with RAF aliases (`document`, `start_line`, `end_line`).
    const toolCtx = { ...harness.ctx, tools: [], executeTool: vi.fn() } as unknown as ExtensionToolContext;
    const fallbackRead = await harness.tools.get('read')?.execute(
      'tc_fallback',
      { document: 'notes.txt', start_line: 2, end_line: 2 } as never,
      undefined,
      undefined,
      toolCtx,
    );
    const fallbackText = fallbackRead?.content[0]?.type === 'text' ? fallbackRead.content[0].text : '';
    expect(fallbackText).toContain('needle-token');

    // Toggle RAF off via ctrl+shift+r -> aboveEditor widget clears, RAF-only tools deactivate, native pi `read` & `grep` are restored!
    await harness.runShortcut('ctrl+shift+r');
    expect(harness.getHeaderLines()).toBeUndefined();
    expect(harness.widgets.has('raf-live')).toBe(false);
    expect(harness.getActiveTools()).toEqual(['read', 'grep', 'bash']);
    expect(harness.entries.some((e) => e.customType === ENTRY_MODE)).toBe(true);

    const nativeRead = await harness.tools.get('read')?.execute(
      'tc_native',
      { path: 'notes.txt' } as never,
      undefined,
      undefined,
      toolCtx,
    );
    const nativeText = nativeRead?.content[0]?.type === 'text' ? nativeRead.content[0].text : '';
    expect(nativeText).toContain('needle-token');
  });

  it('drives a complete pi turn lifecycle and persists raf-state and raf-run entries', async () => {
    const cwd = createTempDir();
    writeFileSync(join(cwd, 'service.ts'), 'export const PORT = 8080;\n', 'utf8');
    const configPath = join(cwd, 'raf.json');
    const harness = createHarness(cwd, configPath);

    await harness.emit('session_start', { type: 'session_start' });
    await harness.runCommand('raf', 'on');

    const userMsg: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'What port does service.ts export?' }],
      timestamp: Date.now(),
    };
    harness.messages.push(userMsg);

    await harness.emit('before_agent_start', {
      type: 'before_agent_start',
      messageType: 'user',
      prompt: 'What port does service.ts export?',
    });
    expect(harness.widgets.has('raf-live')).toBe(true);

    const step0Ctx = (await harness.emit('context_with_system', {
      type: 'context_with_system',
      messages: [...harness.messages],
    })) as { messages: unknown[] } | undefined;
    expect(step0Ctx?.messages.length).toBeGreaterThanOrEqual(2);

    // Step 0 assistant response -> tool call `grep`
    const rawStep0: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<motivation>Check PORT in service.ts.</motivation><tool_call>{"name":"grep","arguments":{"pattern":"PORT"}}</tool_call>',
        },
      ],
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const end0 = (await harness.emit('message_end', {
      type: 'message_end',
      message: rawStep0,
    })) as { message: AssistantMessage } | undefined;
    expect(end0?.message.stopReason).toBe('toolUse');
    if (end0 === undefined) return;
    harness.messages.push(end0.message);

    const callBlock = end0.message.content.find((b) => b.type === 'toolCall');
    expect(callBlock?.type).toBe('toolCall');
    if (callBlock === undefined || callBlock.type !== 'toolCall') return;

    const toolCtx = { ...harness.ctx, tools: [], executeTool: vi.fn() } as unknown as ExtensionToolContext;
    const grepOutcome = await harness.tools.get('grep')?.execute(
      callBlock.id,
      callBlock.arguments as never,
      undefined,
      undefined,
      toolCtx,
    );
    expect(grepOutcome).toBeDefined();
    if (grepOutcome === undefined) return;
    harness.messages.push({
      role: 'toolResult',
      toolCallId: callBlock.id,
      toolName: 'grep',
      content: grepOutcome.content,
      isError: false,
      timestamp: Date.now(),
    });

    // Step 1 request + final answer
    await harness.emit('context_with_system', {
      type: 'context_with_system',
      messages: [...harness.messages],
    });
    const rawStep1: AssistantMessage = {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '<folding range="0-0">service.ts exports PORT = 8080.</folding><motivation>Answer with exact port.</motivation><answer>8080</answer>',
        },
      ],
      api: MODEL.api,
      provider: MODEL.provider,
      model: MODEL.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    const end1 = (await harness.emit('message_end', {
      type: 'message_end',
      message: rawStep1,
    })) as { message: AssistantMessage } | undefined;
    expect(end1?.message.stopReason).toBe('stop');
    expect(harness.widgets.has('raf-live')).toBe(true);

    expect(harness.entries.some((e) => e.customType === ENTRY_STATE)).toBe(true);
    expect(harness.entries.some((e) => e.customType === ENTRY_RUN)).toBe(true);

    // Navigate `/tree` (`session_tree`) and verify state restores cleanly without errors.
    await harness.emit('session_tree', { type: 'session_tree' });
    expect(harness.getWidgetLines('raf-live')?.[0]).toContain('RAF ctr+sh+S');
  });
});
