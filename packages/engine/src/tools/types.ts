import type { AgentEvent } from '../agent/events.js';
import type { ContextStore } from '../context/store.js';
import type { ResearchBoard } from '../context/board.js';
import type { ToolAction } from '../fold/state.js';
import type { UsageTracker } from '../llm/usage.js';
import type { JSONSchema } from '../types.js';
import { parseLooseJSON } from '../util/json.js';
import { parseFlexibleBranchTasks } from './branch-args.js';

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
  readonly ancestorTasks?: readonly string[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JSONSchema;
  /** Return true when parallel calls in the same step can run concurrently. */
  readonly isConcurrencySafe?: (args: Readonly<Record<string, unknown>>) => boolean;
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
    if (required) throw new ToolArgumentError(`missing required argument "${key}"`);
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
  if (!Number.isFinite(n)) throw new ToolArgumentError(`argument "${key}" must be a number`);
  return n;
}

export function argStringList(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  throw new ToolArgumentError(`argument "${key}" must be a list of strings`);
}

/** Coerce parsed tool arguments to match the tool's JSONSchema property types. */
export function coerceToolArguments(
  args: Record<string, unknown>,
  schema?: JSONSchema,
): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };
  for (const [key, val] of Object.entries(out)) {
    const prop = props[key];
    if (!prop || val === undefined || val === null) continue;
    const expectedType = Array.isArray(prop.type)
      ? prop.properties !== undefined && Object.keys(prop.properties).length > 0 && prop.type.includes('object')
        ? 'object'
        : prop.items !== undefined && prop.type.includes('array')
          ? 'array'
          : prop.type[0]
      : prop.type;
    if (expectedType === 'string' && typeof val !== 'string' && !Array.isArray(val)) {
      out[key] = String(val);
    } else if ((expectedType === 'number' || expectedType === 'integer') && typeof val === 'string') {
      const trimmed = val.trim();
      if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
        out[key] = Number(trimmed);
      }
    } else if (expectedType === 'boolean' && typeof val === 'string') {
      const trimmed = val.trim().toLowerCase();
      if (trimmed === 'true' || trimmed === 'false') {
        out[key] = trimmed === 'true';
      }
    } else if (expectedType === 'array' && typeof val === 'string') {
      if (key === 'tasks') {
        try {
          out[key] = parseFlexibleBranchTasks(val, typeof out.scope === 'string' ? out.scope : undefined);
        } catch {
          // Leave raw string so the tool validator reports a clear error.
        }
        continue;
      }
      const trimmed = val.trim();
      if (trimmed.startsWith('[')) {
        try {
          const parsed: unknown = parseLooseJSON(trimmed);
          if (Array.isArray(parsed)) {
            out[key] = parsed;
            continue;
          }
        } catch {
          // Fall through to delimiter split.
        }
      }
      const splitRe = key === 'paths' ? /\r?\n+/ : /[\n,]+/;
      out[key] = val
        .split(splitRe)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return out;
}

/** Render a tool call in XML tag format for step history display. */
export function formatToolCallXml(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [`<tool_call name="${name}">`];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (k === 'tasks' && Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          const scopeAttr = typeof rec.scope === 'string' && rec.scope ? ` scope="${rec.scope}"` : '';
          parts.push(`<task${scopeAttr}>${String(rec.task ?? '')}</task>`);
        } else {
          parts.push(`<task>${String(item)}</task>`);
        }
      }
    } else if (Array.isArray(v)) {
      parts.push(`<${k}>${v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ')}</${k}>`);
    } else if (typeof v === 'object' && v !== null) {
      parts.push(`<${k}>${JSON.stringify(v)}</${k}>`);
    } else {
      parts.push(`<${k}>${String(v)}</${k}>`);
    }
  }
  parts.push('</tool_call>');
  return parts.join('');
}

/** Render one or more tool actions in XML tag format for step history display. */
export function formatToolCallsXml(actions: readonly ToolAction[]): string {
  if (actions.length === 0) return '';
  if (actions.length === 1) {
    const single = actions[0];
    return single ? formatToolCallXml(single.name, single.arguments) : '';
  }
  const parts = new Array<string>(actions.length);
  for (let i = 0; i < actions.length; i++) {
    const act = actions[i];
    parts[i] = act ? formatToolCallXml(act.name, act.arguments) : '';
  }
  return parts.join('\n');
}

function formatSchemaType(schema: JSONSchema, depth = 0): string {
  if (depth < 2 && schema.type === 'array' && schema.items !== undefined) {
    return `${formatSchemaType(schema.items, depth + 1)}[]`;
  }
  if (depth < 2 && schema.properties !== undefined) {
    const entries = Object.entries(schema.properties);
    if (entries.length > 0) {
      const req = new Set(Array.isArray(schema.required) ? schema.required : []);
      const fields = entries.map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${formatSchemaType(v, depth + 1)}`);
      return `{${fields.join(', ')}}`;
    }
  }
  if (Array.isArray(schema.type)) return schema.type.join('|');
  return schema.type ?? 'string';
}

/** Render tool schemas in XML parameter format for the system prompt (stable ordering => cache-stable). */
export function renderToolSchemas(tools: readonly Tool[]): string {
  return tools
    .map((t) => {
      const props = t.parameters.properties ?? {};
      const reqSet = new Set(Array.isArray(t.parameters.required) ? t.parameters.required : []);
      const paramSpecs: string[] = [];
      for (const [pName, pSchema] of Object.entries(props)) {
        const baseType = formatSchemaType(pSchema);
        const enumPart = Array.isArray(pSchema.enum) ? ` [${pSchema.enum.map(String).join(' | ')}]` : '';
        const reqPart = reqSet.has(pName) ? ', required' : '';
        const descPart = pSchema.description ? `: ${pSchema.description}` : '';
        paramSpecs.push(`<${pName}> (${baseType}${enumPart}${reqPart}${descPart})`);
      }
      return `- ${t.name}: ${t.description}\n  Parameters: ${paramSpecs.length > 0 ? paramSpecs.join('; ') : 'none'}`;
    })
    .join('\n');
}
