/**
 * Native pi adapters for shadowed builtins outside a live RAF turn.
 *
 * When RAF is switched off, `pi.registerTool(createReadToolDefinition(cwd))`
 * and `pi.registerTool(createGrepToolDefinition(cwd))` restore pi's native
 * tools directly. When RAF is enabled but a shadowed tool runs outside a turn,
 * these adapters forward the call to pi's native definitions while accepting
 * RAF parameter aliases (`document` / `file_path`, `start_line` / `end_line`,
 * `case_sensitive`, `max_matches`).
 */
import {
  createGrepToolDefinition,
  createReadToolDefinition,
  type AgentToolResult,
  type ExtensionToolContext,
} from '@earendil-works/pi-coding-agent';
import { contentText } from './state.js';
import type { RafToolDetails } from './turn.js';

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Run pi's native `read` or `grep` tool with RAF parameter alias support. */
export async function fallbackExecute(
  name: string,
  toolCallId: string,
  args: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  toggleShortcut: string,
): Promise<AgentToolResult<RafToolDetails>> {
  const cwd = ctx.cwd ?? process.cwd();
  if (name === 'read') {
    const path = str(args.path) ?? str(args.file_path) ?? str(args.document);
    if (path === undefined) {
      throw new Error('read: missing "path" argument (or "document" / "file_path")');
    }
    const start = num(args.offset) ?? num(args.start_line);
    const end = num(args.end_line);
    const limit = num(args.limit) ?? (start !== undefined && end !== undefined && end >= start ? end - start + 1 : undefined);
    const native = await createReadToolDefinition(cwd).execute(
      toolCallId,
      {
        path,
        ...(start !== undefined ? { offset: start } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      signal,
      undefined,
      ctx,
    );
    const text = contentText(native.content);
    return {
      content: native.content,
      ...(native.isError !== undefined ? { isError: native.isError } : {}),
      details: { tool: 'read', lines: text === '' ? 0 : text.split('\n').length, chars: text.length },
    };
  }
  if (name === 'grep') {
    const pattern = str(args.pattern);
    if (pattern === undefined) {
      throw new Error('grep: missing "pattern" argument');
    }
    const searchPath = str(args.path);
    const glob = str(args.glob);
    const ignoreCase =
      typeof args.ignoreCase === 'boolean'
        ? args.ignoreCase
        : typeof args.case_sensitive === 'boolean'
          ? !args.case_sensitive
          : undefined;
    const literal = typeof args.literal === 'boolean' ? args.literal : undefined;
    const context = num(args.context);
    const limit = num(args.limit) ?? num(args.max_matches);
    const native = await createGrepToolDefinition(cwd).execute(
      toolCallId,
      {
        pattern,
        ...(searchPath !== undefined ? { path: searchPath } : {}),
        ...(glob !== undefined ? { glob } : {}),
        ...(ignoreCase !== undefined ? { ignoreCase } : {}),
        ...(literal !== undefined ? { literal } : {}),
        ...(context !== undefined ? { context } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
      signal,
      undefined,
      ctx,
    );
    const text = contentText(native.content);
    return {
      content: native.content,
      ...(native.isError !== undefined ? { isError: native.isError } : {}),
      details: { tool: 'grep', lines: text === '' ? 0 : text.split('\n').length, chars: text.length },
    };
  }
  throw new Error(`RAF is off · ${name} needs a live RAF turn · press ${toggleShortcut}`);
}
