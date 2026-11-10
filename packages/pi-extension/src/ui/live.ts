/**
 * RAF live TUI widgets — numbers, not meters.
 *
 * House rules:
 *  - every measurable value is a plain number with a short unit (`72%`, `253k`)
 *  - no progress bars, no box art, no duplicated counters
 *  - the root model's own parameters (model, tokens, cost) already live in pi's
 *    footer, so the widgets here only show what pi cannot: RAF agent activity.
 */
import type { Theme } from '@earendil-works/pi-coding-agent';
import { truncateToWidth } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import type { Routes } from '../routes.js';
import { cacheRate, type AgentSnapshot, type RunTracker } from '../tracker.js';
import {
  duration,
  joinParts,
  percent,
  shortModel,
  spinnerFrame,
  tokens,
} from './format.js';

const MAX_TREE_AGENTS = 12;
const TICK_MS = 120;

function statusIcon(theme: Theme, agent: AgentSnapshot, now: number): string {
  if (agent.status === 'running') return theme.fg('accent', spinnerFrame(now));
  if (agent.status === 'done') return theme.fg('success', '✓');
  return theme.fg('error', '✗');
}

function agentTail(agent: AgentSnapshot): string {
  if (agent.status === 'running') return agent.action ?? 'thinking';
  return agent.terminated ?? agent.answer ?? agent.status;
}

/** One agent row: icon, name, then raw numbers. */
function agentRow(theme: Theme, agent: AgentSnapshot, prefix: string, now: number): string {
  const name = agent.depth === 0 ? 'root' : (agent.scope ?? agent.name);
  const parts: string[] = [agentTail(agent)];

  parts.push(`s${agent.step}/${agent.steps}`);
  if (agent.folds > 0) parts.push(`f${agent.folds}`);
  if (agent.blocks > 0) parts.push(`${agent.blocks}b`);

  const rate = cacheRate([
    {
      calls: agent.calls,
      promptTokens: agent.promptTokens,
      cachedTokens: agent.cachedTokens,
      completionTokens: agent.completionTokens,
      costUsd: 0,
    },
  ]);
  if (rate !== undefined) parts.push(`cache ${percent(rate)}`);

  const total = agent.promptTokens + agent.completionTokens;
  if (total > 0) parts.push(`${tokens(total)}tok`);

  return `${prefix}${statusIcon(theme, agent, now)} ${theme.bold(name)} ${theme.fg('muted', joinParts(parts))}`;
}

function treePrefix(index: number, last: boolean, depth: number): string {
  if (depth === 0) return '';
  return '│ '.repeat(depth - 1) + (last ? '└─' : '├─');
}

/**
 * Live agent tree shown above the editor while a RAF turn runs.
 * Children indent under their parent (usually root). Root is skipped when the
 * tree has children: the root row is already the turn's status line.
 */
export class AgentsWidget {
  private readonly tracker: RunTracker;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(tracker: RunTracker, tui: TUI, theme: Theme) {
    this.tracker = tracker;
    this.tui = tui;
    this.theme = theme;
    this.unsubscribe = tracker.subscribe(() => this.onChange());
    this.onChange();
  }

  private onChange(): void {
    const tree = this.tracker.agentTree();
    const now = Date.now();
    const running = tree.some((agent) => agent.status === 'running');
    const throttle = this.tracker.rateLimitRemaining(now) > 0;
    if (running || throttle) {
      if (this.timer === undefined) {
        this.timer = setInterval(() => this.tui.requestRender(), TICK_MS);
        this.timer.unref?.();
      }
    } else if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (running !== this.running || tree.length > 0) {
      this.running = running;
      this.tui.requestRender();
    }
  }

  dispose(): void {
    this.unsubscribe();
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const tree = this.tracker.agentTree();
    if (tree.length === 0) return [];

    const now = Date.now();
    const shown = tree.slice(0, MAX_TREE_AGENTS);
    const lines: string[] = [];
    for (let index = 0; index < shown.length; index += 1) {
      const agent = shown[index];
      if (agent === undefined) continue;
      const next = shown[index + 1];
      const last = next === undefined || next.depth <= agent.depth;
      const prefix = treePrefix(index, last, agent.depth);
      lines.push(truncateToWidth(agentRow(this.theme, agent, prefix, now), width));
    }
    if (tree.length > shown.length) {
      lines.push(this.theme.fg('dim', `… +${tree.length - shown.length} agents`));
    }
    const waiting = this.tracker.rateLimitRemaining(now);
    if (waiting > 0) {
      lines.push(this.theme.fg('warning', `⏳ rate limit · ${duration(waiting)} left`));
    }
    return lines;
  }
}

function modelLabel(spec: string, thinking: string): string {
  const name = shortModel(spec);
  return thinking === 'off' || thinking === '' ? name : `${name}:${thinking}`;
}

/** Header card: model routes only. */
export function headerLines(theme: Theme, routes: Routes, width: number): string[] {
  const branchNote = routes.branch.missing === undefined ? '/raf' : `/raf · ! unknown ${routes.branch.missing}`;
  const readerNote = routes.reader.missing === undefined ? '' : ` ${theme.fg('dim', `! unknown ${routes.reader.missing}`)}`;
  return [
    truncateToWidth(`${theme.fg('accent', theme.bold('RAF'))} ${theme.fg('dim', 'ctr+sh+S')}`, width),
    truncateToWidth(`${theme.fg('toolTitle', '◉')} ${modelLabel(routes.root.spec, routes.root.thinking)} ${theme.fg('dim', '/model')}`, width),
    truncateToWidth(`${theme.fg('toolTitle', '⑂')} ${modelLabel(routes.branch.spec, routes.branch.thinking)} ${theme.fg('dim', branchNote)}`, width),
    truncateToWidth(`${theme.fg('toolTitle', '⟂')} ${shortModel(routes.reader.spec)}${readerNote}`, width),
  ];
}