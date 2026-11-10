import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, Usage } from '@earendil-works/pi-ai';
import type { ExtensionContext, ExtensionToolContext, ModelRegistry, ToolInfo } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CONFIG, sanitizeConfig } from '../src/config.js';
import { emptyUsage, type ChatModel } from '../src/llm.js';
import type { AgentMessage } from '../src/pi-types.js';
import { resolveRoutes } from '../src/routes.js';
import { SessionState } from '../src/state.js';
import { RunTracker } from '../src/tracker.js';
import { bridgeableTools, RafTurn } from '../src/turn.js';

const ROOT_MODEL = Object.freeze({
  id: 'glm-5.3-flash',
  name: 'GLM 5.3 Flash',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
}) as unknown as ChatModel;

const BRANCH_MODEL = Object.freeze({
  id: 'glm-5.3-branch',
  name: 'GLM 5.3 Branch',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 16_000,
}) as unknown as ChatModel;

const READER_MODEL = Object.freeze({
  id: 'glm-5.3-reader',
  name: 'GLM 5.3 Reader',
  provider: 'zai-coding-cn',
  api: 'openai-completions',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
}) as unknown as ChatModel;

function makeUsage(input: number, output: number, totalCost: number, cacheRead = 0): Usage {
  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: input + output + cacheRead,
    cost: { input: totalCost / 2, output: totalCost / 2, cacheRead: 0, cacheWrite: 0, total: totalCost },
  };
}

function makeAssistant(model: ChatModel, text: string, usage = makeUsage(100, 40, 0.01, 60)): AssistantMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

function makeToolInfo(name: string, parameters: Record<string, unknown>, exposure: ToolInfo['exposure'] = 'direct'): ToolInfo {
  return {
    name,
    description: `Native ${name} tool`,
    parameters: parameters as unknown as ToolInfo['parameters'],
    exposure,
    sourceInfo: { path: name, source: 'extension', scope: 'user', origin: 'top-level' },
  };
}

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raf-pi-turn-'));
  tempDirs.push(dir);
  writeFileSync(
    join(dir, 'alpha.ts'),
    [
      'export const SECRET_CODE = "ZEBRA-42";',
      'export function computeAlpha(): number {',
      '  return 42;',
      '}',
    ].join('\n'),
    'utf8',
  );
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface ScriptedRegistry {
  readonly registry: ModelRegistry;
  readonly callsByModel: ReadonlyMap<string, number>;
}

function createScriptedRegistry(
  scripts: Readonly<Record<string, Array<() => AssistantMessage>>>,
): ScriptedRegistry {
  const catalog = [ROOT_MODEL, BRANCH_MODEL, READER_MODEL];
  const counts = new Map<string, number>();
  const queues = new Map<string, Array<() => AssistantMessage>>(
    Object.entries(scripts).map(([id, items]) => [id, [...items]]),
  );

  const registry = {
    find(provider: string, id: string) {
      return catalog.find((m) => m.provider === provider && m.id === id);
    },
    getAvailable() {
      return catalog;
    },
    streamSimple(model: ChatModel) {
      counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
      const queue = queues.get(model.id);
      const next = queue?.shift();
      if (next === undefined) {
        throw new Error(`Unexpected LLM call for model ${model.id}`);
      }
      const msg = next();
      return {
        result: () => Promise.resolve(msg),
      };
    },
  } as unknown as ModelRegistry;

  return { registry, callsByModel: counts };
}

