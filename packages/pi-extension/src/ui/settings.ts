import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { getSettingsListTheme } from '@earendil-works/pi-coding-agent';
import { Container, type KeybindingsManager, SettingsList, type SettingItem, type TUI } from '@earendil-works/pi-tui';
import { sanitizeConfig, THINKING_LEVELS, type RafConfig } from '../config.js';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { resolveRoutes, type Routes } from '../routes.js';
import { availableModels, modelItems, modelPicker } from './pickers.js';
import { shortModel } from './format.js';

const ON_OFF = Object.freeze(['on', 'off'] as const);

function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

/** Open the /raf settings screen. Returns when the user closes it. */
export async function openRafSettings(
  ctx: ExtensionContext,
  config: RafConfig,
  routes: Routes | undefined,
  onApply: (next: RafConfig) => void,
): Promise<void> {
  if (ctx.mode !== 'tui') {
    ctx.ui.notify('/raf needs the interactive terminal UI', 'error');
    return;
  }
  let draft: RafConfig = config;
  let activeRoutes: Routes | undefined = routes;
  await ctx.ui.custom<void>((tui: TUI, theme: Theme, keybindings: KeybindingsManager, done) => {
    const container = new Container();
    let list: SettingsList;

    const commitDraft = (next: RafConfig): void => {
      draft = sanitizeConfig(next);
      activeRoutes = resolveRoutes(ctx, draft) ?? activeRoutes;
      onApply(draft);
    };

    const modelSubmenu =
      (title: string, getCurrent: () => string, apply: (spec: string) => RafConfig) =>
      (_value: string, submenuDone: (selected?: string) => void) => {
        const current = getCurrent();
        return modelPicker({
          tui,
          theme,
          keybindings,
          title,
          items: modelItems(availableModels(ctx), activeRoutes?.root.model, 'root'),
          current: current === '' ? '(root)' : current,
          onSelect: (spec) => {
            commitDraft(apply(spec));
            submenuDone(spec === '' ? '(root)' : shortModel(spec));
          },
          onCancel: () => submenuDone(),
        });
      };

    const branchLevels = () => {
      const model = activeRoutes?.branch.model;
      const supported = model === undefined ? [...THINKING_LEVELS] : getSupportedThinkingLevels(model);
      return ['inherit', ...supported];
    };

    const items: SettingItem[] = [
      {
        id: 'branchModel',
        label: 'subagent model',
        description: 'Model for branch specialists. Empty = the root model.',
        currentValue: draft.branchModel === '' ? '(root)' : shortModel(draft.branchModel),
        submenu: modelSubmenu(
          'branch (subagent) model',
          () => draft.branchModel,
          (spec) => ({ ...draft, branchModel: spec }),
        ),
      },
      {
        id: 'branchThinking',
        label: 'subagent thinking',
        description: 'Reasoning effort for branch specialists. inherit = the root level.',
        currentValue: draft.branchThinking,
        values: branchLevels(),
      },
      {
        id: 'readerModel',
        label: 'llm_query model',
        description: 'Non-thinking reader for llm_query chunk scans. Empty = the root model.',
        currentValue: draft.readerModel === '' ? '(root)' : shortModel(draft.readerModel),
        submenu: modelSubmenu(
          'llm_query reader model',
          () => draft.readerModel,
          (spec) => ({ ...draft, readerModel: spec }),
        ),
      },
      { id: 'depth', label: 'fold depth', description: 'Max branch recursion depth.', currentValue: String(config.depth), values: ['1', '2', '3'] },
      {
        id: 'reserve',
        label: 'reader reserve',
        description: 'Reader window fraction kept free. Smaller = bigger chunks.',
        currentValue: config.reserve.toFixed(2),
        values: ['0.10', '0.15', '0.20', '0.25', '0.30', '0.35', '0.40', '0.45', '0.50'],
      },
      {
        id: 'concurrency',
        label: 'readers',
        description: 'Parallel branch and llm_query calls.',
        currentValue: String(config.concurrency),
        values: ['1', '2', '4', '8', '12', '16', '24', '32'],
      },
      {
        id: 'deepStudy',
        label: 'deep-study protocol',
        description: 'Delegate repository-wide studies to scoped specialists.',
        currentValue: onOff(config.deepStudy),
        values: [...ON_OFF],
      },
      {
        id: 'indexWorkspace',
        label: 'index workspace',
        description: 'Add workspace files to the RAF context store at run start.',
        currentValue: onOff(config.indexWorkspace),
        values: [...ON_OFF],
      },
      {
        id: 'enabledByDefault',
        label: 'on by default',
        description: 'Start new sessions with RAF enabled.',
        currentValue: onOff(config.enabledByDefault),
        values: [...ON_OFF],
      },
    ];

    const applyChange = (id: string, newValue: string): void => {
      switch (id) {
        case 'branchThinking':
          commitDraft({ ...draft, branchThinking: newValue as RafConfig['branchThinking'] });
          return;
        case 'depth':
          commitDraft({ ...draft, depth: Number(newValue) });
          return;
        case 'reserve':
          commitDraft({ ...draft, reserve: Number(newValue) });
          return;
        case 'concurrency':
          commitDraft({ ...draft, concurrency: Number(newValue) });
          return;
        case 'deepStudy':
          commitDraft({ ...draft, deepStudy: newValue === 'on' });
          return;
        case 'indexWorkspace':
          commitDraft({ ...draft, indexWorkspace: newValue === 'on' });
          return;
        case 'enabledByDefault':
          commitDraft({ ...draft, enabledByDefault: newValue === 'on' });
          return;
        default:
          return;
      }
    };

    list = new SettingsList(items, Math.min(items.length + 2, 16), getSettingsListTheme(), applyChange, () => done());

    const header = {
      render(width: number): string[] {
        const root = routes?.root.spec ?? '(no model)';
        const lines = [theme.fg('accent', theme.bold('Recursive AgentFold')), theme.fg('muted', `root ${root} — set by /model`), ''];
        return lines;
      },
      invalidate(): void {},
    };
    container.addChild(header);
    container.addChild(list);

    return {
      capturesViewportInput: list.capturesViewportInput,
      render(width: number): string[] {
        return container.render(width);
      },
      invalidate(): void {
        container.invalidate();
      },
      handleInput(data: string): void {
        list.handleInput?.(data);
        tui.requestRender();
      },
    };
  });
}
