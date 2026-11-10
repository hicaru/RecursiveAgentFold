import type { ExtensionContext, Theme } from '@earendil-works/pi-coding-agent';
import { getSelectListTheme } from '@earendil-works/pi-coding-agent';
import { fuzzyFilter, Input, type SelectListTheme, type SelectItem, SelectList, type TUI, type KeybindingsManager } from '@earendil-works/pi-tui';
import type { ChatModel } from '../llm.js';
import { modelSpec } from '../llm.js';

/** One selectable model row. */
export interface PickerItem {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

const ROOT_VALUE = '(root)';

/** Build picker rows from available chat models, with the root-model entry first. */
export function modelItems(models: readonly ChatModel[], root: ChatModel | undefined, rootLabel: string): PickerItem[] {
  const items: PickerItem[] = [];
  if (root !== undefined) {
    items.push({ value: ROOT_VALUE, label: `${rootLabel} (root model)`, description: `${modelSpec(root)} — the pi /model selection` });
  }
  const specs = new Set(models.map(modelSpec));
  if (root !== undefined) specs.delete(modelSpec(root));
  for (const model of models) {
    const spec = modelSpec(model);
    if (!specs.has(spec)) continue;
    specs.delete(spec);
    items.push({
      value: spec,
      label: model.name === model.id ? spec : `${model.name} · ${spec}`,
      description: `${model.contextWindow.toLocaleString('en-US')} ctx · ${model.reasoning ? 'reasoning' : 'non-thinking'}`,
    });
  }
  return items;
}

export interface PickerOptions {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly title: string;
  readonly items: readonly PickerItem[];
  readonly current: string;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
}

/**
 * Searchable model picker: typing filters (fuzzy), arrows move, Enter selects,
 * Escape cancels. Used as a SettingsList submenu component.
 */
export function modelPicker(opts: PickerOptions) {
  const { tui, theme, keybindings, items, current } = opts;
  const selectTheme: SelectListTheme = getSelectListTheme();
  const input = new Input({ placeholder: 'filter models…' });
  input.focused = true;
  let list = buildList();
  let closed = false;

  function buildList(): SelectList {
    const query = input.getValue().trim();
    const filtered =
      query === ''
        ? [...items]
        : fuzzyFilter([...items], query, (item) => `${item.label} ${item.description}`);
    const selectItems: SelectItem[] = filtered.map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
    }));
    const startIndex = Math.max(
      0,
      selectItems.findIndex((item) => item.value === current),
    );
    const next = new SelectList(selectItems, 12, selectTheme);
    next.setSelectedIndex(startIndex);
    next.onSelect = (item) => {
      if (closed) return;
      closed = true;
      opts.onSelect(item.value === ROOT_VALUE ? '' : item.value);
    };
    next.onCancel = () => {
      if (closed) return;
      closed = true;
      opts.onCancel();
    };
    return next;
  }

  function refilter(): void {
    list = buildList();
    invalidate();
    tui.requestRender();
  }

  function invalidate(): void {
    input.invalidate();
    list.invalidate();
  }

  return {
    render(width: number): string[] {
      const lines = [theme.fg('accent', theme.bold(opts.title)), input.render(width)[0] ?? '', ''];
      lines.push(...list.render(width));
      lines.push('', theme.fg('dim', 'type to filter · ↑↓ move · enter select · esc back'));
      return lines;
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, 'tui.select.up') || keybindings.matches(data, 'tui.select.down')) {
        list.handleInput(data);
      } else if (keybindings.matches(data, 'tui.select.confirm')) {
        const selected = list.getSelectedItem();
        if (selected !== null) {
          closed = true;
          opts.onSelect(selected.value === ROOT_VALUE ? '' : selected.value);
          return;
        }
        closed = true;
        opts.onCancel();
      } else if (keybindings.matches(data, 'tui.select.cancel')) {
        closed = true;
        opts.onCancel();
      } else {
        input.handleInput(data);
        refilter();
        return;
      }
      invalidate();
      tui.requestRender();
    },
    invalidate,
  };
}

/** Available chat models with working credentials, sorted by provider then id. */
export function availableModels(ctx: ExtensionContext): ChatModel[] {
  const models = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
  return [...models].sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
}
