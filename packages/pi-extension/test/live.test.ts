import { describe, expect, it } from 'vitest';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { TUI } from '@earendil-works/pi-tui';
import type { Routes } from '../src/routes.js';
import { RunTracker, type AgentSnapshot, type CallSnapshot } from '../src/tracker.js';
import { AgentsWidget, headerLines, RafWidget } from '../src/ui/live.js';
import { rafRenderCall, rafRenderResult } from '../src/ui/renderers.js';

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
  it('renders the exact four-line startup card with 4-space-indented routes', () => {
    const lines = headerLines(theme, routes, 200);
    expect(lines).toEqual([
      'RAF ctr+sh+S',
      '    ◉ glm-5.3-flash:max /model',
      '    ⑂ glm-5.3-flash:max /raf',
      '    ⟂ glm-5.3',
    ]);
  });

  it('merges root telemetry onto the RAF title line using uppercase K without tok', () => {
    const rootAgent: AgentSnapshot = {
      name: 'root',
      depth: 0,
      task: 'Analyze repo',
      status: 'running',
      step: 4,
      steps: 1,
      contextTokens: 25_000,
      blocks: 4,
      folds: 1,
      deepFolds: 0,
      promptTokens: 25_000,
      cachedTokens: 0,
      completionTokens: 2_000,
      calls: 1,
      startedAt: 1_000,
      log: [],
    };
    const lines = headerLines(theme, routes, 200, rootAgent);
    expect(lines).toEqual([
      'RAF ctr+sh+S · s4/1 · f1 · 4b · cache 0% · 25K',
      '    ◉ glm-5.3-flash:max /model',
      '    ⑂ glm-5.3-flash:max /raf',
      '    ⟂ glm-5.3',
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
      '    ◉ claude-sonnet-4-5 /model',
      '    ⑂ claude-sonnet-4-5 /raf · ! unknown foo/bar',
      '    ⟂ claude-sonnet-4-5 ! unknown baz/qux',
    ]);
  });
});

describe('RafWidget', () => {
  it('renders aboveEditor card without redundant root thinking row and shows rate-limit notice', () => {
    const tracker = new RunTracker();
    const tui = { requestRender: () => {} } as unknown as TUI;
    expect(AgentsWidget).toBe(RafWidget);
    const widget = new RafWidget(tracker, () => routes, tui, theme);
    expect(widget.render(200)).toEqual([
      'RAF ctr+sh+S',
      '    ◉ glm-5.3-flash:max /model',
      '    ⑂ glm-5.3-flash:max /raf',
      '    ⟂ glm-5.3',
    ]);

    tracker.startRun(1_000);
    tracker.apply({ type: 'run_start', agent: 'root', depth: 0, question: 'Analyze repo' }, 1_000);
    tracker.apply({ type: 'step_start', agent: 'root', depth: 0, step: 4, contextTokens: 25_000, blocks: 4 }, 1_000);
    tracker.setRateLimit(Date.now() + 5_000);

    const rendered = widget.render(200);
    expect(rendered[0]).toContain('RAF ctr+sh+S · s4/1');
    expect(rendered[0]).toContain('25K');
    expect(rendered.join('\n')).not.toContain('root thinking');
    expect(rendered[4]).toContain('    ⏳ rate limit');
    widget.dispose();
  });
});

describe('BR branch renderer', () => {
  it('renders compact specialist tree with └─ (depth 1), └───── (depth 2), cache %, and uppercase K', () => {
    const callHeader = rafRenderCall('branch', '')({ scope: 'packages/engine', task: 'Inspect' }, theme)
      .render(200)
      .map((line) => line.trimEnd());
    expect(callHeader).toEqual(['BR branch packages/engine']);

    const mkAgent = (name: string, depth: number, scope: string, parent: string): AgentSnapshot => ({
      name,
      depth,
      parent,
      scope,
      task: 'Inspect',
      status: 'running',
      step: 1,
      steps: 1,
      contextTokens: 24_000,
      blocks: 2,
      folds: 0,
      deepFolds: 0,
      promptTokens: 24_000,
      cachedTokens: 4_080,
      completionTokens: 500,
      calls: 1,
      startedAt: 1_000,
      log: [],
    });

    const call: CallSnapshot = {
      tool: 'branch',
      startedAt: 1_000,
      agents: [
        mkAgent('sub_1', 1, 'packages/engine', 'root'),
        mkAgent('sub_1_1', 2, 'packages/subs', 'sub_1'),
        mkAgent('sub_2', 1, 'packages/test', 'root'),
      ],
      queries: [],
      readerActive: 0,
      readerDone: 0,
    };

    const resultLines = rafRenderResult(
      { content: [{ type: 'text', text: 'running…' }], details: { tool: 'branch', call, lines: 0, chars: 0 } },
      { expanded: false, isPartial: true },
      theme,
    )
      .render(200)
      .map((line) => line.trimEnd());

    expect(resultLines).toHaveLength(4);
    expect(resultLines[0]).toMatch(/^. branch 3 running · 0\/3 · 0 chunks$/);
    expect(resultLines[1]).toMatch(/^└─ . packages\/engine cache 17% · 24K$/);
    expect(resultLines[2]).toMatch(/^└───── . packages\/subs cache 17% · 24K$/);
    expect(resultLines[3]).toMatch(/^└─ . packages\/test cache 17% · 24K$/);
  });
});
