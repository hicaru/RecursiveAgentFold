window.__ModuleLoader__.load({
  id: '@raf/dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'raf';
    const PANEL_ID = 'raf';
    const SETTINGS_KEY = 'raf.dsh.settings.v1';
    const ENGINE_CONTEXTFOLD = 'contextfold';
    const ENGINE_RAF = 'raf';

    const DEPTH_MIN = 1;
    const DEPTH_MAX = 3;
    const RESERVE_MIN = 0.1;
    const RESERVE_MAX = 0.5;
    const RESERVE_STEP = 0.05;
    const CONCURRENCY_MIN = 1;
    const CONCURRENCY_MAX = 8;

    const DEFAULT_SETTINGS = Object.freeze({
      engine: ENGINE_CONTEXTFOLD,
      depth: 2,
      reserve: 0.3,
      concurrency: 4,
      cacheLayout: true,
    });

    const EN = Object.freeze({
      'panel.label': 'RAF',
      'panel.title': 'Recursive AgentFold',
      'panel.subtitle': 'Recursive AgentFold · engine settings',
      'engine.dsh.title': 'Standard',
      'engine.dsh.option': 'Standard',
      'engine.raf.title': 'RAF',
      'engine.raf.option': 'RAF (Recursive AgentFold)',
      'tuning.saved': 'Saved',
      'tuning.reset': 'Reset tuning',
      'tuning.depth.title': 'Fold depth',
      'tuning.depth.desc': 'How many recursive folds the root may spawn.',
      'tuning.reserve.title': 'Reserve',
      'tuning.reserve.desc': 'Share of each reader window kept free for the prompt.',
      'tuning.concurrency.title': 'Readers',
      'tuning.concurrency.desc': 'Parallel llm_query calls over the context.',
      'tuning.cache.title': 'Cache layout',
      'tuning.cache.desc': 'Place static chunks before the query. This keeps the prompt cache warm.',
      'tuning.decrease': 'Decrease',
      'tuning.increase': 'Increase',
      'menu.head': 'Engine',
      'switch.aria': 'Engine: {engine}. Open the engine menu.',
    });

    const RU = Object.freeze({
      'panel.label': 'RAF',
      'panel.title': 'Recursive AgentFold',
      'panel.subtitle': 'Recursive AgentFold · настройки движка',
      'engine.dsh.title': 'Стандарт',
      'engine.dsh.option': 'Стандарт',
      'engine.raf.title': 'RAF',
      'engine.raf.option': 'RAF (Recursive AgentFold)',
      'tuning.saved': 'Сохранено',
      'tuning.reset': 'Сбросить значения',
      'tuning.depth.title': 'Глубина фолдов',
      'tuning.depth.desc': 'Сколько рекурсивных фолдов может создать корень.',
      'tuning.reserve.title': 'Резерв',
      'tuning.reserve.desc': 'Доля окна читателя, свободная для промпта.',
      'tuning.concurrency.title': 'Читатели',
      'tuning.concurrency.desc': 'Параллельные вызовы llm_query по контексту.',
      'tuning.cache.title': 'Раскладка кэша',
      'tuning.cache.desc': 'Ставьте статические чанки перед запросом, чтобы prompt cache оставался тёплым.',
      'tuning.decrease': 'Уменьшить',
      'tuning.increase': 'Увеличить',
      'menu.head': 'Движок',
      'switch.aria': 'Движок: {engine}. Открыть меню движков.',
    });

    const CSS = `
.rafx-page{--rafx-ink:var(--dsw-alias-label-primary);--rafx-ink-2:var(--dsw-alias-label-secondary);--rafx-ink-3:var(--dsw-alias-label-tertiary);--rafx-line:var(--dsw-alias-border-l3);--rafx-surface:var(--dsw-alias-bg-layer-1);--rafx-surface-2:var(--dsw-alias-bg-layer-2);--rafx-business:var(--dsw-alias-state-business-primary);display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--rafx-ink);font-size:14px;line-height:1.6}
.rafx-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.rafx-content{max-width:760px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.rafx-page :focus-visible,.rafx-menu :focus-visible,.rafx-engine:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.rafx-header{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:28px;margin-bottom:18px}
[data-platform=darwin] .rafx-header{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.rafx-heading{min-width:0}
.rafx-title{margin:0;font-size:20px;font-weight:500;line-height:28px;letter-spacing:-.01em}
.rafx-subtitle{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--rafx-ink-3)}
.rafx-headerActions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rafx-saved{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--rafx-ink-3);transition:color .2s}
.rafx-saved[data-flash=true]{color:var(--dsw-alias-state-success-primary)}
.rafx-mini{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:8px;border:.5px solid var(--rafx-line);background:transparent;color:var(--rafx-ink-3);font:inherit;font-size:11.5px;cursor:pointer;transition:background .14s,color .14s}
.rafx-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--rafx-ink)}
.rafx-list{border:.5px solid var(--rafx-line);border-radius:14px;background:var(--rafx-surface);padding:0 16px}
.rafx-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:56px;padding:8px 0;border-bottom:.5px solid var(--rafx-line)}
.rafx-row:last-child{border-bottom:0}
.rafx-rowText{display:flex;flex-direction:column;gap:2px;min-width:0}
.rafx-rowLabel{font-size:13.5px;font-weight:500;line-height:20px;color:var(--rafx-ink)}
.rafx-rowControl{display:flex;align-items:center;gap:8px;flex:none;min-width:0}
.rafx-range{display:flex;align-items:center;gap:12px;width:260px;max-width:100%}
.rafx-range .rafx-slider{flex:1;min-width:0}
.rafx-value{min-width:38px;text-align:right;font-family:var(--ds-font-family-code,monospace);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--rafx-ink-2)}
.rafx-slider{width:100%;height:18px;margin:0;accent-color:var(--rafx-business);cursor:pointer}
.rafx-seg{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--rafx-surface-2)}
.rafx-segBtn{width:30px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--rafx-ink-3);font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background .14s,color .14s}
.rafx-segBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--rafx-ink)}
.rafx-segBtn[aria-pressed=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--rafx-surface));color:var(--rafx-ink);box-shadow:inset 0 0 0 .5px color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.rafx-stepper{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:10px;background:var(--rafx-surface-2)}
.rafx-stepBtn{display:grid;place-items:center;width:26px;height:24px;border:0;border-radius:8px;background:transparent;color:var(--rafx-ink-3);cursor:pointer}
.rafx-stepBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--rafx-ink)}
.rafx-stepBtn:disabled{opacity:.35;cursor:default}
.rafx-stepValue{min-width:20px;text-align:center;font-family:var(--ds-font-family-code,monospace);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums}
.rafx-switch{position:relative;flex:none;width:36px;height:20px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--rafx-surface-2);cursor:pointer;transition:background .16s,border-color .16s}
.rafx-switch[aria-checked=true]{border-color:transparent;background:var(--rafx-business)}
.rafx-switchKnob{position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground);box-shadow:0 1px 2px color-mix(in srgb,var(--rafx-ink) 22%,transparent);transition:transform .16s var(--ds-ease-in-out)}
.rafx-switch[aria-checked=true] .rafx-switchKnob{transform:translateX(16px)}
.rafx-sideIcon{position:relative;display:inline-flex;align-items:center;justify-content:center;color:currentColor}
.rafx-sideDot{position:absolute;right:-1px;bottom:-1px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill)}
.rafx-sideIcon[data-active=true]{color:var(--dsw-alias-brand-primary)}
.rafx-engine{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:220px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;transition:background .14s,color .14s}
.rafx-engine:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.rafx-engine[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.rafx-engine[data-engine=raf]{color:var(--dsw-alias-label-primary)}
.rafx-engineLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rafx-engineChevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s}
.rafx-engine[aria-expanded=true] .rafx-engineChevron{transform:rotate(180deg)}
.rafx-menu{position:fixed;z-index:1000;width:264px;max-width:calc(100vw - 24px);padding:4px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);pointer-events:auto;outline:none;animation:rafx-pop .13s var(--ds-ease-in-out)}
.rafx-option{display:flex;align-items:center;gap:8px;width:100%;height:36px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}
.rafx-option:hover,.rafx-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.rafx-option[aria-checked=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.rafx-optionLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rafx-optionCheck{display:grid;place-items:center;width:16px;height:16px;flex:none;color:var(--dsw-alias-brand-primary);opacity:0}
.rafx-option[aria-checked=true] .rafx-optionCheck{opacity:1}
@keyframes rafx-pop{from{opacity:0;transform:translateY(4px) scale(.985)}to{opacity:1;transform:none}}
@media (max-width:640px){.rafx-header{padding-top:20px}.rafx-row{flex-direction:column;align-items:stretch;gap:10px;padding:14px 0}.rafx-rowControl{justify-content:flex-start}.rafx-range{width:100%}}
@media (prefers-reduced-motion:reduce){.rafx-menu{animation:none}.rafx-switch,.rafx-switchKnob,.rafx-segBtn,.rafx-engine,.rafx-engineChevron{transition:none}}
`;

    function toEngine(value) {
      return value === ENGINE_RAF ? ENGINE_RAF : ENGINE_CONTEXTFOLD;
    }

    function toInteger(value, fallback, min, max) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
      return Math.min(max, Math.max(min, number));
    }

    function toReserve(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SETTINGS.reserve;
      const clamped = Math.min(RESERVE_MAX, Math.max(RESERVE_MIN, number));
      return Number((Math.round(clamped / RESERVE_STEP) * RESERVE_STEP).toFixed(2));
    }

    function sanitizeSettings(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return Object.freeze({
        engine: toEngine(source.engine),
        depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
        reserve: toReserve(source.reserve),
        concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
        cacheLayout: typeof source.cacheLayout === 'boolean' ? source.cacheLayout : DEFAULT_SETTINGS.cacheLayout,
      });
    }

    function parseSettings(raw) {
      if (typeof raw !== 'string') return DEFAULT_SETTINGS;
      try {
        return sanitizeSettings(JSON.parse(raw));
      } catch {
        return DEFAULT_SETTINGS;
      }
    }

    function readSettings() {
      try {
        return parseSettings(window.localStorage.getItem(SETTINGS_KEY));
      } catch {
        return DEFAULT_SETTINGS;
      }
    }

    function createSettingsStore() {
      let snapshot = DEFAULT_SETTINGS;
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      const persist = () => {
        try {
          window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(snapshot));
        } catch {
          // Storage is optional. The UI still works for this page.
        }
      };
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        hydrate() {
          snapshot = readSettings();
          emit();
        },
        update(patch) {
          snapshot = sanitizeSettings({ ...snapshot, ...patch });
          persist();
          emit();
        },
        resetTuning() {
          snapshot = sanitizeSettings({
            ...snapshot,
            depth: DEFAULT_SETTINGS.depth,
            reserve: DEFAULT_SETTINGS.reserve,
            concurrency: DEFAULT_SETTINGS.concurrency,
            cacheLayout: DEFAULT_SETTINGS.cacheLayout,
          });
          persist();
          emit();
        },
        setEngine(engine) {
          if (snapshot.engine === engine) return;
          snapshot = sanitizeSettings({ ...snapshot, engine });
          persist();
          emit();
        },
        replace(next) {
          snapshot = next;
          emit();
        },
      };
    }

    const settingsStore = createSettingsStore();

    function createMenuStore() {
      let snapshot = Object.freeze({ open: false, rect: null, trigger: null });
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      const set = (open, rect, trigger) => {
        snapshot = Object.freeze({ open, rect, trigger });
        emit();
      };
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        open(trigger) {
          if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;
          set(true, trigger.getBoundingClientRect(), trigger);
        },
        close() {
          if (!snapshot.open) return;
          set(false, null, snapshot.trigger);
        },
        refresh() {
          const trigger = snapshot.trigger;
          if (!snapshot.open || !trigger || !trigger.isConnected) return;
          snapshot = Object.freeze({ open: true, rect: trigger.getBoundingClientRect(), trigger });
          emit();
        },
      };
    }

    const menuStore = createMenuStore();

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    }

    function Svg({ size = 16, viewBox = '0 0 24 24', className, children }) {
      return h(
        'svg',
        {
          className,
          width: size,
          height: size,
          viewBox,
          fill: 'none',
          xmlns: 'http://www.w3.org/2000/svg',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        children,
      );
    }

    function RafMark({ size = 16, className }) {
      return h(
        Svg,
        { size, className },
        h('path', {
          d: 'M3.5 8.4 12 3.9l8.5 4.5-8.5 4.5-8.5-4.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M3.5 12.5 12 17l8.5-4.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          opacity: 0.62,
        }),
        h('path', {
          d: 'M3.5 16.6 12 21.1l8.5-4.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          opacity: 0.3,
        }),
      );
    }

    function ChevronGlyph({ size = 12 }) {
      return h(
        Svg,
        { size, viewBox: '0 0 12 12' },
        h('path', {
          d: 'M3 4.5 6 7.5 9 4.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function CheckGlyph({ size = 12 }) {
      return h(
        Svg,
        { size },
        h('path', {
          d: 'm5 12.5 4.2 4.2L19 6.8',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function MinusGlyph({ size = 12 }) {
      return h(Svg, { size }, h('path', { d: 'M6 12h12', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }));
    }

    function PlusGlyph({ size = 12 }) {
      return h(
        Svg,
        { size },
        h('path', { d: 'M12 6v12M6 12h12', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
      );
    }

    function ResetGlyph({ size = 13 }) {
      return h(
        Svg,
        { size },
        h('path', {
          d: 'M19 12a7 7 0 1 1-2.1-5M19 4.5V10h-5.5',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    function engineText(t, engine) {
      const prefix = engine === ENGINE_RAF ? 'engine.raf' : 'engine.dsh';
      return {
        title: t(prefix + '.title'),
        option: t(prefix + '.option'),
      };
    }

    function EngineControl({ t }) {
      const settings = useStore(settingsStore);
      const menu = useStore(menuStore);
      const ref = React.useRef(null);
      const text = engineText(t, settings.engine);
      return h(
        'button',
        {
          ref,
          type: 'button',
          className: 'rafx-engine',
          'data-engine': settings.engine,
          'aria-haspopup': 'menu',
          'aria-expanded': menu.open,
          'aria-label': t('switch.aria', { engine: text.title }),
          onClick: () => {
            if (menu.open) menuStore.close();
            else menuStore.open(ref.current);
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!menu.open) menuStore.open(ref.current);
            } else if (event.key === 'Escape' && menu.open) {
              event.preventDefault();
              menuStore.close();
            }
          },
        },
        h('span', { className: 'rafx-engineLabel' }, text.title),
        h('span', { className: 'rafx-engineChevron', 'aria-hidden': 'true' }, h(ChevronGlyph, { size: 12 })),
      );
    }

    function EngineMenu({ t }) {
      const menu = useStore(menuStore);
      const settings = useStore(settingsStore);
      const ref = React.useRef(null);
      const [pos, setPos] = React.useState(null);
      const open = menu.open;

      const closeMenu = (restoreFocus) => {
        const trigger = menuStore.getSnapshot().trigger;
        menuStore.close();
        if (!restoreFocus || !trigger || !trigger.isConnected) return;
        window.requestAnimationFrame(() => {
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        });
      };

      const choose = (engine) => {
        settingsStore.setEngine(engine);
        closeMenu(true);
      };

      React.useLayoutEffect(() => {
        if (!open) {
          setPos(null);
          return;
        }
        const node = ref.current;
        if (!node || !menu.rect) return;
        const margin = 12;
        const gap = 8;
        const width = node.offsetWidth;
        const height = node.offsetHeight;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const left = Math.min(Math.max(menu.rect.left, margin), maxLeft);
        let top = menu.rect.top - height - gap;
        let side = 'top';
        if (top < margin) {
          top = Math.max(margin, Math.min(menu.rect.bottom + gap, window.innerHeight - height - margin));
          side = 'bottom';
        }
        setPos({ left, top, side });
      }, [open, menu.rect]);

      React.useEffect(() => {
        if (!open) return;
        const node = ref.current;
        if (!node) return;
        const target =
          node.querySelector('[data-raf-option][aria-checked="true"]') || node.querySelector('[data-raf-option]');
        if (target && typeof target.focus === 'function') target.focus({ preventScroll: true });
      }, [open]);

      React.useEffect(() => {
        if (!open) return;
        const onPointerDown = (event) => {
          const node = ref.current;
          const trigger = menu.trigger;
          if (node && event.target instanceof Node && node.contains(event.target)) return;
          if (trigger && event.target instanceof Node && trigger.contains(event.target)) return;
          menuStore.close();
        };
        const onRefresh = () => menuStore.refresh();
        document.addEventListener('pointerdown', onPointerDown, true);
        window.addEventListener('scroll', onRefresh, true);
        window.addEventListener('resize', onRefresh);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          window.removeEventListener('scroll', onRefresh, true);
          window.removeEventListener('resize', onRefresh);
        };
      }, [open, menu.trigger]);

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          closeMenu(true);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const node = ref.current;
          if (!node) return;
          const items = Array.from(node.querySelectorAll('[data-raf-option]'));
          if (items.length === 0) return;
          const current = items.indexOf(document.activeElement);
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = current === -1 ? 0 : (current + delta + items.length) % items.length;
          const item = items[next];
          if (item && typeof item.focus === 'function') item.focus({ preventScroll: true });
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          const active = document.activeElement;
          if (active && typeof active.matches === 'function' && active.matches('[data-raf-option]')) {
            event.preventDefault();
            active.click();
          }
        }
      };

      if (!open) return null;

      const options = [ENGINE_CONTEXTFOLD, ENGINE_RAF].map((engine) => {
        const text = engineText(t, engine);
        const selected = settings.engine === engine;
        return h(
          'button',
          {
            key: engine,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            'data-raf-option': engine,
            className: 'rafx-option',
            onClick: () => choose(engine),
          },
          h('span', { className: 'rafx-optionLabel' }, text.option),
          h('span', { className: 'rafx-optionCheck', 'aria-hidden': 'true' }, h(CheckGlyph, { size: 14 })),
        );
      });

      return h(
        'div',
        {
          ref,
          role: 'menu',
          'aria-label': t('menu.head'),
          className: 'rafx-menu',
          'data-side': pos ? pos.side : undefined,
          style: pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' },
          onKeyDown,
          onBlur: (event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && ref.current && ref.current.contains(next)) return;
            menuStore.close();
          },
        },
        options,
      );
    }

    function RafIcon({ size = 18, active = false }) {
      const settings = useStore(settingsStore);
      const rafOn = settings.engine === ENGINE_RAF;
      return h(
        'span',
        {
          className: 'rafx-sideIcon',
          'data-active': active ? 'true' : undefined,
          'data-raf': rafOn ? 'true' : undefined,
          style: { width: size, height: size },
        },
        h(RafMark, { size }),
        rafOn ? h('span', { className: 'rafx-sideDot', 'aria-hidden': 'true' }) : null,
      );
    }

    function Segmented({ label, value, options, onChange }) {
      return h(
        'div',
        { className: 'rafx-seg', role: 'group', 'aria-label': label },
        options.map((option) =>
          h(
            'button',
            {
              key: option,
              type: 'button',
              className: 'rafx-segBtn',
              'aria-pressed': option === value,
              onClick: () => onChange(option),
            },
            String(option),
          ),
        ),
      );
    }

    function Stepper({ t, label, value, min, max, onChange }) {
      return h(
        'div',
        { className: 'rafx-stepper', role: 'group', 'aria-label': label },
        h(
          'button',
          {
            type: 'button',
            className: 'rafx-stepBtn',
            'aria-label': t('tuning.decrease') + ': ' + label,
            disabled: value <= min,
            onClick: () => onChange(Math.max(min, value - 1)),
          },
          h(MinusGlyph, { size: 12 }),
        ),
        h('span', { className: 'rafx-stepValue', 'aria-live': 'polite' }, String(value)),
        h(
          'button',
          {
            type: 'button',
            className: 'rafx-stepBtn',
            'aria-label': t('tuning.increase') + ': ' + label,
            disabled: value >= max,
            onClick: () => onChange(Math.min(max, value + 1)),
          },
          h(PlusGlyph, { size: 12 }),
        ),
      );
    }

    function Switch({ label, checked, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          className: 'rafx-switch',
          'aria-checked': checked,
          'aria-label': label,
          onClick: () => onChange(!checked),
        },
        h('span', { className: 'rafx-switchKnob', 'aria-hidden': 'true' }),
      );
    }

    function SettingRow({ label, hint, control }) {
      return h(
        'div',
        { className: 'rafx-row' },
        h(
          'div',
          { className: 'rafx-rowText' },
          h('span', { className: 'rafx-rowLabel', title: hint }, label),
        ),
        h('div', { className: 'rafx-rowControl' }, control),
      );
    }

    function RafPanel({ t }) {
      const settings = useStore(settingsStore);
      const [flash, setFlash] = React.useState(false);
      const first = React.useRef(true);
      React.useEffect(() => {
        if (first.current) {
          first.current = false;
          return;
        }
        setFlash(true);
        const timer = window.setTimeout(() => setFlash(false), 1400);
        return () => window.clearTimeout(timer);
      }, [settings]);

      const percent = Math.round(settings.reserve * 100);
      return h(
        'section',
        { className: 'rafx-page', 'aria-label': t('panel.title') },
        h(
          'div',
          { className: 'rafx-scroll' },
          h(
            'div',
            { className: 'rafx-content' },
            h(
              'header',
              { className: 'rafx-header' },
              h(
                'div',
                { className: 'rafx-heading' },
                h('h1', { className: 'rafx-title' }, t('panel.label')),
                h('p', { className: 'rafx-subtitle' }, t('panel.subtitle')),
              ),
              h(
                'div',
                { className: 'rafx-headerActions' },
                h(
                  'span',
                  { className: 'rafx-saved', 'data-flash': flash ? 'true' : undefined },
                  h(CheckGlyph, { size: 12 }),
                  t('tuning.saved'),
                ),
                h(
                  'button',
                  { type: 'button', className: 'rafx-mini', onClick: () => settingsStore.resetTuning() },
                  h(ResetGlyph, { size: 13 }),
                  t('tuning.reset'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'rafx-list' },
              h(SettingRow, {
                label: t('tuning.depth.title'),
                hint: t('tuning.depth.desc'),
                control: h(Segmented, {
                  label: t('tuning.depth.title'),
                  value: settings.depth,
                  options: [DEPTH_MIN, DEPTH_MIN + 1, DEPTH_MAX],
                  onChange: (value) => settingsStore.update({ depth: value }),
                }),
              }),
              h(SettingRow, {
                label: t('tuning.reserve.title'),
                hint: t('tuning.reserve.desc'),
                control: h(
                  'div',
                  { className: 'rafx-range' },
                  h('span', { className: 'rafx-value' }, percent + '%'),
                  h('input', {
                    type: 'range',
                    className: 'rafx-slider',
                    min: RESERVE_MIN,
                    max: RESERVE_MAX,
                    step: RESERVE_STEP,
                    value: settings.reserve,
                    'aria-label': t('tuning.reserve.title'),
                    'aria-valuetext': percent + '%',
                    onChange: (event) => settingsStore.update({ reserve: Number(event.target.value) }),
                  }),
                ),
              }),
              h(SettingRow, {
                label: t('tuning.concurrency.title'),
                hint: t('tuning.concurrency.desc'),
                control: h(Stepper, {
                  t,
                  label: t('tuning.concurrency.title'),
                  value: settings.concurrency,
                  min: CONCURRENCY_MIN,
                  max: CONCURRENCY_MAX,
                  onChange: (value) => settingsStore.update({ concurrency: value }),
                }),
              }),
              h(SettingRow, {
                label: t('tuning.cache.title'),
                hint: t('tuning.cache.desc'),
                control: h(Switch, {
                  label: t('tuning.cache.title'),
                  checked: settings.cacheLayout,
                  onChange: (value) => settingsStore.update({ cacheLayout: value }),
                }),
              }),
            ),
          ),
        ),
      );
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.dataset.raf = 'styles';
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'raf: styles');

      ctx.effect(() => ctx.locale.register(NS, { en: EN, ru: RU }), 'raf: dictionaries');
      const t = ctx.locale.bind(NS);

      settingsStore.hydrate();

      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key !== SETTINGS_KEY) return;
          settingsStore.replace(event.newValue === null ? DEFAULT_SETTINGS : parseSettings(event.newValue));
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
      }, 'raf: settings sync');

      ctx.effect(
        () =>
          ctx.slots.inject('main', () =>
            ctx.slots.register(
              {
                name: 'main',
                key: PANEL_ID,
                locale: NS,
              },
              RafPanel,
            ),
          ),
        'raf: settings panel',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.panellist', () =>
            ctx.slots.register(
              {
                name: 'sidebar.panellist',
                id: PANEL_ID,
                order: 5,
                locale: NS,
                label: () => t('panel.label'),
              },
              RafIcon,
            ),
          ),
        'raf: sidebar entry',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.left',
                id: 'raf-engine',
                order: 10,
                locale: NS,
              },
              EngineControl,
            ),
          ),
        'raf: composer switch',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register(
              {
                name: 'shell.overlay',
                id: 'raf-engine-menu',
                order: 20,
                locale: NS,
              },
              EngineMenu,
            ),
          ),
        'raf: engine menu',
      );
    }

    return {
      inject: ['slots', 'locale'],
      apply,
    };
  },
});
