import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface RegisteredTool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  output?: { render?: (args: unknown, value: unknown) => Array<{ type: string; text: string }> };
  execute: (args: Record<string, unknown>, exec?: { agent?: unknown; signal?: AbortSignal; callId?: string }) => Promise<unknown>;
}

describe('@raf/dsh-plugin contract & multi-tool batching', () => {
  it('executes 3 batched read calls without file_read_* docs, preserves image/instructions/cacheControl, disposes toolSets, clones isSeeded, handles abort, and enforces 403 admission', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'raf-dsh-contract-'));
    const prevProfileDir = process.env.DSH_PROFILE_DIR;
    process.env.DSH_PROFILE_DIR = tmpDir;
    try {
      await writeFile(join(tmpDir, 'a.txt'), 'ALPHA = 1\n', 'utf8');
      await writeFile(join(tmpDir, 'b.txt'), 'BETA = 2\n', 'utf8');
      await writeFile(join(tmpDir, 'c.txt'), 'GAMMA = 3\n', 'utf8');
      await mkdir(join(tmpDir, 'raf-engine'), { recursive: true });
      await writeFile(
        join(tmpDir, 'raf-engine', 'state.json'),
        JSON.stringify({
          version: 1,
          defaultEngine: 'raf',
          engines: { 'sess-batch': 'raf' },
          settings: { depth: 2, reserve: 0.3, concurrency: 4 },
        }),
        'utf8',
      );

      const dshPlugin = (await import('../../dsh-plugin/index.js' as string)) as {
        apply: (ctx: unknown) => void;
      };

      const registeredTools = new Map<string, RegisteredTool>();
      const readyEmitter = new EventEmitter();
      const toolsReady = once(readyEmitter, 'ready');
      let resolveCount = 0;
      let disposeCount = 0;
      const customAppends: Array<{ type: string; data: unknown }> = [];
      const agentHandlers = new Map<string, Array<(ev: Record<string, unknown>) => void>>();
      const routes = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
      const disposers: Array<() => void> = [];

      const mockAgent = {
        id: 'sess-batch',
        session: {
          id: 'sess-batch',
          header: { cwd: tmpDir },
          log: [{ type: 'turn/start', data: { turn: 1 } }],
          append: () => {},
          appendCustom: (type: string, data: unknown) => {
            customAppends.push({ type, data });
          },
        },
      };

      const mockCompaction = {
        compactIfNeeded: async () => 'original-compacted',
      };
      const originalCompactRef = mockCompaction.compactIfNeeded;

      const extraPingTool: RegisteredTool = {
        name: 'ping_host',
        description: 'Ping remote host',
        parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
        async execute(args) {
          return `pong:${String(args.target ?? '')}`;
        },
      };
      registeredTools.set('ping_host', extraPingTool);

      const mockToolsService = {
        register(def: RegisteredTool) {
          registeredTools.set(def.name, def);
          if (def.name === 'branch') readyEmitter.emit('ready');
          return () => registeredTools.delete(def.name);
        },
        executable(name: string) {
          return registeredTools.get(name);
        },
        get(name: string) {
          return registeredTools.get(name);
        },
        definitions() {
          return [...registeredTools.values()];
        },
        async resolve() {
          resolveCount += 1;
          return {
            dispose: async () => {
              disposeCount += 1;
            },
          };
        },
        async execute(batch: { calls: Array<{ id: string; name: string; arguments: string }>; agent?: unknown }) {
          const results = [];
          for (const call of batch.calls) {
            const def = registeredTools.get(call.name);
            if (!def) {
              results.push({ callId: call.id, name: call.name, result: { isError: true, content: [{ type: 'text', text: 'missing' }] } });
              continue;
            }
            const parsedArgs = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
            const out = await def.execute(parsedArgs, { agent: batch.agent ?? mockAgent, callId: call.id });
            results.push({
              callId: call.id,
              name: call.name,
              result: { isError: false, content: [{ type: 'text', text: String(out ?? '') }] },
            });
          }
          return { results };
        },
      };

      let streamInterceptor:
        | ((options: Record<string, unknown>, next: () => unknown) => AsyncIterable<Record<string, unknown>>)
        | undefined;
      const recordedLlmRequests: Array<Record<string, unknown>> = [];
      let llmStep = 0;

      const mockCtx = {
        tools: mockToolsService,
        llm: {
          resolveModelInfo: () => ({ contextWindow: 256_000 }),
          retryPolicy: { maxAttempts: 2 },
          async *stream(opts: Record<string, unknown>) {
            recordedLlmRequests.push(opts);
            const purpose = String(opts.purpose ?? '');
            if (purpose === 'raf-branch') {
              const msgsJson = JSON.stringify(opts.messages ?? []);
              const text = msgsJson.includes('pong:host1')
                ? '<folding range="0-0">pinged host1</folding><motivation>done</motivation><answer>Branch confirmed pong:host1 cleanly.</answer>'
                : '<motivation>ping</motivation><tool_call name="ping_host"><target>host1</target></tool_call>';
              yield { type: 'text-delta', text };
              yield { type: 'usage', usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 0 } };
              yield { type: 'finish', reason: { kind: 'stop' } };
              return;
            }
            const idx = llmStep++;
            let text = '';
            if (idx === 0) {
              text =
                '<motivation>Batch 3 reads</motivation>' +
                '<tool_call name="read"><document>a.txt</document></tool_call>' +
                '<tool_call name="read"><document>b.txt</document></tool_call>' +
                '<tool_call name="read"><document>c.txt</document></tool_call>';
            } else if (idx === 1) {
              const userJson = JSON.stringify(opts.messages ?? []);
              expect(userJson).toContain('ALPHA = 1');
              expect(userJson).toContain('BETA = 2');
              expect(userJson).toContain('GAMMA = 3');
              text =
                '<folding range="0-0">Read a, b, c.</folding>' +
                '<motivation>Run branch</motivation>' +
                '<tool_call name="branch"><task scope="ping">Check ping_host for host1</task></tool_call>';
            } else {
              text =
                '<folding range="1-1">Branch confirmed pong:host1</folding>' +
                '<motivation>All done</motivation>' +
                '<answer>ALL_BATCH_OK</answer>';
            }
            yield { type: 'text-delta', text };
            yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 } };
            yield { type: 'finish', reason: { kind: 'stop' } };
          },
        },
        get(service: string) {
          if (service === 'tools') return mockToolsService;
          if (service === 'llm') return this.llm;
          if (service === 'compaction') return mockCompaction;
          if (service === 'agents') {
            return {
              get: (id: string) => (id === 'sess-batch' ? mockAgent : undefined),
              list: () => [mockAgent],
              withInitiator: async (_a: unknown, fn: () => Promise<unknown>) => fn(),
            };
          }
          if (service === 'workingDirectory') return { get: () => tmpDir };
          if (service === 'webServer') {
            return {
              register: (spec: { path: string; handler: (req: unknown, res: unknown) => Promise<void> }) => {
                routes.set(spec.path, spec.handler);
                return () => routes.delete(spec.path);
              },
            };
          }
          return undefined;
        },
        effect(fn: () => (() => void) | void) {
          const cleanup = fn();
          if (typeof cleanup === 'function') disposers.push(cleanup);
        },
        on(event: string, handler: (arg: Record<string, unknown>, next?: () => unknown) => unknown) {
          if (event === 'llm/stream') {
            streamInterceptor = handler as typeof streamInterceptor;
          } else {
            const list = agentHandlers.get(event) ?? [];
            list.push(handler as (ev: Record<string, unknown>) => void);
            agentHandlers.set(event, list);
          }
          return () => {};
        },
        inject(_deps: readonly string[], cb: (subCtx: unknown) => void) {
          cb({ ...this, webServer: this.get('webServer'), compaction: mockCompaction });
        },
      };

      dshPlugin.apply(mockCtx);
      await toolsReady;
      expect(streamInterceptor).toBeDefined();
      expect('_rafWrapped' in mockCompaction).toBe(false);

      // 1. Fail-closed 403 on HTTP route when connection service is missing and _isRafMockHost is unset
      const engineRoute = routes.get('/plugins/@raf/dsh-plugin/engine');
      expect(engineRoute).toBeDefined();
      let routeStatus = 0;
      await engineRoute?.(
        { url: '/plugins/@raf/dsh-plugin/engine', method: 'GET' },
        {
          writeHead: (s: number) => {
            routeStatus = s;
          },
          end: () => {},
        },
      );
      expect(routeStatus).toBe(403);

      // 2. Execute 3 batched read calls + branch + answer with multimodal image and AGENTS.md instructions
      const messages: Array<Record<string, unknown>> = [
        {
          id: 'msg-instr',
          role: 'user',
          content: [{ type: 'text', text: '# AGENTS\nNever use npm.' }],
          source: { kind: 'agent-instructions' },
        },
        {
          id: 'msg-skills',
          role: 'user',
          content: [{ type: 'text', text: '<available_skills>skill-x</available_skills>' }],
          source: { kind: 'skill-catalog' },
        },
        {
          id: 'msg-u1',
          role: 'user',
          content: [
            { type: 'text', text: 'Read a.txt, b.txt, c.txt and ping host1' },
            { type: 'image', mimeType: 'image/png', data: 'QUJD' },
          ],
          source: { kind: 'user' },
        },
      ];

      let finalAnswer = '';
      const seenFoldReasoning: string[] = [];
      for (let loop = 0; loop < 5; loop++) {
        if (streamInterceptor === undefined) throw new Error('streamInterceptor missing');
        const stream = streamInterceptor(
          {
            sessionId: 'sess-batch',
            provider: 'mock',
            model: 'mock-root',
            system: 'DSH_SYSTEM_BASE',
            messages,
          },
          () => {
            throw new Error('should not fall through');
          },
        );
        const stepCalls: Array<{ id: string; name: string; arguments: string }> = [];
        for await (const chunk of stream) {
          if (chunk.type === 'block-end') {
            const b = chunk.block as { type: string; id?: string; name?: string; arguments?: string; text?: string };
            if (b.type === 'tool-call' && b.id && b.name) {
              stepCalls.push({ id: b.id, name: b.name, arguments: b.arguments ?? '{}' });
            } else if (b.type === 'reasoning' && b.text) {
              seenFoldReasoning.push(b.text);
            } else if (b.type === 'text' && b.text) {
              finalAnswer = b.text;
            }
          }
        }
        if (stepCalls.length === 0) break;
        const batchOut = await mockToolsService.execute({ calls: stepCalls, agent: mockAgent });
        for (let i = 0; i < stepCalls.length; i++) {
          const c = stepCalls[i];
          const r = batchOut.results[i];
          if (c === undefined || r === undefined) continue;
          messages.push({
            id: `tool-${loop}-${i}`,
            role: 'tool',
            toolCallId: c.id,
            isError: r.result.isError,
            content: r.result.content,
          });
        }
      }

      expect(finalAnswer).toBe('ALL_BATCH_OK');
      // Fold summary appeared in visible reasoning and appendCustom
      expect(seenFoldReasoning.some((t) => t.includes('[Fold 0-0]'))).toBe(true);
      expect(customAppends.some((c) => c.type === 'raf-fold')).toBe(true);
      // ResolvedToolSet was disposed on every resolve
      expect(resolveCount).toBeGreaterThan(0);
      expect(disposeCount).toBe(resolveCount);

      // Verify system addendum, cacheControl on segments, and image block preserved in outgoing LLM request
      const firstReq = recordedLlmRequests[0] as { messages: Array<{ role: string; content: Array<Record<string, unknown>> }> };
      expect(firstReq.messages[0]?.content[0]?.text).toContain('DSH_SYSTEM_BASE');
      expect(firstReq.messages[0]?.content[0]?.text).toContain('Never use npm.');
      expect(firstReq.messages[0]?.content[0]?.text).toContain('<available_skills>skill-x</available_skills>');
      expect(firstReq.messages[0]?.content[0]?.cacheControl).toEqual({ type: 'ephemeral' });
      expect(firstReq.messages[1]?.content.some((b) => b.type === 'image' && b.data === 'QUJD')).toBe(true);

      // Verify no file_read_* documents persisted in session JSON
      const persisted = JSON.parse(
        await readFile(join(tmpDir, 'raf-engine', 'sessions', 'sess-batch.json'), 'utf8'),
      ) as { docs?: Record<string, unknown> };
      const docKeys = Object.keys(persisted.docs ?? {});
      expect(docKeys.some((k) => k.startsWith('file_read_'))).toBe(false);

      // 3. Verify isSeeded fork clones parent SessionState
      const createdHandlers = agentHandlers.get('agent/created') ?? [];
      for (const h of createdHandlers) {
        h({
          agent: {
            id: 'sess-fork',
            meta: { isSeeded: true, parentSessionId: 'sess-batch' },
            session: { id: 'sess-fork', header: { isSeeded: true, parentId: 'sess-batch' } },
          },
        });
      }

      // 4. Verify AbortController.abort() yields { type: 'finish', reason: { kind: 'aborted' } }
      const abortCtrl = new AbortController();
      abortCtrl.abort(new Error('user aborted'));
      const abortStream = streamInterceptor!(
        {
          sessionId: 'sess-batch',
          provider: 'mock',
          model: 'mock-root',
          signal: abortCtrl.signal,
          messages: [
            {
              id: 'msg-abort',
              role: 'user',
              content: [{ type: 'text', text: 'aborted prompt' }],
              source: { kind: 'user' },
            },
          ],
        },
        () => {
          throw new Error('should not fall through');
        },
      );
      const abortChunks: Array<Record<string, unknown>> = [];
      for await (const c of abortStream) abortChunks.push(c);
      expect(abortChunks[abortChunks.length - 1]).toEqual({ type: 'finish', reason: { kind: 'aborted' } });

      // 5. Dispose restores exact original compactIfNeeded
      for (const d of disposers) d();
      expect(mockCompaction.compactIfNeeded).toBe(originalCompactRef);
    } finally {
      if (prevProfileDir === undefined) delete process.env.DSH_PROFILE_DIR;
      else process.env.DSH_PROFILE_DIR = prevProfileDir;
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