function createExtensionContext(cwd: string, registry: ModelRegistry): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: 'print',
    model: ROOT_MODEL,
    thinkingLevel: 'max',
    scopedModels: [],
    modelRegistry: registry,
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => 'sess_test',
      buildSessionProjection: () => ({ messages: [] }),
    },
    ui: {
      notify: vi.fn(),
      setHeader: vi.fn(),
      setWidget: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

describe('RafTurn end-to-end', () => {
  it('executes a multi-step root turn with zero duplicate root LLM calls and immutable system prefix', async () => {
    const cwd = createWorkspace();
    const { registry, callsByModel } = createScriptedRegistry({});
    const ctx = createExtensionContext(cwd, registry);
    const config = sanitizeConfig({
      ...DEFAULT_CONFIG,
      branchModel: 'zai-coding-cn/glm-5.3-branch',
      readerModel: 'zai-coding-cn/glm-5.3-reader',
    });
    const routes = resolveRoutes(ctx, config);
    expect(routes).toBeDefined();
    if (routes === undefined) return;

    const session = new SessionState();
    const tracker = new RunTracker();
    const turn = await RafTurn.create({
      ctx,
      config,
      routes,
      session,
      tracker,
      prompt: 'What is SECRET_CODE in alpha.ts?',
      nativeTools: [],
      history: [],
    });

    const step0Messages = turn.prepareRequest([]);
    const step0System = step0Messages[0];

    const nativeStep0 = makeAssistant(
      ROOT_MODEL,
      '<motivation>Search for SECRET_CODE in the workspace store.</motivation><tool_call>{"name":"grep","arguments":{"pattern":"SECRET_CODE"}}</tool_call>',
      makeUsage(200, 30, 0.02, 150),
    );
    const out0 = await turn.acceptResponse(nativeStep0, undefined);
    expect(out0?.kind).toBe('tool');
    if (out0 === undefined || out0.kind !== 'tool') return;

    const toolCallBlock = out0.replacement.content.find((b) => b.type === 'toolCall');
    expect(toolCallBlock).toBeDefined();
    if (toolCallBlock === undefined || toolCallBlock.type !== 'toolCall') return;
    expect(toolCallBlock.name).toBe('grep');

    const toolCtx = {
      ...ctx,
      tools: [],
      executeTool: vi.fn(),
    } as unknown as ExtensionToolContext;
    const grepResult = await turn.executeTool('grep', toolCallBlock.arguments, toolCallBlock.id, undefined, undefined, toolCtx);
    const grepText = grepResult.content[0]?.type === 'text' ? grepResult.content[0].text : '';
    expect(grepText).toContain('ZEBRA-42');

    const transcriptAfterTool: AgentMessage[] = [
      out0.replacement,
      {
        role: 'toolResult',
        toolCallId: toolCallBlock.id,
        toolName: 'grep',
        content: grepResult.content,
        isError: false,
        timestamp: Date.now(),
      },
    ];
    const step1Messages = turn.prepareRequest(transcriptAfterTool);
    expect((step1Messages[0] as { content?: unknown } | undefined)?.content).toBe(
      (step0System as { content?: unknown } | undefined)?.content,
    );

    const nativeStep1 = makeAssistant(
      ROOT_MODEL,
      '<folding range="0-0">Found SECRET_CODE = ZEBRA-42 in alpha.ts:1.</folding><motivation>Provide exact answer.</motivation><answer>ZEBRA-42</answer>',
      makeUsage(220, 25, 0.02, 190),
    );
    const out1 = await turn.acceptResponse(nativeStep1, undefined);
    expect(out1?.kind).toBe('final');
    if (out1 === undefined || out1.kind !== 'final') return;
    expect(out1.status).toBe('done');
    expect(out1.result.answer).toBe('ZEBRA-42');

    // PrefetchedRootClient served both root steps without re-calling rootLLM.
    expect(callsByModel.get(ROOT_MODEL.id) ?? 0).toBe(0);
    turn.finish('done');
  });

  it('repairs malformed root protocol output via live root retry and sums usage', async () => {
    const cwd = createWorkspace();
    const { registry, callsByModel } = createScriptedRegistry({
      [ROOT_MODEL.id]: [
        () =>
          makeAssistant(
            ROOT_MODEL,
            '<motivation>Now answering cleanly.</motivation><answer>Repaired 42</answer>',
            makeUsage(120, 20, 0.03, 100),
          ),
      ],
    });
    const ctx = createExtensionContext(cwd, registry);
    const routes = resolveRoutes(ctx, DEFAULT_CONFIG);
    expect(routes).toBeDefined();
    if (routes === undefined) return;

    const turn = await RafTurn.create({
      ctx,
      config: DEFAULT_CONFIG,
      routes,
      session: new SessionState(),
      tracker: new RunTracker(),
      prompt: 'Compute alpha',
      nativeTools: [],
      history: [],
    });

    turn.prepareRequest([]);
    const malformed = makeAssistant(ROOT_MODEL, 'plain text with no protocol tags at all', makeUsage(100, 15, 0.02, 0));
    const outcome = await turn.acceptResponse(malformed, undefined);
    expect(outcome?.kind).toBe('final');
    if (outcome === undefined || outcome.kind !== 'final') return;

    expect(callsByModel.get(ROOT_MODEL.id)).toBe(1);
    expect(outcome.result.answer).toBe('Repaired 42');
    expect(outcome.replacement.usage.input).toBe(220);
    expect(outcome.replacement.usage.cost.total).toBeCloseTo(0.05);
    turn.finish('done');
  });

  it('supports recursive branch subagents calling nested branch, llm_query, ContextStore tools, and pi APIs with usage accounting', async () => {
    const cwd = createWorkspace();
    const largeWebPayload = Array.from(
      { length: 180 },
      (_, idx) => `Line ${idx + 1}: Deep research finding #${idx + 1} — OMEGA_FACT_${idx === 95 ? '999' : idx}`,
    ).join('\n');
    expect(largeWebPayload.length).toBeGreaterThan(6000);

    const { registry, callsByModel } = createScriptedRegistry({
      [BRANCH_MODEL.id]: [
        // Depth-1 specialist step 0: call pi's google_search tool
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<motivation>Run web research via google_search.</motivation><tool_call>{"name":"google_search","arguments":{"query":"omega protocol spec","max_matches":"5"}}</tool_call>',
            makeUsage(300, 45, 0.04, 200),
          ),
        // Depth-1 specialist step 1: delegate verification to depth-2 subagent
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<folding range="0-0">Indexed google_search output as tool_google_search_1.</folding><motivation>Spawn depth-2 verifier for exact OMEGA_FACT and MCP docs check.</motivation><tool_call>{"name":"branch","arguments":{"tasks":[{"scope":"tool_google_search_1","task":"Verify OMEGA_FACT_999 and check mcp__docs__lookup."}]}}</tool_call>',
            makeUsage(340, 55, 0.05, 260),
          ),
        // Depth-2 specialist step 0: call MCP tool with XML-style stringified args + ContextStore search
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<motivation>Call mcp__docs__lookup to confirm spec version.</motivation><tool_call><name>mcp__docs__lookup</name><topic>omega</topic><limit>3</limit><strict>true</strict></tool_call>',
            makeUsage(210, 35, 0.03, 140),
          ),
        // Depth-2 specialist step 1: scan indexed google_search doc with llm_query
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<folding range="0-0">MCP docs confirmed v2.4.</folding><motivation>Run llm_query on tool_google_search_1.</motivation><tool_call>{"name":"llm_query","arguments":{"query":"Extract OMEGA_FACT_999","documents":["tool_google_search_1"],"mode":"extract"}}</tool_call>',
            makeUsage(230, 40, 0.03, 180),
          ),
        // Depth-2 specialist step 2: return specialist report
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<folding range="1-1">Extracted OMEGA_FACT_999 from line 96.</folding><motivation>Complete depth-2 report.</motivation><answer>### Findings\n- Verified `OMEGA_FACT_999` at `tool_google_search_1` line 96 via `llm_query`.\n- Confirmed Omega protocol specification version `v2.4 (stable)` via `mcp__docs__lookup`.</answer>',
            makeUsage(240, 30, 0.03, 200),
          ),
        // Depth-1 specialist step 2: synthesize final branch report
        () =>
          makeAssistant(
            BRANCH_MODEL,
            '<folding range="1-1">Depth-2 specialist verified OMEGA_FACT_999 and spec v2.4.</folding><motivation>Return complete research report to root.</motivation><answer>### Omega Protocol Research Report\n- Web search (`tool_google_search_1`, line 96) establishes `OMEGA_FACT_999`.\n- Official MCP documentation (`mcp__docs__lookup`) confirms specification version `v2.4 (stable)` with zero breaking changes.</answer>',
            makeUsage(360, 40, 0.04, 300),
          ),
      ],
      [READER_MODEL.id]: [
        () =>
          makeAssistant(
            READER_MODEL,
            'RELEVANT\nLine 96 states OMEGA_FACT_999.',
            makeUsage(500, 20, 0.01, 0),
          ),
      ],
    });

    const ctx = createExtensionContext(cwd, registry);
    const config = sanitizeConfig({
      ...DEFAULT_CONFIG,
      depth: 2,
      branchModel: 'zai-coding-cn/glm-5.3-branch',
      readerModel: 'zai-coding-cn/glm-5.3-reader',
    });
    const routes = resolveRoutes(ctx, config);
    expect(routes).toBeDefined();
    if (routes === undefined) return;

    const allPiTools: ToolInfo[] = [
      makeToolInfo('google_search', {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
        },
        required: ['query'],
      }),
      makeToolInfo('ask_user_question', {
        type: 'object',
        properties: { question: { type: 'string' } },
      }, 'model-only'),
    ];
    const activeNames = allPiTools.map((t) => t.name);

    const session = new SessionState();
    const tracker = new RunTracker();
    const turn = await RafTurn.create({
      ctx,
      config,
      routes,
      session,
      tracker,
      prompt: 'Research omega protocol deeply.',
      nativeTools: bridgeableTools(allPiTools, activeNames),
      getSubagentTools: () => bridgeableTools(allPiTools, activeNames, { forSubagent: true }),
      history: [],
    });

    turn.prepareRequest([]);
    const rootBranchStep = makeAssistant(
      ROOT_MODEL,
      '<motivation>Delegate deep web and MCP research to a branch specialist.</motivation><tool_call>{"name":"branch","arguments":{"tasks":[{"scope":"omega-research","task":"Research omega protocol via google_search and MCP docs."}]}}</tool_call>',
      makeUsage(250, 35, 0.02, 120),
    );
    const step0 = await turn.acceptResponse(rootBranchStep, undefined);
    expect(step0?.kind).toBe('tool');
    if (step0 === undefined || step0.kind !== 'tool') return;

    const branchCall = step0.replacement.content.find((b) => b.type === 'toolCall');
    expect(branchCall).toBeDefined();
    if (branchCall === undefined || branchCall.type !== 'toolCall') return;

    const executedNativeCalls: Array<{ name: string; args: unknown }> = [];
    const toolCtx = {
      ...ctx,
      // Simulate an MCP tool exposed dynamically on ctx.tools (e.g., connected lazily on reachesTools: 'all')
      tools: [
        {
          name: 'mcp__docs__lookup',
          label: 'mcp__docs__lookup',
          description: 'Lookup protocol specification version',
          parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
              topic: { type: 'string' },
              limit: { type: 'integer' },
              strict: { type: 'boolean' },
            },
            required: ['topic'],
          },
          execute: vi.fn(),
        },
      ],
      executeTool: vi.fn(async (name: string, args: unknown) => {
        executedNativeCalls.push({ name, args });
        if (name === 'google_search') {
          return {
            toolCall: { type: 'toolCall', id: 'nested_1', name, arguments: args as Record<string, unknown> },
            result: { content: [{ type: 'text', text: largeWebPayload }], details: undefined },
            isError: false,
          };
        }
        if (name === 'mcp__docs__lookup') {
          return {
            toolCall: { type: 'toolCall', id: 'nested_2', name, arguments: args as Record<string, unknown> },
            result: { content: [{ type: 'text', text: 'Omega protocol spec v2.4 (stable)' }], details: undefined },
            isError: false,
          };
        }
        throw new Error(`Unexpected native tool ${name}`);
      }),
    } as unknown as ExtensionToolContext;

    const branchResult = await turn.executeTool(
      'branch',
      branchCall.arguments,
      branchCall.id,
      undefined,
      undefined,
      toolCtx,
    );

    // Verify subagents called both google_search and dynamically bridged mcp__docs__lookup with coerced arguments.
    expect(executedNativeCalls).toEqual([
      { name: 'google_search', args: { query: 'omega protocol spec', limit: 5 } },
      { name: 'mcp__docs__lookup', args: { topic: 'omega', limit: 3, strict: true } },
    ]);

    // Verify branchLLM (6 calls = 0.22 USD) + queryLLM (1 call = 0.01 USD) usage is reported on AgentToolResult.usage!
    expect(callsByModel.get(BRANCH_MODEL.id)).toBe(6);
    expect(callsByModel.get(READER_MODEL.id)).toBe(1);
    expect(branchResult.usage).toBeDefined();
    expect(branchResult.usage?.cost.total).toBeCloseTo(0.23, 5);
    expect(branchResult.details.call?.agents.length).toBe(2);

    const branchText = branchResult.content[0]?.type === 'text' ? branchResult.content[0].text : '';
    expect(branchText).toContain('OMEGA_FACT_999');
    expect(branchText).toContain('v2.4');

    // Verify fallback synthesis if root stops with an error after specialist reports are saved.
    const transcript: AgentMessage[] = [
      step0.replacement,
      {
        role: 'toolResult',
        toolCallId: branchCall.id,
        toolName: 'branch',
        content: branchResult.content,
        isError: false,
        timestamp: Date.now(),
      },
    ];
    turn.prepareRequest(transcript);
    // Force root failure (3 invalid responses in live retry -> fallback report from saved specialist reports).
    const { registry: failRegistry } = createScriptedRegistry({
      [ROOT_MODEL.id]: [
        () => makeAssistant(ROOT_MODEL, 'invalid 1', emptyUsage()),
        () => makeAssistant(ROOT_MODEL, 'invalid 2', emptyUsage()),
      ],
    });
    // Swap live registry streamSimple to return invalid responses for the retry test.
    (registry as { streamSimple: ModelRegistry['streamSimple'] }).streamSimple = failRegistry.streamSimple.bind(failRegistry);
    const step1 = await turn.acceptResponse(makeAssistant(ROOT_MODEL, 'invalid 0', emptyUsage()), undefined);
    expect(step1?.kind).toBe('final');
    if (step1 === undefined || step1.kind !== 'final') return;
    expect(step1.status).toBe('done');
    const finalText = step1.replacement.content.find((b) => b.type === 'text');
    expect(finalText?.type === 'text' ? finalText.text : '').toContain('# Final Report (Saved Branch Results)');
    expect(finalText?.type === 'text' ? finalText.text : '').toContain('OMEGA_FACT_999');
    turn.finish('done');
  });

  it('refreshes workspace files after edit/write and avoids document ID collisions on parallel indexing', async () => {
    const cwd = createWorkspace();
    const { registry } = createScriptedRegistry({});
    const ctx = createExtensionContext(cwd, registry);
    const routes = resolveRoutes(ctx, DEFAULT_CONFIG);
    expect(routes).toBeDefined();
    if (routes === undefined) return;

    const session = new SessionState();
    const turn = await RafTurn.create({
      ctx,
      config: DEFAULT_CONFIG,
      routes,
      session,
      tracker: new RunTracker(),
      prompt: 'Update alpha.ts',
      nativeTools: [],
      history: [],
    });

    // Update alpha.ts on disk and trigger indexResult('edit', ...)
    writeFileSync(join(cwd, 'alpha.ts'), 'export const SECRET_CODE = "UPDATED-777";\n', 'utf8');
    turn.indexResult('edit', { path: 'alpha.ts' }, 'Edited alpha.ts', false);

    const toolCtx = { ...ctx, tools: [], executeTool: vi.fn() } as unknown as ExtensionToolContext;
    const readRes = await turn.executeTool('read', { document: 'alpha.ts' }, 'c_read', undefined, undefined, toolCtx);
    const readText = readRes.content[0]?.type === 'text' ? readRes.content[0].text : '';
    expect(readText).toContain('UPDATED-777');

    // Index two large tool outputs in sequence / parallel without ID collision
    const bigA = 'A'.repeat(6500);
    const bigB = 'B'.repeat(6500);
    const outA = turn.indexResult('google_search', { query: 'first' }, bigA, false);
    const outB = turn.indexResult('google_search', { query: 'second' }, bigB, false);
    const idA = /document "([^"]+)"/.exec(outA)?.[1];
    const idB = /document "([^"]+)"/.exec(outB)?.[1];
    expect(idA).toBeDefined();
    expect(idB).toBeDefined();
    expect(idA).not.toBe(idB);

    turn.finish('done');
  });
});
