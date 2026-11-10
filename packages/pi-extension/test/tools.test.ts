import { describe, expect, it } from 'vitest';
import type { ToolInfo } from '@earendil-works/pi-coding-agent';
import { ContextStore, RecursiveAgentFold, type LLMClient } from '@raf/engine';
import { geminiSafeSchema } from '../src/schema.js';
import { bridgeableTools, fitArguments, piToolName, RAF_TOOL_NAMES } from '../src/turn.js';

function tool(name: string, exposure: ToolInfo['exposure'] = 'direct'): ToolInfo {
  return {
    name,
    description: '',
    parameters: {} as ToolInfo['parameters'],
    exposure,
    sourceInfo: { path: name, source: 'builtin', scope: 'user', origin: 'top-level' },
  };
}

describe('tool surface', () => {
  it('keeps engine tool names untouched so they replace the pi tool of the same name', () => {
    expect(piToolName('grep')).toBe('grep');
    expect(piToolName('branch')).toBe('branch');
    expect(piToolName('read')).toBe('read');
    expect(piToolName('bash')).toBe('bash');
    expect(RAF_TOOL_NAMES).toContain('llm_query');
  });

  it('keeps active native tools and drops RAF-owned and blocked ones', () => {
    const all = [
      tool('bash'),
      tool('edit'),
      tool('read'),
      tool('grep'),
      tool('subagent'),
      tool('branch'),
      tool('websearch'),
      tool('mcp__docs__search'),
      tool('hidden_helper', 'codemode'),
      tool('deferred_helper', 'deferred'),
    ];
    const bridged = bridgeableTools(all, all.map((info) => info.name));
    expect(bridged.map((info) => info.name)).toEqual(['bash', 'edit', 'websearch', 'mcp__docs__search']);
  });

  it('allows model-only tools on root while excluding them on branch subagents', () => {
    const all = [
      tool('bash', 'direct'),
      tool('google_search', 'direct'),
      tool('ask_user_question', 'model-only'),
      tool('tool_search', 'model-only'),
    ];
    const active = all.map((info) => info.name);
    expect(bridgeableTools(all, active).map((info) => info.name)).toEqual([
      'bash',
      'google_search',
      'ask_user_question',
      'tool_search',
    ]);
    expect(bridgeableTools(all, active, { forSubagent: true }).map((info) => info.name)).toEqual([
      'bash',
      'google_search',
    ]);
  });

  it('normalizes aliases, coerces XML scalars/JSON, and strips extra keys for closed schemas', () => {
    const editSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
          },
        },
      },
    };
    expect(
      fitArguments(
        { file_path: 'src/a.ts', old_string: 'foo', new_string: 'bar', extra: 'dropped' },
        editSchema,
      ),
    ).toEqual({
      path: 'src/a.ts',
      edits: [{ oldText: 'foo', newText: 'bar' }],
    });

    const searchSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer' },
        exact: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    };
    expect(
      fitArguments(
        { query: 'agentfold', max_matches: '15', exact: 'true', tags: '["llm","kv"]' },
        searchSchema,
      ),
    ).toEqual({
      query: 'agentfold',
      limit: 15,
      exact: true,
      tags: ['llm', 'kv'],
    });
  });

  it('converts every RAF engine tool schema into a Gemini-safe JSON Schema', () => {
    const dummy: LLMClient = {
      profile: { name: 'dummy', contextWindow: 128_000, maxOutputTokens: 64 },
      complete: () => Promise.reject(new Error('unused')),
    };
    const engine = new RecursiveAgentFold({ rootLLM: dummy, queryLLM: dummy, store: new ContextStore() });

    const assertSafe = (node: unknown): void => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return;
      const rec = node as Record<string, unknown>;
      expect(rec.additionalProperties).not.toBe(false);
      expect(rec.anyOf).toBeUndefined();
      expect(rec.oneOf).toBeUndefined();
      expect(rec.allOf).toBeUndefined();
      expect(rec.const).toBeUndefined();
      if (rec.type !== undefined) expect(typeof rec.type).toBe('string');
      for (const value of Object.values(rec)) {
        if (Array.isArray(value)) {
          for (const item of value) assertSafe(item);
        } else {
          assertSafe(value);
        }
      }
    };

    for (const engineTool of engine.toolsFor(0)) {
      const safe = geminiSafeSchema(engineTool.parameters);
      expect(safe.type).toBe('object');
      assertSafe(safe);
      if (engineTool.name === 'branch') {
        const props = safe.properties as Record<string, Record<string, unknown>>;
        const items = props.tasks?.items as Record<string, unknown>;
        expect(items.type).toBe('object');
      }
    }
  });

  it('normalizes multi-format branch arguments inside fitArguments', () => {
    const branchSchema = {
      type: 'object',
      properties: {
        scope: { type: 'string' },
        task: { type: 'string' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: { scope: { type: 'string' }, task: { type: 'string' } },
          },
        },
      },
    };
    const fitted = fitArguments(
      {
        tasks: '<task scope="packages/engine">Audit engine, parser, and board</task><task scope="packages/pi-extension">Audit UI, live widget</task>',
      },
      branchSchema,
    );
    expect(fitted).toEqual({
      tasks: [
        { scope: 'packages/engine', task: 'Audit engine, parser, and board' },
        { scope: 'packages/pi-extension', task: 'Audit UI, live widget' },
      ],
    });
  });
});
