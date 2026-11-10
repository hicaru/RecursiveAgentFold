import { describe, expect, it } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { Routes } from '../src/routes.js';
import { RunTracker } from '../src/tracker.js';
import { AgentsWidget, headerLines } from '../src/ui/live.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

const routes: Routes = {
  root: { model: {} as never, spec: 'zai-coding-cn/glm-5.3-flash', thinking: 'max', inherited: false },
  branch: { model: {} as never, spec: 'zai-coding-cn/glm-5.3-flash', thinking: 'max', inherited: true },
  reader: { model: {} as never, spec: 'zai-coding-cn/glm-5.3', thinking: 'off', inherited: false },
};

describe('headerLines', () => {
  it('renders the exact four-line header format', () => {
    const lines = headerLines(theme, routes, 200);
    expect(lines).toEqual([
      'RAF ctr+sh+S',
      '◉ glm-5.3-flash:max /model',
      '⑂ glm-5.3-flash:max /raf',
      '⟂ glm-5.3',
    ]);
  });

  it('omits thinking suffix when off and renders missing model warnings', () => {
    const offRoutes: Routes = {
      root: { model: {} as never, spec: 'anthropic/claude-sonnet-4-5', thinking: 'off', inherited: false },
      branch: {
        model: {} as never,
        spec: 'anthropic/claude-sonnet-4-5',
        thinking: 'off',
        inherited: true,
        missing: 'foo/bar',
      },
      reader: {
        model: {} as never,
        spec: 'anthropic/claude-sonnet-4-5',
        thinking: 'off',
        inherited: true,
        missing: 'baz/qux',
      },
    };
    const lines = headerLines(theme, offRoutes, 200);
    expect(lines).toEqual([
      'RAF ctr+sh+S',
      '◉ claude-sonnet-4-5 /model',
      '⑂ claude-sonnet-4-5 /raf · ! unknown foo/bar',
      '⟂ claude-sonnet-4-5 ! unknown baz/qux',
    ]);
  });
});

describe('AgentsWidget', () => {
  it('renders active agent hierarchy and rate-limit countdown', () => {
    const tracker = new RunTracker();
    const tui = { requestRender: () => {} } as unknown as TUI;
    const widget = new AgentsWidget(tracker, tui, theme);
    expect(widget.render(120)).toEqual([]);

    tracker.startRun(1_000);
    tracker.apply({ type: 'run_start', agent: 'root', depth: 0, question: 'Analyze repo' }, 1_000);
    tracker.apply({ type: 'step_start', agent: 'root', depth: 0, step: 0, contextTokens: 500, blocks: 0 }, 1_000);
    tracker.apply(
      { type: 'run_start', agent: 'sub_1', depth: 1, parent: 'root', scope: 'packages/engine', question: 'Inspect engine' },
      1_050,
    );
    tracker.setRateLimit(Date.now() + 5_000);

    const rendered = widget.render(120);
    expect(rendered[0]).toContain('root');
    expect(rendered[1]).toContain('└─');
    expect(rendered[1]).toContain('packages/engine');
    expect(rendered[2]).toContain('rate limit');
    widget.dispose();
  });
});
