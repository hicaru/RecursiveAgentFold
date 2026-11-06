import type { AgentEvent } from '../agent/events.js';
import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import type { UsageTracker } from '../llm/usage.js';
import type { JSONSchema } from '../types.js';

export interface ToolContext {
  readonly store: ContextStore;
  readonly usage: UsageTracker;
  /** Recursion depth of the calling agent (root = 0). */
  readonly depth: number;
  readonly agentName: string;
  readonly step: number;
  readonly emit: (e: AgentEvent) => void;
  readonly signal?: AbortSignal;
  readonly board?: ResearchBoard;
  readonly callStack?: readonly string[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgumentError';
  }
}

export function argString(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ToolArgumentError(`缺少必需参数 "${key}"`);
    return undefined;
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join('\n');
  return String(v);
}

export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) throw new ToolArgumentError(`参数 "${key}" 必须是数字`);
  return n;
}

export function argStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  throw new ToolArgumentError(`参数 "${key}" 必须是字符串列表`);
}

/** Render tool schemas for the system prompt (stable ordering => cache-stable). */
export function renderToolSchemas(tools: readonly Tool[]): string {
  return tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }))
    .join('\n');
}
