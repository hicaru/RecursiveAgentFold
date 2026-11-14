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
  readonly cwd?: string;
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

function toCamelKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function toSnakeKey(key: string): string {
  return key.replace(/([A-Z])/g, (_, ch: string) => `_${ch.toLowerCase()}`);
}

function resolveSchemaType(prop: JSONSchema): string | undefined {
  if (Array.isArray(prop.type)) {
    if (prop.properties !== undefined && Object.keys(prop.properties).length > 0 && prop.type.includes('object')) {
      return 'object';
    }
    if (prop.items !== undefined && prop.type.includes('array')) {
      return 'array';
    }
    return prop.type[0];
  }
  return prop.type;
}

/** Coerce parsed tool arguments to match the tool's JSONSchema property types. */
export function coerceToolArguments(
  args: Record<string, unknown>,
  schema?: JSONSchema,
): Record<string, unknown> {
  const props = schema?.properties;
  if (!props) return args;
  const out: Record<string, unknown> = { ...args };

  // Map unambiguous snake_case <-> camelCase keys onto declared schema properties.
  for (const key of Object.keys(out)) {
    if (key in props) continue;
    const camel = toCamelKey(key);
    const snake = toSnakeKey(key);
    if (camel !== key && camel in props && !(camel in out)) {
      out[camel] = out[key];
      delete out[key];
    } else if (snake !== key && snake in props && !(snake in out)) {
      out[snake] = out[key];
      delete out[key];
    }
  }

  for (const [key, val] of Object.entries(out)) {
    const prop = props[key];
    if (!prop || val === undefined || val === null) continue;
    const expectedType = resolveSchemaType(prop);
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

/** Validate coerced tool arguments against JSONSchema and built-in alias-group requirements. */
export function validateToolArguments(
  toolName: string,
  args: Readonly<Record<string, unknown>>,
  schema?: JSONSchema,
): readonly string[] {
  const errors: string[] = [];
  const baseName = toolName.replace(/^(?:raf|ref)_/, '');
  const required = Array.isArray(schema?.required) ? schema.required : [];

  if (required.length === 0) {
    if (baseName === 'read') {
      const hasTarget =
        (typeof args.document === 'string' && args.document.trim() !== '') ||
        (typeof args.path === 'string' && args.path.trim() !== '') ||
        (typeof args.file_path === 'string' && args.file_path.trim() !== '') ||
        (typeof args.filePath === 'string' && args.filePath.trim() !== '');
      if (!hasTarget) {
        errors.push(`${toolName}: missing required argument "document", "path", or "file_path"`);
      }
    } else if (baseName === 'add_document') {
      const hasSingle =
        (typeof args.path === 'string' && args.path.trim() !== '') ||
        (typeof args.source === 'string' && args.source.trim() !== '') ||
        (typeof args.file_path === 'string' && args.file_path.trim() !== '') ||
        (typeof args.dir === 'string' && args.dir.trim() !== '');
      const hasMulti = Array.isArray(args.paths) && args.paths.length > 0;
      if (!hasSingle && !hasMulti) {
        errors.push(`${toolName}: missing required argument "path" or non-empty "paths"`);
      }
    } else if (baseName === 'branch') {
      const hasTask = typeof args.task === 'string' && args.task.trim() !== '';
      const hasTasks = Array.isArray(args.tasks) && args.tasks.length > 0;
      if (!hasTask && !hasTasks) {
        errors.push(`${toolName}: missing required argument "task" or non-empty "tasks"`);
      }
    }
  }

  for (const reqKey of required) {
    const camel = toCamelKey(reqKey);
    const snake = toSnakeKey(reqKey);
    const val =
      args[reqKey] !== undefined
        ? args[reqKey]
        : camel !== reqKey && args[camel] !== undefined
          ? args[camel]
          : snake !== reqKey && args[snake] !== undefined
            ? args[snake]
            : undefined;
    if (val === undefined || val === null || (typeof val === 'string' && val.trim() === '')) {
      errors.push(`${toolName}: missing required argument "${reqKey}"`);
    }
  }

  const props = schema?.properties;
  if (props) {
    for (const [key, val] of Object.entries(args)) {
      if (val === undefined || val === null) continue;
      const prop = props[key];
      if (!prop) continue;
      const expectedType = resolveSchemaType(prop);
      if (expectedType === 'integer') {
        if (typeof val !== 'number' || !Number.isFinite(val) || !Number.isInteger(val)) {
          errors.push(`${toolName}: argument "${key}" must be an integer`);
        }
      } else if (expectedType === 'number') {
        if (typeof val !== 'number' || !Number.isFinite(val)) {
          errors.push(`${toolName}: argument "${key}" must be a finite number`);
        }
      } else if (expectedType === 'boolean') {
        if (typeof val !== 'boolean') {
          errors.push(`${toolName}: argument "${key}" must be a boolean`);
        }
      } else if (expectedType === 'array') {
        if (!Array.isArray(val)) {
          errors.push(`${toolName}: argument "${key}" must be an array`);
        }
      } else if (expectedType === 'object') {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
          errors.push(`${toolName}: argument "${key}" must be an object`);
        }
      } else if (expectedType === 'string') {
        if (typeof val !== 'string') {
          errors.push(`${toolName}: argument "${key}" must be a string`);
        }
      }
    }

    if (schema?.additionalProperties === false && Object.keys(props).length > 0) {
      for (const key of Object.keys(args)) {
        if (!(key in props)) {
          errors.push(`${toolName}: unknown argument "${key}"`);
        }
      }
    }
  }

  return errors;
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render a tool call in XML tag format for step history display. */
export function formatToolCallXml(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [`<tool_call name="${escapeXmlText(name).replace(/"/g, '&quot;')}">`];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (k === 'tasks' && Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rec = item as Record<string, unknown>;
          const scopeAttr =
            typeof rec.scope === 'string' && rec.scope
              ? ` scope="${escapeXmlText(rec.scope).replace(/"/g, '&quot;')}"`
              : '';
          parts.push(`<task${scopeAttr}>${escapeXmlText(String(rec.task ?? ''))}</task>`);
          parts.push(`<task>${escapeXmlText(String(item))}</task>`);
        }
      }
    } else if (Array.isArray(v)) {
      parts.push(
        `<${k}>${escapeXmlText(v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', '))}</${k}>`,
      );
    } else if (typeof v === 'object' && v !== null) {
      parts.push(`<${k}>${escapeXmlText(JSON.stringify(v))}</${k}>`);
    } else {
      parts.push(`<${k}>${escapeXmlText(String(v))}</${k}>`);
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
