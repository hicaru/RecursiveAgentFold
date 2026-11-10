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
  tokens,
} from './format.js';

const TICK_MS = 250;
const ROUTE_INDENT = '    ';

function modelLabel(spec: string, thinking: string): string {
  const name = shortModel(spec);
  return thinking === 'off' || thinking === '' ? name : `${name}:${thinking}`;
}

function rootTelemetryParts(root: AgentSnapshot | undefined): string[] {
  if (root === undefined || root.steps <= 0) return [];
  const parts: string[] = [`s${root.step}/${root.steps}`];
  if (root.folds > 0) parts.push(`f${root.folds}`);
  if (root.blocks > 0) parts.push(`${root.blocks}b`);
  const rate = cacheRate([
    {
      calls: root.calls,
      promptTokens: root.promptTokens,
      cachedTokens: root.cachedTokens,
      completionTokens: root.completionTokens,
      costUsd: 0,
    },
  ]);
  if (rate !== undefined) parts.push(`cache ${percent(rate)}`);
  const contextSize = root.contextTokens > 0 ? root.contextTokens : root.promptTokens + root.completionTokens;
  if (contextSize > 0) parts.push(tokens(contextSize));
  return parts;
}

/** RAF status & route lines rendered directly above the editor. */
export function headerLines(
  theme: Theme,
  routes: Routes,
  width: number,
  rootAgent?: AgentSnapshot,
): string[] {
  const branchNote = routes.branch.missing === undefined ? '/raf' : `/raf · ! unknown ${routes.branch.missing}`;
  const readerNote = routes.reader.missing === undefined ? '' : ` ${theme.fg('dim', `! unknown ${routes.reader.missing}`)}`;
  const telemetry = rootTelemetryParts(rootAgent);
  const telemetrySuffix = telemetry.length > 0 ? ` ${theme.fg('muted', `· ${joinParts(telemetry)}`)}` : '';
  return [
    truncateToWidth(`${theme.fg('accent', theme.bold('RAF'))} ${theme.fg('dim', 'ctr+sh+S')}${telemetrySuffix}`, width),
    truncateToWidth(`${ROUTE_INDENT}${theme.fg('toolTitle', '◉')} ${modelLabel(routes.root.spec, routes.root.thinking)} ${theme.fg('dim', '/model')}`, width),
    truncateToWidth(`${ROUTE_INDENT}${theme.fg('toolTitle', '⑂')} ${modelLabel(routes.branch.spec, routes.branch.thinking)} ${theme.fg('dim', branchNote)}`, width),
    truncateToWidth(`${ROUTE_INDENT}${theme.fg('toolTitle', '⟂')} ${shortModel(routes.reader.spec)}${readerNote}`, width),
  ];
}

/**
 * Persistent RAF status & routes widget placed directly above the editor (`aboveEditor`).
 * Merges live root telemetry onto the `RAF ctr+sh+S` header line without duplicating
 * pi's `Working` spinner or `BR branch` sub-agent trees.
 */
export class RafWidget {
  private readonly tracker: RunTracker;
  private readonly getRoutes: () => Routes | undefined;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    tracker: RunTracker,
    getRoutes: () => Routes | undefined,
    tui: TUI,
    theme: Theme,
  ) {
    this.tracker = tracker;
    this.getRoutes = getRoutes;
    this.tui = tui;
    this.theme = theme;
    this.unsubscribe = tracker.subscribe(() => this.onChange());
    this.syncTimer();
  }

  private syncTimer(): void {
    const throttle = this.tracker.rateLimitRemaining(Date.now()) > 0;
    if (throttle) {
      if (this.timer === undefined) {
        this.timer = setInterval(() => {
          this.syncTimer();
          this.tui.requestRender();
        }, TICK_MS);
        this.timer.unref?.();
      }
    } else if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private onChange(): void {
    this.syncTimer();
    this.tui.requestRender();
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
    const routes = this.getRoutes();
    if (routes === undefined) return [];
    const rootAgent = this.tracker.agentTree().find((agent) => agent.depth === 0);
    const lines = headerLines(this.theme, routes, width, rootAgent);
    const waiting = this.tracker.rateLimitRemaining(Date.now());
    if (waiting > 0) {
      lines.push(
        truncateToWidth(
          `${ROUTE_INDENT}${this.theme.fg('warning', `⏳ rate limit · ${duration(waiting)} left`)}`,
          width,
        ),
      );
    }
    return lines;
  }
}

export { RafWidget as AgentsWidget };