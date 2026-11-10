/**
 * Recursive AgentFold (RAF) for pi.
 *
 * When enabled, each root agent step is one native pi request: the AgentFold
 * context replaces the transcript, pi's model selection answers it, and the
 * engine folds the response into a native tool call or the final answer.
 * Branch specialists and the llm_query reader run inside the RAF tool call.
 */

import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import {
  createGrepToolDefinition,
  createReadToolDefinition,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import type { TSchema } from 'typebox';
import { ContextStore, RecursiveAgentFold, type LLMClient, type Tool } from '@raf/engine';
import { loadConfig, saveConfig, type RafConfig } from './config.js';
import { fallbackExecute } from './native-fallback.js';
import { renderProtocolMarkdown } from './protocol-view.js';
import { resolveRoutes, type Routes } from './routes.js';
import { geminiSafeSchema } from './schema.js';
import {
  asPersistedState,
  ENTRY_MODE,
  ENTRY_RUN,
  ENTRY_STATE,
  messageText,
  SessionState,
  type TurnStatus,
} from './state.js';
import { cacheRate, oneLine, RunTracker } from './tracker.js';
import { RAF_TOOL_NAMES, RafTurn, bridgeableTools, type RafToolName } from './turn.js';
import { duration, percent, usd } from './ui/format.js';
import { AgentsWidget, headerLines } from './ui/live.js';
import { rafRenderCall, rafRenderResult } from './ui/renderers.js';
import { openRafSettings } from './ui/settings.js';

const HOTKEY_TOGGLE = 'ctrl+shift+r';
const HOTKEY_CONFIG = 'ctrl+shift+s';
const CONFIG_FILE = 'raf.json';
const WIDGET_LIVE = 'raf-live';

const SHADOWED_NATIVE: ReadonlySet<string> = new Set(Object.freeze(['read', 'grep']));
const OWNED_RAF_TOOLS: ReadonlySet<string> = new Set(RAF_TOOL_NAMES);

/** Persisted run summary (custom entry data for `/tree` and reload). */
interface RunEntryData {
  readonly version: 1;
  readonly status: TurnStatus;
  readonly steps: number;
  readonly folds: number;
  readonly deepFolds: number;
  readonly formatErrors: number;
  readonly agents: number;
  readonly queries: number;
  readonly queryChunks: number;
  readonly cacheRoot: number | null;
  readonly cacheBranch: number | null;
  readonly cacheReader: number | null;
  readonly costUsd: number;
  readonly seconds: number;
  readonly answer: string;
}

let cachedEngineTools: ReadonlyMap<string, Tool> | undefined;

/** Build template engine tool definitions once per process. */
function getEngineTools(): ReadonlyMap<string, Tool> {
  if (cachedEngineTools !== undefined) return cachedEngineTools;
  const dummy: LLMClient = {
    profile: { name: 'template', contextWindow: 128_000, maxOutputTokens: 16 },
    complete() {
      return Promise.reject(new Error('RAF template has no model'));
    },
  };
  const map = new Map<string, Tool>();
  for (const tool of new RecursiveAgentFold({ rootLLM: dummy, queryLLM: dummy, store: new ContextStore() }).toolsFor(0)) {
    map.set(tool.name, tool);
  }
  cachedEngineTools = map;
  return map;
}

export interface RafExtensionOptions {
  readonly configPath?: string;
}

export default function rafExtension(pi: ExtensionAPI, options?: RafExtensionOptions): void {
  const configPath = options?.configPath ?? join(getAgentDir(), CONFIG_FILE);
  let config: RafConfig = loadConfig(configPath);
  let enabled = false;
  let session = new SessionState();
  const tracker = new RunTracker();
  let turn: RafTurn | undefined;
  let routes: Routes | undefined;
  let lastUi: ExtensionContext | undefined;

  /** Rebuild in-memory state from the custom entries of the active branch. */
  function restoreFromBranch(ctx: ExtensionContext): void {
    let stateData: unknown;
    let mode: boolean | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom') continue;
      if (entry.customType === ENTRY_STATE) stateData = entry.data;
      else if (entry.customType === ENTRY_MODE) {
        const value = (entry.data as { enabled?: unknown } | undefined)?.enabled;
        if (typeof value === 'boolean') mode = value;
      }
    }
    session = new SessionState();
    session.restore(asPersistedState(stateData));
    enabled = mode ?? config.enabledByDefault;
  }

  function registerRafTools(): void {
    const byName = getEngineTools();
    for (const name of RAF_TOOL_NAMES) {
      const engineTool = byName.get(name);
      if (engineTool === undefined) continue;
      pi.registerTool({
        name,
        label: name,
        description: engineTool.description,
        promptSnippet: oneLine(`${name}: ${engineTool.description}`, 110),
        parameters: geminiSafeSchema(engineTool.parameters) as unknown as TSchema,
        ...(name === 'branch' ? { reachesTools: () => 'all' as const } : {}),
        renderCall: rafRenderCall(name, ''),
        renderResult: rafRenderResult,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const current = turn;
          const record = (params ?? {}) as Record<string, unknown>;
          if (current !== undefined && !current.done) {
            return current.executeTool(name as RafToolName, record, toolCallId, signal, onUpdate, ctx);
          }
          return fallbackExecute(name, toolCallId, record, signal, ctx, HOTKEY_TOGGLE);
        },
      });
    }
    const active = new Set(pi.getActiveTools());
    for (const name of RAF_TOOL_NAMES) active.add(name);
    pi.setActiveTools([...active]);
  }

  /** Restore pi's native `read` and `grep` definitions and deactivate RAF-only tools. */
  function restoreNativeTools(cwd: string): void {
    pi.registerTool(createReadToolDefinition(cwd));
    pi.registerTool(createGrepToolDefinition(cwd));
    pi.setActiveTools(pi.getActiveTools().filter((name) => !OWNED_RAF_TOOLS.has(name) || SHADOWED_NATIVE.has(name)));
  }

  function syncTools(cwd: string): void {
    if (enabled) registerRafTools();
    else restoreNativeTools(cwd);
  }

  function refreshChrome(ctx: ExtensionContext): void {
    lastUi = ctx;
    routes = resolveRoutes(ctx, config) ?? routes;
    if (ctx.mode !== 'tui') return;
    if (enabled && routes !== undefined) {
      const current = routes;
      ctx.ui.setHeader((_tui, theme) => ({
        render(width: number): string[] {
          return headerLines(theme, current, width);
        },
        invalidate(): void {},
      }));
    } else {
      ctx.ui.setHeader(undefined);
    }
  }

  function attachLiveWidget(ctx: ExtensionContext): void {
    if (ctx.mode !== 'tui') return;
    ctx.ui.setWidget(
      WIDGET_LIVE,
      (tui, theme) => new AgentsWidget(tracker, tui, theme),
      { placement: 'aboveEditor' },
    );
  }

  function detachLiveWidget(): void {
    lastUi?.ui.setWidget(WIDGET_LIVE, undefined);
  }

  function setEnabled(next: boolean, ctx: ExtensionContext): void {
    if (enabled === next) {
      ctx.ui.notify(`RAF is already ${next ? 'on' : 'off'}`, 'info');
      return;
    }
    enabled = next;
    pi.appendEntry(ENTRY_MODE, { enabled: next });
    if (!next && turn !== undefined && !turn.done) {
      turn.finish('aborted');
      pi.appendEntry(ENTRY_STATE, session.snapshot('aborted'));
      turn = undefined;
    }
    detachLiveWidget();
    syncTools(ctx.cwd);
    refreshChrome(ctx);
    ctx.ui.notify(next ? `RAF on — root ${routes?.root.spec ?? '(model set by /model)'}` : 'RAF off — standard pi agent', 'info');
  }

  function finalizeTurn(status: TurnStatus, result: { answer: string | null } | undefined, startedAt: number): void {
    const current = turn;
    if (current === undefined || current.done) return;
    current.finish(status);
    const run = tracker.runTotals();
    const seconds = (Date.now() - startedAt) / 1000;
    const cost = run.roles.root.costUsd + run.roles.branch.costUsd + run.roles.llm_query.costUsd;
    pi.appendEntry(ENTRY_STATE, session.snapshot(status));
    pi.appendEntry(ENTRY_RUN, {
      version: 1,
      status,
      steps: run.steps,
      folds: run.folds,
      deepFolds: run.deepFolds,
      formatErrors: run.formatErrors,
      agents: run.agents,
      queries: run.queries,
      queryChunks: run.queryChunks,
      cacheRoot: cacheRate([run.roles.root]) ?? null,
      cacheBranch: cacheRate([run.roles.branch]) ?? null,
      cacheReader: cacheRate([run.roles.llm_query]) ?? null,
      costUsd: cost,
      seconds,
      answer: oneLine(result?.answer ?? '', 400),
    } satisfies RunEntryData);
    detachLiveWidget();
    turn = undefined;
  }

  pi.on('session_start', async (_event, ctx) => {
    restoreFromBranch(ctx);
    syncTools(ctx.cwd);
    refreshChrome(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    restoreFromBranch(ctx);
    syncTools(ctx.cwd);
    refreshChrome(ctx);
  });

  pi.on('session_before_switch', async () => {
    if (turn !== undefined) finalizeTurn('aborted', undefined, turn.startedAt);
  });

  pi.on('session_before_fork', async () => {
    if (turn !== undefined) finalizeTurn('aborted', undefined, turn.startedAt);
  });

  pi.on('session_shutdown', async () => {
    if (turn !== undefined && !turn.done) turn.finish('aborted');
    turn = undefined;
    detachLiveWidget();
  });

  pi.on('model_select', async (_event, ctx) => refreshChrome(ctx));
  pi.on('thinking_level_select', async (_event, ctx) => refreshChrome(ctx));

  pi.on('before_agent_start', async (event, ctx) => {
    if (!enabled) return;
    routes = resolveRoutes(ctx, config) ?? routes;
    if (routes === undefined) return;
    if (turn !== undefined && !turn.done) return;
    if (event.messageType !== 'user') return;
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    let index = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user') {
        index = i;
        break;
      }
    }
    const prompt = index >= 0 ? messageText(messages[index]) : event.prompt;
    const history = index >= 0 ? messages.slice(0, index) : [];
    if (prompt.trim() === '') return;
    try {
      turn = await RafTurn.create({
        ctx,
        config,
        routes,
        session,
        tracker,
        prompt,
        nativeTools: bridgeableTools(pi.getAllTools(), pi.getActiveTools()),
        getSubagentTools: () => bridgeableTools(pi.getAllTools(), pi.getActiveTools(), { forSubagent: true }),
        history,
      });
      attachLiveWidget(ctx);
    } catch (error) {
      ctx.ui.notify(`RAF cannot start: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  });

  pi.on('context_with_system', async (event, ctx) => {
    const current = turn;
    if (!enabled || current === undefined || current.done) return;
    current.link(ctx.signal);
    try {
      return { messages: current.prepareRequest(event.messages) };
    } catch (error) {
      ctx.ui.notify(`RAF step failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      finalizeTurn('error', undefined, current.startedAt);
      return { messages: event.messages };
    }
  });

  pi.on('message_end', async (event, ctx) => {
    if (event.message.role !== 'assistant') return;
    const current = turn;
    if (current === undefined || current.done) return;
    const outcome = await current.acceptResponse(event.message, ctx.signal);
    if (outcome === undefined) return;
    if (outcome.kind === 'final') finalizeTurn(outcome.status, outcome.result, current.startedAt);
    return { message: outcome.replacement };
  });

  pi.on('agent_settled', async (event, ctx) => {
    const current = turn;
    if (current === undefined || current.done) return;
    finalizeTurn(event.aborted ? 'aborted' : 'error', undefined, current.startedAt);
    if (!event.aborted) ctx.ui.notify('RAF run ended early; the turn was saved', 'warning');
  });

  pi.on('session_before_compact', async () => {
    if (turn !== undefined && !turn.done) return { cancel: true };
  });

  pi.on('cache_warming_decision', async () => {
    if (enabled && (turn !== undefined || session.rootState !== undefined)) return { action: 'stop' };
  });

  pi.registerMarkdownTransformer((markdown, { isStreaming }) => {
    if (!isStreaming || turn === undefined || turn.done) return markdown;
    return renderProtocolMarkdown(markdown);
  });

  pi.registerEntryRenderer(ENTRY_RUN, (entry, { expanded }, theme: Theme) => {
    const data = entry.data as RunEntryData | undefined;
    if (data === undefined) return new Text('', 0, 0);
    const icon = data.status === 'done' ? theme.fg('success', '✓') : data.status === 'aborted' ? theme.fg('warning', '⏹') : theme.fg('error', '✗');
    const head =
      `${icon} ${theme.bold('RAF run')} ${theme.fg('muted', data.status)} · ` +
      `${data.steps} steps · ${data.folds} folds${data.deepFolds > 0 ? ` (${data.deepFolds} deep)` : ''} · ` +
      `${data.agents} agents · ${data.queries} queries · ` +
      `cache r ${percent(data.cacheRoot ?? undefined)} / br ${percent(data.cacheBranch ?? undefined)} / q ${percent(data.cacheReader ?? undefined)} · ` +
      `${usd(data.costUsd)} · ${duration(data.seconds * 1000)}`;
    const lines = [head];
    if (expanded && data.answer !== '') lines.push(theme.fg('dim', oneLine(data.answer, 400)));
    return new Text(lines.join('\n'), 0, 0);
  });

  function applyConfig(next: RafConfig, ctx: ExtensionContext): void {
    config = next;
    const saved = saveConfig(configPath, next);
    if (!saved.ok) ctx.ui.notify(`RAF config not saved: ${saved.error}`, 'warning');
    refreshChrome(ctx);
  }

  pi.registerCommand('raf', {
    description: 'Recursive AgentFold: on/off, settings, status',
    getArgumentCompletions: (prefix: string) => {
      const items = ['on', 'off', 'settings', 'status'].map((value) => ({ value, label: value }));
      const filtered = items.filter((item) => item.value.startsWith(prefix));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === 'on' || arg === 'off') {
        setEnabled(arg === 'on', ctx);
        return;
      }
      if (arg === 'status') {
        const run = tracker.sessionTotals();
        const total = run.roles.root.costUsd + run.roles.branch.costUsd + run.roles.llm_query.costUsd;
        ctx.ui.notify(
          `RAF ${enabled ? 'on' : 'off'} · root ${routes?.root.spec ?? '?'} · subagent ${routes?.branch.spec ?? '?'} · llm ${routes?.reader.spec ?? '?'} · ` +
            `steps ${run.steps} · folds ${run.folds} · cache ${percent(cacheRate([run.roles.root]))} · ${usd(total)}`,
          'info',
        );
        return;
      }
      routes = resolveRoutes(ctx, config) ?? routes;
      await openRafSettings(ctx, config, routes, (next) => applyConfig(next, ctx));
    },
  });

  pi.registerShortcut(HOTKEY_TOGGLE, {
    description: 'Toggle Recursive AgentFold (RAF)',
    handler: async (ctx) => setEnabled(!enabled, ctx),
  });

  pi.registerShortcut(HOTKEY_CONFIG, {
    description: 'RAF settings',
    handler: async (ctx) => {
      routes = resolveRoutes(ctx, config) ?? routes;
      await openRafSettings(ctx, config, routes, (next) => applyConfig(next, ctx));
    },
  });
}
