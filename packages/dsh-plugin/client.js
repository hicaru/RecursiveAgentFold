window.__ModuleLoader__.load({
  id: '@raf/dsh-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'raf';
    const PANEL_ID = 'raf';
    const SETTINGS_KEY = 'raf.dsh.settings.v2';
    const ENGINES_KEY = 'raf.dsh.engines.v1';
    const ENGINE_API = '/plugins/@raf/dsh-plugin/engine';
    const RUNS_API = '/plugins/@raf/dsh-plugin/runs';
    const ENGINE_STANDARD = 'standard';
    const ENGINE_RAF = 'raf';

    const DEPTH_MIN = 1;
    const DEPTH_MAX = 3;
    const RESERVE_MIN = 0.1;
    const RESERVE_MAX = 0.5;
    const RESERVE_STEP = 0.05;
    const CONCURRENCY_MIN = 1;
    const CONCURRENCY_MAX = 8;

    const DEFAULT_SETTINGS = Object.freeze({
      depth: 2,
      reserve: 0.3,
      concurrency: 4,
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
      'tuning.decrease': 'Decrease',
      'tuning.increase': 'Increase',
      'menu.head': 'Engine',
      'switch.aria': 'Engine: {engine}. Open the engine menu.',
      'view.label': 'RAF',
      'view.emptyTitle': 'No RAF runs in this session',
      'view.emptyHint': 'Switch the composer engine to RAF and send a task.',
      'view.selectRun': 'Run',
      'view.status.running': 'Running',
      'view.status.done': 'Done',
      'view.status.error': 'Error',
      'view.status.aborted': 'Stopped',
      'view.agents': 'Agents',
      'view.steps': 'Steps',
      'view.tokens': 'Tokens',
      'view.cache': 'Cache',
      'view.duration': 'Duration',
      'view.model': 'Model',
      'view.settings': 'Settings',
      'view.question': 'Question',
      'view.answer': 'Answer',
      'view.thinking': 'Response',
      'view.reasoning': 'Reasoning',
      'view.fold': 'Fold',
      'view.tool': 'Tool',
      'view.result': 'Result',
      'view.arguments': 'Arguments',
      'view.noSteps': 'No steps',
      'view.noEvents': 'The run has no events yet.',
      'view.live': 'Live',
      'view.root': 'Root',
      'view.errorLabel': 'Error',
      'view.llmCalls': 'LLM calls',
      'view.openAgent': 'Open subagent',
      'view.parent': 'Back',
      'live.all': 'All agents',
      'live.waiting': 'Waiting for the first step…',
      'live.started': 'started',
      'live.finished': 'finished',
      'live.steps': '{count} steps',
      'live.step': 'step {step}',
      'live.fold': 'fold',
      'live.answer': 'answer',
      'live.error': 'error',
      'live.collapse': 'Collapse',
      'live.expand': 'Expand',
      'live.close': 'Close',
      'live.motivation': 'motivation',
      'live.truncated': 'Showing the latest activity.',
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
      'tuning.decrease': 'Уменьшить',
      'tuning.increase': 'Увеличить',
      'menu.head': 'Движок',
      'switch.aria': 'Движок: {engine}. Открыть меню движков.',
      'view.label': 'RAF',
      'view.emptyTitle': 'В этой сессии ещё нет запусков RAF',
      'view.emptyHint': 'Переключи движок в композере на RAF и отправь задачу.',
      'view.selectRun': 'Запуск',
      'view.status.running': 'Выполняется',
      'view.status.done': 'Готово',
      'view.status.error': 'Ошибка',
      'view.status.aborted': 'Остановлено',
      'view.agents': 'Агенты',
      'view.steps': 'Шаги',
      'view.tokens': 'Токены',
      'view.cache': 'Кэш',
      'view.duration': 'Время',
      'view.model': 'Модель',
      'view.settings': 'Настройки',
      'view.question': 'Вопрос',
      'view.answer': 'Ответ',
      'view.thinking': 'Ответ модели',
      'view.reasoning': 'Рассуждение',
      'view.fold': 'Фолд',
      'view.tool': 'Инструмент',
      'view.result': 'Результат',
      'view.arguments': 'Аргументы',
      'view.noSteps': 'Шагов нет',
      'view.noEvents': 'У запуска пока нет событий.',
      'view.live': 'Live',
      'view.root': 'Корень',
      'view.errorLabel': 'Ошибка',
      'view.llmCalls': 'Вызовы LLM',
      'view.openAgent': 'Открыть суб-агента',
      'view.parent': 'Назад',
      'live.all': 'Все агенты',
      'live.waiting': 'Ждём первый шаг…',
      'live.started': 'старт',
      'live.finished': 'финиш',
      'live.steps': '{count} шагов',
      'live.step': 'шаг {step}',
      'live.fold': 'фолд',
      'live.answer': 'ответ',
      'live.error': 'ошибка',
      'live.collapse': 'Свернуть',
      'live.expand': 'Развернуть',
      'live.close': 'Закрыть',
      'live.motivation': 'мотивация',
      'live.truncated': 'Показаны последние события.',
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
.rafx-row{display:flex;align-items:center;justify-content:space-between;gap:24px;min-height:64px;padding:10px 0;border-bottom:.5px solid var(--rafx-line)}
.rafx-row:last-child{border-bottom:0}
.rafx-rowText{display:flex;flex:1 1 auto;flex-direction:column;gap:3px;min-width:0;padding-right:16px}
.rafx-rowLabel{font-size:13.5px;font-weight:500;line-height:20px;color:var(--rafx-ink)}
.rafx-rowDesc{font-size:12px;line-height:18px;color:var(--rafx-ink-3)}
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
.rafx-sideIcon{position:relative;display:inline-flex;align-items:center;justify-content:center;color:currentColor}
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
@media (prefers-reduced-motion:reduce){.rafx-menu{animation:none}.rafx-segBtn,.rafx-engine,.rafx-engineChevron{transition:none}}
.rafx-runs{padding:0}
.rafx-runsTop{flex:none;padding:16px 20px 12px;border-bottom:.5px solid var(--rafx-line);display:flex;flex-direction:column;gap:12px}
.rafx-runsTopMain{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.rafx-runsTitle{flex:1 1 420px;min-width:0}
.rafx-runsHeading{margin:0;font-size:18px;font-weight:600;line-height:24px;letter-spacing:-.01em}
.rafx-runsQuestion{max-width:90ch;margin:2px 0 0;font-size:13px;line-height:19px;color:var(--rafx-ink-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rafx-runsMeta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}
.rafx-runsChip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border:.5px solid var(--rafx-line);border-radius:6px;background:var(--rafx-surface-2);color:var(--rafx-ink-3);font-size:11px;line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap}
.rafx-runsChip[data-status=running]{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent)}
.rafx-runsChip[data-status=done]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 28%,transparent)}
.rafx-runsChip[data-status=error]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 28%,transparent)}
.rafx-runsDot{width:5px;height:5px;border-radius:50%;background:currentColor}
.rafx-runsChip[data-status=running] .rafx-runsDot{animation:rafx-pulse 1.4s ease-in-out infinite}
.rafx-runsActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rafx-runsSelectWrap{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--rafx-ink-3)}
.rafx-runsSelect{box-sizing:border-box;max-width:360px;height:28px;padding:0 6px;border:.5px solid var(--rafx-line);border-radius:7px;background:var(--rafx-surface);color:var(--rafx-ink);font:inherit;font-size:11.5px;cursor:pointer}
.rafx-runsSelect:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--rafx-business));outline-offset:1px}
.rafx-runsStats{display:flex;gap:8px;flex-wrap:wrap}
.rafx-runsStat{min-width:86px;padding:6px 10px;border:.5px solid var(--rafx-line);border-radius:8px;background:var(--rafx-surface)}
.rafx-runsStatValue{display:block;font-family:var(--ds-font-family-code,monospace);font-size:12px;font-weight:600;line-height:16px;font-variant-numeric:tabular-nums;color:var(--rafx-ink)}
.rafx-runsStatLabel{display:block;margin-top:1px;font-size:9.5px;line-height:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.rafx-runsNotice{padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere}
.rafx-runsBody{display:grid;grid-template-columns:230px minmax(0,1fr);flex:1;min-height:0;overflow:hidden}
.rafx-agents{display:flex;flex-direction:column;min-height:0;border-right:.5px solid var(--rafx-line);background:color-mix(in srgb,var(--rafx-surface) 55%,transparent)}
.rafx-agentsHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px 6px;font-size:10px;font-weight:600;line-height:14px;letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.rafx-agentsCount{font-variant-numeric:tabular-nums;letter-spacing:0}
.rafx-agentList{display:flex;flex-direction:column;gap:1px;min-height:0;overflow:auto;padding:0 6px 10px}
.rafx-agent{display:flex;align-items:center;gap:7px;width:100%;min-height:34px;padding:5px 6px;border:0;border-radius:7px;background:transparent;color:var(--rafx-ink-2);font:inherit;text-align:left;cursor:pointer}
.rafx-agent:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rafx-agent[data-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--rafx-ink)}
.rafx-agentDot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dsw-alias-label-caption)}
.rafx-agentDot[data-status=running]{background:var(--dsw-alias-state-business-primary);animation:rafx-pulse 1.4s ease-in-out infinite}
.rafx-agentDot[data-status=error]{background:var(--dsw-alias-state-error-primary)}
.rafx-agentDot[data-status=done]{background:var(--dsw-alias-state-success-primary)}
.rafx-agentBody{display:flex;flex-direction:column;gap:1px;min-width:0}
.rafx-agentName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:600;line-height:16px}
.rafx-agentMeta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-timeline{min-height:0;overflow:auto;padding:14px 20px 48px}
.rafx-agentHead{display:flex;flex-direction:column;gap:3px;margin-bottom:12px}
.rafx-agentHeadTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rafx-agentHeadTitle h2{margin:0;font-size:15px;font-weight:600;line-height:22px}
.rafx-agentDepth,.rafx-agentState{padding:0 5px;border:.5px solid var(--rafx-line);border-radius:5px;background:var(--rafx-surface-2);color:var(--rafx-ink-3);font-family:var(--ds-font-family-code,monospace);font-size:9.5px;line-height:16px}
.rafx-agentState[data-status=error]{color:var(--dsw-alias-state-error-primary)}
.rafx-agentState[data-status=running]{color:var(--dsw-alias-state-business-primary)}
.rafx-agentHeadMeta{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-linkButton{align-self:flex-start;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11.5px;line-height:18px;cursor:pointer}
.rafx-linkButton:hover{text-decoration:underline}
.rafx-step{display:flex;flex-direction:column;gap:8px;margin-bottom:10px;padding:10px 12px;border:.5px solid var(--rafx-line);border-radius:10px;background:var(--rafx-surface)}
.rafx-stepHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rafx-stepTag{padding:0 5px;border-radius:4px;background:var(--rafx-surface-2);color:var(--rafx-ink-2);font-family:var(--ds-font-family-code,monospace);font-size:10.5px;font-weight:600;line-height:18px}
.rafx-stepMeta{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-response{border:.5px solid var(--rafx-line);border-radius:8px;background:var(--rafx-surface-2);padding:0 8px}
.rafx-response summary,.rafx-llm summary{display:flex;align-items:center;gap:8px;min-height:28px;cursor:pointer;font-size:11.5px;font-weight:500;line-height:18px;color:var(--rafx-ink-2);list-style:none}
.rafx-response summary::-webkit-details-marker,.rafx-llm summary::-webkit-details-marker{display:none}
.rafx-llmMeta{margin-left:auto;font-family:var(--ds-font-family-code,monospace);font-size:10px;font-weight:400;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-response[open],.rafx-llm[open]{padding-bottom:8px}
.rafx-pre{margin:0;padding:8px;border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--rafx-ink-2);font-family:var(--ds-font-family-code,monospace);font-size:10.5px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto}
.rafx-field{display:flex;flex-direction:column;gap:4px;margin-top:6px}
.rafx-fieldLabel{font-size:9.5px;font-weight:600;line-height:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption)}
.rafx-fold{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px;padding:7px 9px;border-left:2px solid var(--dsw-alias-brand-primary);border-radius:0 6px 6px 0;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}
.rafx-foldTag{font-size:9.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-brand-primary)}
.rafx-foldRange{font-family:var(--ds-font-family-code,monospace);font-size:10px;color:var(--dsw-alias-label-caption)}
.rafx-foldSummary{flex-basis:100%;margin:0;font-size:11.5px;line-height:17px;color:var(--rafx-ink-2);overflow-wrap:anywhere}
.rafx-foldCorrection{flex-basis:100%;margin:0;font-size:10.5px;line-height:15px;color:var(--dsw-alias-state-warn-primary)}
.rafx-tools{display:flex;flex-direction:column;gap:3px}
.rafx-toolWrap{border:.5px solid var(--rafx-line);border-radius:7px;overflow:hidden;background:var(--dsw-alias-bg-base)}
.rafx-tool{display:flex;align-items:center;gap:7px;width:100%;min-height:30px;padding:3px 7px;border:0;background:transparent;color:var(--rafx-ink-2);font:inherit;text-align:left;cursor:pointer}
.rafx-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rafx-toolGlyph{display:grid;place-items:center;width:22px;height:22px;flex:none;border-radius:5px;background:var(--rafx-surface-2);color:var(--dsw-alias-label-caption);font-family:var(--ds-font-family-code,monospace);font-size:8.5px;font-weight:700;letter-spacing:-.03em}
.rafx-tool[data-tool=llm_query] .rafx-toolGlyph{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent)}
.rafx-tool[data-tool=branch] .rafx-toolGlyph{color:var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent)}
.rafx-tool[data-tool=grep] .rafx-toolGlyph,.rafx-tool[data-tool=read] .rafx-toolGlyph{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.rafx-toolName{font-family:var(--ds-font-family-code,monospace);font-size:11px;font-weight:600;line-height:16px;color:var(--rafx-ink)}
.rafx-toolMeta{margin-left:auto;font-family:var(--ds-font-family-code,monospace);font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-toolChevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-caption);transition:transform .12s}
.rafx-tool[aria-expanded=true] .rafx-toolChevron{transform:rotate(180deg)}
.rafx-tool[data-status=running] .rafx-toolName{color:var(--dsw-alias-state-business-primary)}
.rafx-tool[data-status=error] .rafx-toolName{color:var(--dsw-alias-state-error-primary)}
.rafx-toolBody{padding:0 8px 8px}
.rafx-hint{margin-top:6px;font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-caption)}
.rafx-error{padding:6px 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,monospace);font-size:10.5px;line-height:16px;white-space:pre-wrap;overflow-wrap:anywhere}
.rafx-queries{display:flex;flex-direction:column;gap:4px}
.rafx-query{padding:6px 8px;border-radius:6px;background:var(--rafx-surface-2)}
.rafx-queryName{font-family:var(--ds-font-family-code,monospace);font-size:10.5px;font-weight:600;color:var(--dsw-alias-brand-primary)}
.rafx-queryMeta{margin-left:6px;font-family:var(--ds-font-family-code,monospace);font-size:9.5px;color:var(--dsw-alias-label-caption)}
.rafx-queryText{margin:2px 0 0;font-size:10.5px;line-height:15px;color:var(--rafx-ink-3);overflow-wrap:anywhere}
.rafx-llm{border:.5px solid var(--rafx-line);border-radius:8px;background:var(--rafx-surface-2);padding:0 8px}
.rafx-llmRows{display:flex;flex-direction:column}
.rafx-llmRow{display:flex;gap:10px;flex-wrap:wrap;padding:3px 0;border-top:.5px solid var(--rafx-line);font-family:var(--ds-font-family-code,monospace);font-size:9.5px;line-height:14px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.rafx-llmRole{color:var(--rafx-ink-2);font-weight:600}
.rafx-llmModel{color:var(--rafx-ink-3)}
.rafx-answer{display:flex;flex-direction:column;gap:3px;padding:7px 9px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.rafx-answer p{margin:0;font-size:12px;line-height:18px;color:var(--rafx-ink);white-space:pre-wrap;overflow-wrap:anywhere}
.rafx-timelineEmpty,.rafx-runsEmpty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-height:180px;padding:24px;text-align:center;color:var(--dsw-alias-label-caption)}
.rafx-runsEmpty{flex:1}
.rafx-runsEmpty h2{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--rafx-ink-3)}
.rafx-runsEmpty p{margin:0;font-size:12px;line-height:18px;max-width:44ch}
.rafx-agentErrors{display:flex;flex-direction:column;gap:4px;margin-top:8px}
@keyframes rafx-pulse{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}
@media (max-width:820px){.rafx-runsBody{grid-template-columns:1fr}.rafx-agents{max-height:150px;border-right:0;border-bottom:.5px solid var(--rafx-line)}.rafx-agentList{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}.rafx-timeline{padding:12px 14px 40px}.rafx-runsTop{padding:12px 14px 10px}}
@media (prefers-reduced-motion:reduce){.rafx-runsChip[data-status=running] .rafx-runsDot,.rafx-agentDot[data-status=running]{animation:none}}

.rafx-live{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);flex:none;margin:0 auto;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-panel);color:var(--dsw-alias-label-secondary);overflow:hidden;font-size:13px;line-height:20px}
.rafx-live :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.rafx-liveHead{display:flex;align-items:center;gap:8px;min-height:36px;padding:6px 12px;flex-wrap:nowrap}
.rafx-liveTitle{flex:none;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}
.rafx-liveStatus{display:inline-flex;align-items:center;gap:5px;flex:none;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;white-space:nowrap}
.rafx-liveDot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.rafx-liveStatus[data-status=running] .rafx-liveDot{background:var(--dsw-alias-state-business-primary);animation:rafx-pulse 1.4s ease-in-out infinite}
.rafx-liveStatus[data-status=done] .rafx-liveDot{background:var(--dsw-alias-state-success-primary)}
.rafx-liveStatus[data-status=error] .rafx-liveDot{background:var(--dsw-alias-state-error-primary)}
.rafx-liveStatus[data-status=aborted] .rafx-liveDot{background:var(--dsw-alias-state-warn-primary)}
.rafx-liveQuestion{flex:1 1 120px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.rafx-liveMeta{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;white-space:nowrap;font-variant-numeric:tabular-nums}
.rafx-liveActions{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto}
.rafx-liveIcon{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:15px;line-height:20px;cursor:pointer}
.rafx-liveIcon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.rafx-liveChevronButton{display:inline-flex;color:inherit;transition:transform .12s}
.rafx-liveChevronButton[data-collapsed=true]{transform:rotate(180deg)}
.rafx-liveAgents{display:flex;align-items:center;gap:12px;overflow-x:auto;padding:0 12px 6px;scrollbar-width:none}
.rafx-liveAgents::-webkit-scrollbar{display:none}
.rafx-liveAgentChip{display:inline-flex;align-items:center;gap:5px;flex:none;height:20px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12.5px;line-height:20px;cursor:pointer;white-space:nowrap}
.rafx-liveAgentChip:hover{color:var(--dsw-alias-label-primary)}
.rafx-liveAgentChip[data-selected=true]{color:var(--dsw-alias-label-primary);font-weight:500}
.rafx-liveAgentDot{width:4px;height:4px;flex:none;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.rafx-liveAgentDot[data-status=running]{background:var(--dsw-alias-state-business-primary);animation:rafx-pulse 1.4s ease-in-out infinite}
.rafx-liveAgentDot[data-status=error]{background:var(--dsw-alias-state-error-primary)}
.rafx-liveAgentDot[data-status=done]{background:var(--dsw-alias-state-success-primary)}
.rafx-liveFeed{display:flex;flex-direction:column;gap:1px;max-height:220px;overflow:auto;padding:0 12px 8px;scrollbar-gutter:stable;--dsh-scrollbar-width:8px;--dsh-scrollbar-thumb-border:2px}
.rafx-liveItem{display:flex;flex-direction:column;min-width:0}
.rafx-liveRow{display:flex;align-items:center;gap:7px;width:100%;min-width:0;min-height:26px;padding:2px 4px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:20px;text-align:left;cursor:pointer}
.rafx-liveRow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.rafx-liveRow[data-kind=agent-start],.rafx-liveRow[data-kind=agent-end]{min-height:24px;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:default}
.rafx-liveRow[data-kind=agent-start]:hover,.rafx-liveRow[data-kind=agent-end]:hover{background:transparent}
.rafx-liveRow .rafx-liveMeta{font-size:11px}
.rafx-liveAgentTag{flex:none;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:20px}
.rafx-liveAgentTag[data-depth="0"]{color:var(--dsw-alias-label-secondary);font-weight:500}
.rafx-liveStep{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:20px}
.rafx-liveText{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.rafx-liveEnd{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:20px}
.rafx-liveName{flex:none;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,monospace);font-size:11.5px;font-weight:600;line-height:20px}
.rafx-livePreview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:20px}
.rafx-liveKind{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}
.rafx-liveKind[data-kind=answer]{color:var(--dsw-alias-label-secondary)}
.rafx-liveKind[data-kind=error]{color:var(--dsw-alias-state-error-primary)}
.rafx-liveRange{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:10.5px;line-height:20px}
.rafx-liveLive{display:inline-flex;flex:none;margin-left:auto}
.rafx-liveChevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-tertiary)}
.rafx-liveBody{display:flex;flex-direction:column;gap:4px;padding:2px 4px 7px}
.rafx-liveLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.rafx-livePre{margin:0;padding:7px 8px;border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.rafx-liveNote{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.rafx-liveMetaLine{color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:10.5px;line-height:16px}
.rafx-liveError{margin:0;color:var(--dsw-alias-state-error-primary);font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:17px;white-space:pre-wrap;overflow-wrap:anywhere}
.rafx-liveEmpty{padding:2px 0 8px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:20px}
.rafx-liveTruncated{padding:2px 4px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
@media (max-width:760px){.rafx-liveQuestion{display:none}.rafx-liveMeta{display:none}.rafx-liveFeed{max-height:180px}}
@media (prefers-reduced-motion:reduce){.rafx-liveStatus[data-status=running] .rafx-liveDot,.rafx-liveAgentDot[data-status=running],.rafx-liveChevronButton{animation:none;transition:none}}

`;

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
        depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
        reserve: toReserve(source.reserve),
        concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
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
          queueSettingsSync();
        },
        resetTuning() {
          snapshot = sanitizeSettings({
            ...snapshot,
            depth: DEFAULT_SETTINGS.depth,
            reserve: DEFAULT_SETTINGS.reserve,
            concurrency: DEFAULT_SETTINGS.concurrency,
          });
          persist();
          emit();
          queueSettingsSync();
        },
        replace(next) {
          snapshot = next;
          emit();
        },
      };
    }

    const settingsStore = createSettingsStore();

    const touchedEngines = new Set();

    function sanitizeEngine(value) {
      return value === ENGINE_RAF ? ENGINE_RAF : ENGINE_STANDARD;
    }

    function readEngines() {
      try {
        const raw = window.localStorage.getItem(ENGINES_KEY);
        if (raw === null) return Object.freeze({});
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object') return Object.freeze({});
        const next = {};
        for (const [sessionId, value] of Object.entries(parsed)) {
          if (typeof sessionId === 'string' && sessionId) next[sessionId] = sanitizeEngine(value);
        }
        return Object.freeze(next);
      } catch {
        return Object.freeze({});
      }
    }

    function createEngineStore() {
      let snapshot = readEngines();
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      const persist = () => {
        try {
          window.localStorage.setItem(ENGINES_KEY, JSON.stringify(snapshot));
        } catch {
          // Storage is optional. The Host state still applies.
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
        get(sessionId) {
          if (typeof sessionId !== 'string' || !sessionId) return ENGINE_STANDARD;
          return sanitizeEngine(snapshot[sessionId]);
        },
        set(sessionId, engine) {
          if (typeof sessionId !== 'string' || !sessionId) return;
          const next = sanitizeEngine(engine);
          if (sanitizeEngine(snapshot[sessionId]) === next) return;
          const draft = { ...snapshot };
          if (next === ENGINE_STANDARD) delete draft[sessionId];
          else draft[sessionId] = next;
          snapshot = Object.freeze(draft);
          persist();
          emit();
        },
        replace(next) {
          if (next === null || typeof next !== 'object') return;
          const draft = {};
          for (const [sessionId, value] of Object.entries(next)) {
            if (typeof sessionId === 'string' && sessionId) draft[sessionId] = sanitizeEngine(value);
          }
          snapshot = Object.freeze(draft);
          emit();
        },
      };
    }

    const engineStore = createEngineStore();

    function useEngine(sessionId) {
      return React.useSyncExternalStore(engineStore.subscribe, () => engineStore.get(sessionId));
    }

    function requestHost(method, payload, query, path = ENGINE_API) {
      if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'));
      const suffix = query === undefined ? '' : '?' + query;
      const init = { method, credentials: 'same-origin' };
      if (payload !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(payload);
      }
      return fetch(path + suffix, init).then((response) => {
        if (!response.ok) throw new Error('RAF host request failed: ' + response.status);
        return response.json();
      });
    }

    function getRuns(sessionId) {
      return requestHost('GET', undefined, 'sessionId=' + encodeURIComponent(sessionId), RUNS_API).then((data) =>
        Array.isArray(data.runs) ? data.runs : [],
      );
    }

    function getRun(id) {
      return requestHost('GET', undefined, undefined, RUNS_API + '/' + encodeURIComponent(id));
    }

    function getHostEngine(sessionId) {
      return requestHost('GET', undefined, 'sessionId=' + encodeURIComponent(sessionId)).then((data) =>
        sanitizeEngine(data.engine),
      );
    }

    function postHostEngine(sessionId, engine) {
      return requestHost('POST', { sessionId, engine, settings: settingsStore.getSnapshot() });
    }

    function postHostSettings(settings) {
      return requestHost('POST', { settings });
    }

    let settingsSyncTimer = 0;

    function queueSettingsSync() {
      if (settingsSyncTimer !== 0) window.clearTimeout(settingsSyncTimer);
      settingsSyncTimer = window.setTimeout(() => {
        settingsSyncTimer = 0;
        void postHostSettings(settingsStore.getSnapshot()).catch(() => {});
      }, 200);
    }

    function createMenuStore() {
      let snapshot = Object.freeze({ open: false, rect: null, trigger: null, sessionId: null });
      const listeners = new Set();
      const emit = () => {
        for (const listener of listeners) listener();
      };
      const set = (open, rect, trigger, sessionId) => {
        snapshot = Object.freeze({ open, rect, trigger, sessionId });
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
        open(trigger, sessionId) {
          if (!trigger || typeof trigger.getBoundingClientRect !== 'function') return;
          set(true, trigger.getBoundingClientRect(), trigger, typeof sessionId === 'string' ? sessionId : null);
        },
        close() {
          if (!snapshot.open) return;
          set(false, null, snapshot.trigger, snapshot.sessionId);
        },
        refresh() {
          const trigger = snapshot.trigger;
          if (!snapshot.open || !trigger || !trigger.isConnected) return;
          snapshot = Object.freeze({ open: true, rect: trigger.getBoundingClientRect(), trigger, sessionId: snapshot.sessionId });
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

    function EngineControl({ t, sessionId }) {
      const engine = useEngine(sessionId);
      const menu = useStore(menuStore);
      const ref = React.useRef(null);
      const text = engineText(t, engine);

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        let active = true;
        void getHostEngine(sessionId)
          .then((hostEngine) => {
            if (active && !touchedEngines.has(sessionId)) engineStore.set(sessionId, hostEngine);
          })
          .catch(() => {});
        return () => {
          active = false;
        };
      }, [sessionId]);

      return h(
        'button',
        {
          ref,
          type: 'button',
          className: 'rafx-engine',
          'data-engine': engine,
          'aria-haspopup': 'menu',
          'aria-expanded': menu.open,
          'aria-label': t('switch.aria', { engine: text.title }),
          onClick: () => {
            if (menu.open) menuStore.close();
            else menuStore.open(ref.current, sessionId);
          },
          onKeyDown: (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              if (!menu.open) menuStore.open(ref.current, sessionId);
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
      const sessionId = menu.sessionId;
      const engine = useEngine(sessionId);
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

      const choose = (nextEngine) => {
        if (typeof sessionId !== 'string' || !sessionId) {
          closeMenu(true);
          return;
        }
        const previous = engineStore.get(sessionId);
        touchedEngines.add(sessionId);
        engineStore.set(sessionId, nextEngine);
        closeMenu(true);
        void postHostEngine(sessionId, nextEngine).catch(() => {
          engineStore.set(sessionId, previous);
          console.error('RAF: engine switch failed');
        });
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

      const options = [ENGINE_STANDARD, ENGINE_RAF].map((option) => {
        const text = engineText(t, option);
        const selected = engine === option;
        return h(
          'button',
          {
            key: engine,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': selected,
            'data-raf-option': option,
            className: 'rafx-option',
            onClick: () => choose(option),
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
      return h(
        'span',
        {
          className: 'rafx-sideIcon',
          'data-active': active ? 'true' : undefined,
          style: { width: size, height: size },
        },
        h(RafMark, { size }),
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

    function SettingRow({ label, hint, control }) {
      return h(
        'div',
        { className: 'rafx-row' },
        h(
          'div',
          { className: 'rafx-rowText' },
          h('span', { className: 'rafx-rowLabel' }, label),
          hint ? h('span', { className: 'rafx-rowDesc' }, hint) : null,
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
            ),
          ),
        ),
      );
    }


    const TOOL_BADGES = Object.freeze({
      llm_query: 'LQ',
      grep: 'GR',
      read: 'RD',
      tally: 'TL',
      branch: 'BR',
      calculator: '±',
    });

    function formatTokens(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      if (number >= 1000000) return `${(number / 1000000).toFixed(2)}M`;
      if (number >= 1000) return `${(number / 1000).toFixed(1)}k`;
      return String(Math.round(number));
    }

    function formatPercent(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      return `${Math.round(number * 100)}%`;
    }

    function formatDuration(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
      if (number < 1000) return `${Math.round(number)} ms`;
      if (number < 60000) return `${(number / 1000).toFixed(1)} s`;
      return `${Math.floor(number / 60000)}m ${Math.round((number % 60000) / 1000)}s`;
    }

    function formatClock(value) {
      const number = typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
      return new Date(number).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function shortValue(value, limit) {
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
      if (typeof text !== 'string') return '';
      return text.length > limit ? `${text.slice(0, limit)}…` : text;
    }

    function prettyJson(value) {
      return shortValue(value, 6000);
    }

    function toolBadge(name) {
      if (typeof name !== 'string') return '?';
      const base = name.startsWith('dsh_') ? name.slice(4) : name;
      const known = TOOL_BADGES[base];
      if (known !== undefined) return known;
      return base.slice(0, 2).toUpperCase();
    }

    function runStatusLabel(t, status) {
      const key = `view.status.${String(status)}`;
      const label = t(key);
      return label === key ? String(status) : label;
    }

    function usageOfCalls(calls) {
      let input = 0;
      let output = 0;
      let cached = 0;
      for (const event of calls) {
        if (event === null || typeof event !== 'object' || event.usage === null || typeof event.usage !== 'object') continue;
        input += Number(event.usage.promptTokens ?? 0);
        output += Number(event.usage.completionTokens ?? 0);
        cached += Number(event.usage.cachedTokens ?? 0);
      }
      return {
        input,
        output,
        cached,
        calls: calls.length,
        cacheHitRate: input > 0 ? cached / input : 0,
      };
    }

    function mergeUsage(left, right) {
      const input = Number(left.input ?? 0) + Number(right.input ?? 0);
      const output = Number(left.output ?? 0) + Number(right.output ?? 0);
      const cached = Number(left.cached ?? 0) + Number(right.cached ?? 0);
      const calls = Number(left.calls ?? 0) + Number(right.calls ?? 0);
      return {
        input,
        output,
        cached,
        calls,
        cacheHitRate: input > 0 ? cached / input : 0,
      };
    }

    function usageOfQueries(queries) {
      const usage = { input: 0, output: 0, cached: 0, calls: 0 };
      for (const query of queries) {
        if (query === null || typeof query !== 'object' || query.usage === null || typeof query.usage !== 'object') continue;
        usage.input += Number(query.usage.promptTokens ?? 0);
        usage.output += Number(query.usage.completionTokens ?? 0);
        usage.cached += Number(query.usage.cachedTokens ?? 0);
        usage.calls += Number(query.calls ?? 0);
      }
      usage.cacheHitRate = usage.input > 0 ? usage.cached / usage.input : 0;
      return usage;
    }

    function usageOfRun(run) {
      if (run === null || typeof run !== 'object') return usageOfCalls([]);
      if (run.usage !== null && typeof run.usage === 'object') {
        return {
          input: Number(run.usage.input ?? 0),
          output: Number(run.usage.output ?? 0),
          cached: Number(run.usage.cached ?? 0),
          calls: Number(run.usage.calls ?? 0),
          errors: Number(run.usage.errors ?? 0),
          latencyMs: Number(run.usage.latencyMs ?? 0),
          cacheHitRate: Number(run.usage.cacheHitRate ?? 0),
        };
      }
      let usage = { input: 0, output: 0, cached: 0, calls: 0, cacheHitRate: 0 };
      for (const entry of Array.isArray(run.events) ? run.events : []) {
        const event = entry === null || typeof entry !== 'object' ? null : entry.event;
        if (event === null || typeof event !== 'object') continue;
        if (event.type === 'llm_call' && event.usage !== null && typeof event.usage === 'object') {
          const extra = usageOfCalls([event]);
          usage = mergeUsage(usage, extra);
        } else if (event.type === 'llm_query') {
          usage = mergeUsage(usage, usageOfQueries([event]));
        }
      }
      usage.cacheHitRate = usage.input > 0 ? usage.cached / usage.input : 0;
      return usage;
    }

    function agentStatus(agent) {
      if (agent === null || typeof agent !== 'object') return 'running';
      if (agent.endedAt === null) return 'running';
      if (agent.terminated === 'error' || agent.terminated === 'filtered') return 'error';
      return 'done';
    }

    function agentStateLabel(t, agent) {
      if (agent === null || typeof agent !== 'object') return '';
      if (agent.endedAt === null) return runStatusLabel(t, 'running');
      if (agent.terminated === 'answer' || agent.terminated === 'forced_answer') return runStatusLabel(t, 'done');
      if (agent.terminated === 'error' || agent.terminated === 'filtered') return runStatusLabel(t, 'error');
      return String(agent.terminated ?? '');
    }

    function buildRunModel(run) {
      if (run === null || typeof run !== 'object' || !Array.isArray(run.events)) return null;
      const agents = [];
      const activeByDepth = [];
      let currentAgent = null;
      const now = Date.now();
      for (const entry of run.events) {
        const event = entry === null || typeof entry !== 'object' ? null : entry.event;
        if (event === null || typeof event !== 'object') continue;
        if (event.type === 'run_start') {
          const depth = Number(event.depth ?? 0);
          const parent = depth > 0 ? activeByDepth[depth - 1] ?? null : null;
          const agent = {
            id: 'agent:' + String(agents.length),
            name: String(event.agent ?? 'agent'),
            depth,
            parentId: parent === null ? null : parent.id,
            startedAt: entry.at,
            endedAt: null,
            terminated: null,
            steps: [],
            events: [],
            errors: [],
            usage: usageOfCalls([]),
          };
          if (parent !== null) {
            const parentStep = parent.steps[parent.steps.length - 1];
            if (parentStep !== undefined) {
              const branchTool = [...parentStep.tools].reverse().find((tool) => tool.name === 'branch' && tool.childAgentId === null);
              if (branchTool !== undefined) branchTool.childAgentId = agent.id;
            }
          }
          activeByDepth[depth] = agent;
          activeByDepth.length = depth + 1;
          agents.push(agent);
          currentAgent = agent;
          continue;
        }
        if (event.type === 'run_end') {
          const depth = Number(event.depth ?? 0);
          const agent = activeByDepth[depth] ?? currentAgent;
          if (agent !== null) {
            agent.endedAt = entry.at;
            agent.terminated = String(event.terminated ?? 'answer');
            if (agent.parentId !== null) {
              currentAgent = agents.find((candidate) => candidate.id === agent.parentId) ?? null;
              activeByDepth.length = currentAgent === null ? 0 : currentAgent.depth + 1;
            } else {
              currentAgent = null;
              activeByDepth.length = 0;
            }
          }
          continue;
        }
        const agent = currentAgent ?? agents[0] ?? null;
        if (agent === null) continue;
        if (event.type === 'step_start') {
          const previous = agent.steps[agent.steps.length - 1];
          if (previous !== undefined && previous.endedAt === null) previous.endedAt = entry.at;
          const step = {
            index: Number(event.step ?? agent.steps.length),
            at: entry.at,
            endedAt: null,
            contextTokens: Number(event.contextTokens ?? 0),
            blocks: Number(event.blocks ?? 0),
            events: [],
            responses: [],
            folds: [],
            tools: [],
            queries: [],
            llmCalls: [],
            errors: [],
            answer: null,
            usage: usageOfCalls([]),
          };
          agent.steps.push(step);
          agent.events.push(entry);
          continue;
        }
        const step =
          event.step === undefined
            ? agent.steps[agent.steps.length - 1]
            : agent.steps.find((candidate) => candidate.index === event.step) ?? agent.steps[agent.steps.length - 1];
        agent.events.push(entry);
        if (step !== undefined) step.events.push(entry);
        switch (event.type) {
          case 'llm_call':
            if (step !== undefined) step.llmCalls.push(event);
            break;
          case 'llm_response':
            if (step !== undefined) step.responses.push(event);
            break;
          case 'fold':
            if (step !== undefined) step.folds.push(event);
            break;
          case 'tool_call': {
            if (step !== undefined) {
              const action = event.action !== null && typeof event.action === 'object' ? event.action : {};
              step.tools.push({
                key: `${agent.id}:${step.index}:${step.tools.length}`,
                name: String(action.name ?? 'tool'),
                args: action.arguments ?? {},
                motivation: String(event.motivation ?? ''),
                at: entry.at,
                endedAt: null,
                result: null,
                tokens: null,
                error: null,
                childAgentId: null,
              });
            }
            break;
          }
          case 'tool_result': {
            if (step !== undefined) {
              const tool =
                [...step.tools].reverse().find((candidate) => candidate.result === null && candidate.name === event.name) ??
                [...step.tools].reverse().find((candidate) => candidate.result === null);
              if (tool !== undefined) {
                tool.result = String(event.observation ?? '');
                tool.tokens = Number(event.tokens ?? 0);
                tool.error = event.error === undefined ? null : String(event.error);
                tool.endedAt = entry.at;
              }
            }
            break;
          }
          case 'llm_query':
            if (step !== undefined) step.queries.push(event);
            break;
          case 'format_error':
            if (step !== undefined) step.errors.push(event);
            break;
          case 'error':
            agent.errors.push(event);
            if (step !== undefined) step.errors.push(event);
            break;
          case 'answer':
            if (step !== undefined) step.answer = String(event.answer ?? '');
            break;
          default:
            break;
        }
      }
      for (const agent of agents) {
        if (agent.endedAt === null && run.status !== 'running') agent.endedAt = run.endedAt ?? now;
        for (let index = 0; index < agent.steps.length; index += 1) {
          const step = agent.steps[index];
          const next = agent.steps[index + 1];
          if (step.endedAt === null) {
            step.endedAt = next !== undefined ? next.at : agent.endedAt ?? run.endedAt ?? now;
          }
          step.usage = mergeUsage(usageOfCalls(step.llmCalls), usageOfQueries(step.queries));
        }
        agent.usage = agent.steps.reduce(
          (total, step) => mergeUsage(total, step.usage),
          { input: 0, output: 0, cached: 0, calls: 0, cacheHitRate: 0 },
        );
      }
      return { agents };
    }

    function RunTool({ t, tool, open, onToggle, agentById, onOpenAgent }) {
      const status = tool.error !== null ? 'error' : tool.result !== null ? 'done' : 'running';
      const child = tool.childAgentId === null ? undefined : agentById.get(tool.childAgentId);
      const displayTool = tool.name.startsWith('dsh_') ? tool.name.slice(4) : tool.name;
      return h(
        'div',
        { className: 'rafx-toolWrap' },
        h(
          'button',
          {
            type: 'button',
            className: 'rafx-tool',
            'data-tool': displayTool,
            'data-status': status,
            'aria-expanded': open,
            onClick: onToggle,
          },
          h('span', { className: 'rafx-toolGlyph', 'aria-hidden': true }, toolBadge(tool.name)),
          h('span', { className: 'rafx-toolName' }, tool.name),
          h(
            'span',
            { className: 'rafx-toolMeta' },
            [
              tool.tokens === null ? null : `${formatTokens(tool.tokens)} tok`,
              formatDuration((tool.endedAt ?? Date.now()) - tool.at),
            ]
              .filter((value) => value !== null)
              .join(' · '),
          ),
          h('span', { className: 'rafx-toolChevron', 'aria-hidden': true }, h(ChevronGlyph, { size: 12 })),
        ),
        open
          ? h(
              'div',
              { className: 'rafx-toolBody' },
              h(
                'div',
                { className: 'rafx-field' },
                h('span', { className: 'rafx-fieldLabel' }, t('view.arguments')),
                h('pre', { className: 'rafx-pre' }, prettyJson(tool.args)),
              ),
              child === undefined
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'rafx-linkButton',
                      onClick: () => onOpenAgent(child.id),
                    },
                    `${t('view.openAgent')} → ${child.name}`,
                  ),
              tool.result === null
                ? h('div', { className: 'rafx-hint' }, runStatusLabel(t, 'running'))
                : h(
                    'div',
                    { className: 'rafx-field' },
                    h('span', { className: 'rafx-fieldLabel' }, t('view.result')),
                    h('pre', { className: 'rafx-pre' }, tool.result === '' ? '—' : tool.result),
                  ),
              tool.error === null ? null : h('div', { className: 'rafx-error' }, tool.error),
            )
          : null,
      );
    }

    function RunStep({ t, step, openTools, onToggleTool, agentById, onOpenAgent }) {
      const duration = (step.endedAt ?? Date.now()) - step.at;
      return h(
        'section',
        { className: 'rafx-step' },
        h(
          'header',
          { className: 'rafx-stepHead' },
          h('span', { className: 'rafx-stepTag' }, `step ${step.index}`),
          h(
            'span',
            { className: 'rafx-stepMeta' },
            [`ctx ${formatTokens(step.contextTokens)}`, `blocks ${step.blocks}`, formatDuration(duration)].join(' · '),
          ),
        ),
        step.responses.map((response, responseIndex) =>
          h(
            'details',
            { className: 'rafx-response', key: `${step.index}:response:${responseIndex}` },
            h('summary', null, h('span', null, t('view.thinking'))),
            h('pre', { className: 'rafx-pre' }, response.text === '' ? '—' : response.text),
            response.reasoning === undefined
              ? null
              : h(
                  'div',
                  { className: 'rafx-field' },
                  h('span', { className: 'rafx-fieldLabel' }, t('view.reasoning')),
                  h('pre', { className: 'rafx-pre' }, response.reasoning),
                ),
          ),
        ),
        step.folds.map((fold, foldIndex) => {
          const directive = fold.outcome?.directive ?? fold.requested;
          const range = Array.isArray(directive?.range) ? `[${directive.range.join(',')}]` : '';
          return h(
            'div',
            { className: 'rafx-fold', key: `${step.index}:fold:${foldIndex}` },
            h('span', { className: 'rafx-foldTag' }, `${t('view.fold')} ${fold.outcome?.kind ?? ''}`.trim()),
            h('span', { className: 'rafx-foldRange' }, range),
            h('p', { className: 'rafx-foldSummary' }, directive?.summary ?? '—'),
            Array.isArray(fold.outcome?.corrections) && fold.outcome.corrections.length > 0
              ? h('p', { className: 'rafx-foldCorrection' }, fold.outcome.corrections.join('; '))
              : null,
          );
        }),
        step.tools.length === 0
          ? null
          : h(
              'div',
              { className: 'rafx-tools' },
              step.tools.map((tool) =>
                h(RunTool, {
                  key: tool.key,
                  t,
                  tool,
                  open: openTools.has(tool.key),
                  onToggle: () => onToggleTool(tool.key),
                  agentById,
                  onOpenAgent,
                }),
              ),
            ),
        step.queries.length === 0
          ? null
          : h(
              'div',
              { className: 'rafx-queries' },
              step.queries.map((query, queryIndex) =>
                h(
                  'div',
                  { className: 'rafx-query', key: `${step.index}:query:${queryIndex}` },
                  h('span', { className: 'rafx-queryName' }, 'llm_query'),
                  h(
                    'span',
                    { className: 'rafx-queryMeta' },
                    [
                      `mode=${query.mode}`,
                      `chunks=${query.chunks}`,
                      `relevant=${query.relevant}`,
                      `memo=${query.memoHits}`,
                      `${formatTokens(query.chunkTokens)} tok/chunk`,
                      query.usage === undefined
                        ? null
                        : `${formatTokens(query.usage.promptTokens)} in / ${formatTokens(query.usage.completionTokens)} out · cache ${formatPercent(query.usage.promptTokens > 0 ? query.usage.cachedTokens / query.usage.promptTokens : 0)}`,
                    ]
                      .filter((value) => value !== null)
                      .join(' · '),
                  ),
                  h('p', { className: 'rafx-queryText' }, query.query),
                ),
              ),
            ),
        step.llmCalls.length === 0
          ? null
          : h(
              'details',
              { className: 'rafx-llm' },
              h(
                'summary',
                null,
                h('span', null, `${t('view.llmCalls')} (${step.llmCalls.length})`),
                h(
                  'span',
                  { className: 'rafx-llmMeta' },
                  `${formatTokens(step.usage.input)} in · ${formatTokens(step.usage.output)} out · cache ${formatPercent(step.usage.cacheHitRate)}`,
                ),
              ),
              h(
                'div',
                { className: 'rafx-llmRows' },
                step.llmCalls.map((call, callIndex) =>
                  h(
                    'div',
                    { className: 'rafx-llmRow', key: `${step.index}:llm:${callIndex}` },
                    h('span', { className: 'rafx-llmRole' }, call.role),
                    h('span', { className: 'rafx-llmModel' }, call.model),
                    h('span', null, `${formatTokens(call.usage?.promptTokens ?? 0)} in`),
                    h('span', null, `${formatTokens(call.usage?.completionTokens ?? 0)} out`),
                    h('span', null, `cache ${formatPercent(call.usage?.promptTokens ? (call.usage.cachedTokens ?? 0) / call.usage.promptTokens : 0)}`),
                    h('span', null, formatDuration(call.latencyMs ?? 0)),
                  ),
                ),
              ),
            ),
        step.errors.map((error, errorIndex) =>
          h(
            'div',
            { className: 'rafx-error', key: `${step.index}:error:${errorIndex}` },
            error.type === 'format_error'
              ? `format: ${Array.isArray(error.errors) ? error.errors.join('; ') : ''}`
              : String(error.message ?? error.type),
          ),
        ),
        step.answer === null
          ? null
          : h(
              'div',
              { className: 'rafx-answer' },
              h('span', { className: 'rafx-fieldLabel' }, t('view.answer')),
              h('p', null, step.answer === '' ? '—' : step.answer),
            ),
      );
    }

    function RafRunsView({ t, sessionId }) {
      const [runs, setRuns] = React.useState([]);
      const [selectedRunId, setSelectedRunId] = React.useState(null);
      const [run, setRun] = React.useState(null);
      const [selectedAgentId, setSelectedAgentId] = React.useState(null);
      const [openTools, setOpenTools] = React.useState(() => new Set());
      const [error, setError] = React.useState(null);
      const manual = React.useRef(false);
      const runningRef = React.useRef(false);

      React.useEffect(() => {
        if (typeof sessionId !== 'string' || !sessionId) return undefined;
        let active = true;
        let timer = 0;
        const load = async () => {
          try {
            const next = await getRuns(sessionId);
            if (!active) return;
            setRuns(next);
            if (!manual.current && next[0] !== undefined) setSelectedRunId(next[0].id);
            setError(null);
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            if (active) timer = window.setTimeout(load, 2000);
          }
        };
        void load();
        return () => {
          active = false;
          if (timer !== 0) window.clearTimeout(timer);
        };
      }, [sessionId]);

      React.useEffect(() => {
        setSelectedAgentId(null);
        setOpenTools(new Set());
        setRun(null);
      }, [selectedRunId]);

      React.useEffect(() => {
        if (typeof selectedRunId !== 'string' || !selectedRunId) return undefined;
        let active = true;
        let timer = 0;
        const load = async () => {
          try {
            const detail = await getRun(selectedRunId);
            if (!active) return;
            setRun(detail);
            runningRef.current = detail.status === 'running';
            setError(null);
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            if (active) timer = window.setTimeout(load, runningRef.current ? 700 : 2500);
          }
        };
        void load();
        return () => {
          active = false;
          if (timer !== 0) window.clearTimeout(timer);
        };
      }, [selectedRunId]);

      const model = React.useMemo(() => buildRunModel(run), [run]);
      const agents = model === null ? [] : model.agents;
      const agentById = new Map(agents.map((candidate) => [candidate.id, candidate]));
      const agent = agents.find((candidate) => candidate.id === selectedAgentId) ?? agents[0] ?? null;
      const selectedSummary = runs.find((candidate) => candidate.id === selectedRunId);
      const usage = run !== null ? usageOfRun(run) : selectedSummary?.usage ?? usageOfCalls([]);

      const toggleTool = (key) => {
        setOpenTools((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      if (typeof sessionId !== 'string' || !sessionId) {
        return h('section', { className: 'rafx-page rafx-runs' }, h(RafRunsEmpty, { t }));
      }
      if (runs.length === 0) {
        return h(
          'section',
          { className: 'rafx-page rafx-runs' },
          error === null ? null : h('div', { className: 'rafx-runsNotice' }, error),
          h(RafRunsEmpty, { t }),
        );
      }

      const status = run === null ? selectedSummary?.status ?? 'running' : run.status;
      const question = run === null ? selectedSummary?.question ?? '' : run.question;
      const modelName = run === null ? selectedSummary?.model ?? '' : run.model;
      const settings = run === null ? selectedSummary?.settings : run.settings;
      const duration =
        run !== null
          ? (run.endedAt ?? Date.now()) - run.startedAt
          : selectedSummary === undefined
            ? 0
            : (selectedSummary.endedAt ?? Date.now()) - selectedSummary.startedAt;

      return h(
        'section',
        { className: 'rafx-page rafx-runs' },
        h(
          'header',
          { className: 'rafx-runsTop' },
          h(
            'div',
            { className: 'rafx-runsTopMain' },
            h(
              'div',
              { className: 'rafx-runsTitle' },
              h('h1', { className: 'rafx-runsHeading' }, 'RAF'),
              h('p', { className: 'rafx-runsQuestion', title: question }, question),
              h(
                'div',
                { className: 'rafx-runsMeta' },
                h('span', { className: 'rafx-runsChip', 'data-status': status },
                  h('span', { className: 'rafx-runsDot', 'aria-hidden': true }),
                  runStatusLabel(t, status),
                ),
                modelName === '' ? null : h('span', { className: 'rafx-runsChip' }, modelName),
                settings === null || settings === undefined
                  ? null
                  : h('span', { className: 'rafx-runsChip' }, `depth ${settings.depth} · reserve ${Math.round(settings.reserve * 100)}% · readers ${settings.concurrency}`),
              ),
            ),
            h(
              'div',
              { className: 'rafx-runsActions' },
              h(
                'label',
                { className: 'rafx-runsSelectWrap' },
                h('span', null, t('view.selectRun')),
                h(
                  'select',
                  {
                    className: 'rafx-runsSelect',
                    value: selectedRunId ?? '',
                    onChange: (event) => {
                      manual.current = true;
                      setSelectedRunId(event.target.value);
                    },
                  },
                  runs.map((candidate) =>
                    h(
                      'option',
                      { key: candidate.id, value: candidate.id },
                      `${formatClock(candidate.startedAt)} · ${runStatusLabel(t, candidate.status)} · ${candidate.question.slice(0, 58)}`,
                    ),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'rafx-runsStats' },
            h(RafStat, { label: t('view.steps'), value: String(run?.stepCount ?? selectedSummary?.stepCount ?? 0) }),
            h(RafStat, { label: t('view.agents'), value: String(run?.agentCount ?? selectedSummary?.agentCount ?? 0) }),
            h(RafStat, { label: t('view.tokens'), value: `${formatTokens(usage.input)} / ${formatTokens(usage.output)}` }),
            h(RafStat, { label: t('view.cache'), value: formatPercent(usage.cacheHitRate) }),
            h(RafStat, { label: t('view.duration'), value: formatDuration(duration) }),
          ),
          error === null ? null : h('div', { className: 'rafx-runsNotice' }, error),
        ),
        h(
          'div',
          { className: 'rafx-runsBody' },
          h(
            'aside',
            { className: 'rafx-agents' },
            h(
              'div',
              { className: 'rafx-agentsHead' },
              h('span', null, t('view.agents')),
              h('span', { className: 'rafx-agentsCount' }, String(agents.length)),
            ),
            h(
              'div',
              { className: 'rafx-agentList' },
              agents.map((candidate) =>
                h(
                  'button',
                  {
                    key: candidate.id,
                    type: 'button',
                    className: 'rafx-agent',
                    'data-selected': agent !== null && candidate.id === agent.id ? 'true' : undefined,
                    'data-depth': candidate.depth,
                    style: { paddingLeft: `${8 + candidate.depth * 12}px` },
                    onClick: () => {
                      setSelectedAgentId(candidate.id);
                    },
                  },
                  h('span', { className: 'rafx-agentDot', 'data-status': agentStatus(candidate), 'aria-hidden': true }),
                  h(
                    'span',
                    { className: 'rafx-agentBody' },
                    h('span', { className: 'rafx-agentName' }, candidate.depth === 0 ? t('view.root') : candidate.name),
                    h(
                      'span',
                      { className: 'rafx-agentMeta' },
                      `${candidate.steps.length} ${t('view.steps').toLowerCase()} · ${formatTokens(candidate.usage.input)} in`,
                    ),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'rafx-timeline' },
            agent === null
              ? h(
                  'div',
                  { className: 'rafx-timelineEmpty' },
                  h('p', null, run?.error ?? t('view.noEvents')),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    'div',
                    { className: 'rafx-agentHead' },
                    h(
                      'div',
                      { className: 'rafx-agentHeadTitle' },
                      agent.parentId === null
                        ? null
                        : h(
                            'button',
                            { type: 'button', className: 'rafx-linkButton', onClick: () => setSelectedAgentId(agent.parentId) },
                            `← ${t('view.parent')}`,
                          ),
                      h('h2', null, agent.depth === 0 ? t('view.root') : agent.name),
                      h('span', { className: 'rafx-agentDepth' }, `d${agent.depth}`),
                      h('span', { className: 'rafx-agentState', 'data-status': agentStatus(agent) }, agentStateLabel(t, agent)),
                    ),
                    h(
                      'div',
                      { className: 'rafx-agentHeadMeta' },
                      `${agent.steps.length} ${t('view.steps').toLowerCase()} · ${formatTokens(agent.usage.input)} in / ${formatTokens(agent.usage.output)} out · cache ${formatPercent(agent.usage.cacheHitRate)}`,
                    ),
                  ),
                  agent.steps.length === 0
                    ? h('div', { className: 'rafx-timelineEmpty' }, h('p', null, t('view.noSteps')))
                    : agent.steps.map((step) =>
                        h(RunStep, {
                          key: `${agent.id}:${step.index}`,
                          t,
                          step,
                          openTools,
                          onToggleTool: toggleTool,
                          agentById,
                          onOpenAgent: (id) => setSelectedAgentId(id),
                        }),
                      ),
                  agent.errors.length === 0
                    ? null
                    : h(
                        'div',
                        { className: 'rafx-agentErrors' },
                        agent.errors.map((item, index) =>
                          h('div', { className: 'rafx-error', key: `${agent.id}:error:${index}` }, String(item.message ?? item.type)),
                        ),
                      ),
                ),
          ),
        ),
      );
    }

    function RafRunsEmpty({ t }) {
      return h(
        'div',
        { className: 'rafx-runsEmpty' },
        h('h2', null, t('view.emptyTitle')),
        h('p', null, t('view.emptyHint')),
      );
    }

    function RafStat({ label, value }) {
      return h(
        'div',
        { className: 'rafx-runsStat' },
        h('span', { className: 'rafx-runsStatValue' }, value),
        h('span', { className: 'rafx-runsStatLabel' }, label),
      );
    }


    const LIVE_LINGER_MS = 10 * 60_000;
    const LIVE_FEED_LIMIT = 160;

    function compactJson(value, limit = 90) {
      let text;
      try {
        text = JSON.stringify(value ?? {});
      } catch {
        text = String(value);
      }
      if (typeof text !== 'string') text = '';
      return text.length > limit ? `${text.slice(0, limit)}…` : text;
    }

    function buildRunFeed(run) {
      const agents = [];
      const entries = [];
      const pending = new Map();
      const depthByAgent = new Map();
      const records = run !== null && typeof run === 'object' && Array.isArray(run.events) ? run.events : [];
      for (const record of records) {
        const event = record === null || typeof record !== 'object' ? null : record.event;
        if (event === null || typeof event !== 'object') continue;
        const seq = typeof record.seq === 'number' ? record.seq : entries.length;
        const key = `e${seq}`;
        const at = record.at;
        const type = event.type;
        if (type === 'run_start') {
          const agent = String(event.agent ?? 'agent');
          const depth = Number(event.depth ?? 0);
          depthByAgent.set(agent, depth);
          agents.push({ name: agent, depth, status: 'running', terminated: '', steps: 0 });
          entries.push({ key, kind: 'agent-start', agent, depth, at });
          continue;
        }
        const agent = String(event.agent ?? 'root');
        const depth = depthByAgent.get(agent) ?? 0;
        if (type === 'run_end') {
          const meta = agents.find((candidate) => candidate.name === agent);
          const terminated = String(event.terminated ?? '');
          if (meta !== undefined) {
            meta.status = terminated === 'error' || terminated === 'filtered' ? 'error' : 'done';
            meta.terminated = terminated;
            meta.steps = Number(event.steps ?? 0);
          }
          entries.push({ key, kind: 'agent-end', agent, depth, at, terminated, steps: Number(event.steps ?? 0) });
          continue;
        }
        if (type === 'tool_call') {
          const action = event.action !== null && typeof event.action === 'object' ? event.action : {};
          const name = String(action.name ?? 'tool');
          const item = {
            key,
            kind: 'tool',
            agent,
            depth,
            step: Number(event.step ?? 0),
            at,
            name,
            args: action.arguments ?? {},
            motivation: String(event.motivation ?? ''),
            result: null,
            tokens: null,
            error: null,
            endedAt: null,
            query: null,
          };
          entries.push(item);
          const pkey = `${agent}\u0000${item.step}\u0000${name}`;
          const list = pending.get(pkey) ?? [];
          list.push(item);
          pending.set(pkey, list);
          continue;
        }
        if (type === 'tool_result') {
          const pkey = `${agent}\u0000${Number(event.step ?? 0)}\u0000${String(event.name ?? '')}`;
          const list = pending.get(pkey);
          const item = list === undefined ? undefined : list.shift();
          if (item !== undefined) {
            item.result = String(event.observation ?? '');
            item.tokens = Number(event.tokens ?? 0);
            item.error = event.error === undefined ? null : String(event.error);
            item.endedAt = at;
          }
          continue;
        }
        if (type === 'llm_query') {
          const pkey = `${agent}\u0000${Number(event.step ?? 0)}\u0000llm_query`;
          const list = pending.get(pkey);
          const item = list === undefined ? undefined : list[list.length - 1];
          const query = {
            chunks: Number(event.chunks ?? 0),
            relevant: Number(event.relevant ?? 0),
            memo: Number(event.memoHits ?? 0),
            usage: event.usage ?? null,
          };
          if (item !== undefined) item.query = query;
          else entries.push({ key, kind: 'query', agent, depth, step: Number(event.step ?? 0), at, query });
          continue;
        }
        if (type === 'fold') {
          const directive = event.outcome?.directive ?? event.requested;
          entries.push({
            key,
            kind: 'fold',
            agent,
            depth,
            step: Number(event.step ?? 0),
            at,
            range: Array.isArray(directive?.range) ? directive.range : null,
            summary: String(directive?.summary ?? ''),
            corrections: Array.isArray(event.outcome?.corrections) ? event.outcome.corrections : [],
          });
          continue;
        }
        if (type === 'answer') {
          entries.push({ key, kind: 'answer', agent, depth, step: Number(event.step ?? 0), at, answer: String(event.answer ?? '') });
          continue;
        }
        if (type === 'format_error') {
          entries.push({
            key,
            kind: 'error',
            agent,
            depth,
            step: Number(event.step ?? 0),
            at,
            message: Array.isArray(event.errors) ? event.errors.join('; ') : 'format error',
          });
          continue;
        }
        if (type === 'error') {
          entries.push({ key, kind: 'error', agent, depth, step: Number(event.step ?? 0), at, message: String(event.message ?? event.type) });
        }
      }
      return { agents, entries };
    }

    function RafLiveRow({ t, item, open, onToggle }) {
      const expandable = item.kind === 'tool' || item.kind === 'fold' || item.kind === 'answer' || item.kind === 'error';
      const base = {
        className: 'rafx-liveRow',
        'data-kind': item.kind,
        style: { paddingLeft: `${6 + item.depth * 12}px` },
      };
      const agentTag = h('span', { className: 'rafx-liveAgentTag', 'data-depth': item.depth }, item.agent);
      const stepTag = item.step === undefined ? null : h('span', { className: 'rafx-liveStep' }, t('live.step', { step: item.step }));
      const head = [];
      if (item.kind === 'agent-start') {
        head.push(agentTag, h('span', { className: 'rafx-liveText' }, t('live.started')));
      } else if (item.kind === 'agent-end') {
        head.push(
          agentTag,
          h('span', { className: 'rafx-liveText' }, t('live.finished')),
          h('span', { className: 'rafx-liveEnd' }, item.terminated),
          h('span', { className: 'rafx-liveMeta' }, t('live.steps', { count: item.steps })),
        );
      } else if (item.kind === 'tool') {
        head.push(
          agentTag,
          stepTag,
          h('span', { className: 'rafx-liveName' }, item.name),
          h('span', { className: 'rafx-livePreview' }, compactJson(item.args, 80)),
          item.query === null ? null : h('span', { className: 'rafx-liveMeta' }, `chunks ${item.query.chunks} · rel ${item.query.relevant}`),
          item.result === null
            ? h('span', { className: 'rafx-liveLive', 'aria-hidden': true }, h('span', { className: 'rafx-liveDot' }))
            : h('span', { className: 'rafx-liveMeta' }, [item.tokens === null ? null : `${formatTokens(item.tokens)} tok`, formatDuration((item.endedAt ?? Date.now()) - item.at)].filter(Boolean).join(' · ')),
          h('span', { className: 'rafx-liveChevron', 'aria-hidden': true }, h(ChevronGlyph, { size: 11 })),
        );
      } else if (item.kind === 'fold') {
        head.push(
          agentTag,
          stepTag,
          h('span', { className: 'rafx-liveKind' }, t('live.fold')),
          h('span', { className: 'rafx-liveRange' }, item.range === null ? '' : `[${item.range.join(',')}]`),
          h('span', { className: 'rafx-livePreview' }, item.summary),
          h('span', { className: 'rafx-liveChevron', 'aria-hidden': true }, h(ChevronGlyph, { size: 11 })),
        );
      } else if (item.kind === 'answer') {
        head.push(
          agentTag,
          stepTag,
          h('span', { className: 'rafx-liveKind', 'data-kind': 'answer' }, t('live.answer')),
          h('span', { className: 'rafx-livePreview' }, item.answer),
          h('span', { className: 'rafx-liveChevron', 'aria-hidden': true }, h(ChevronGlyph, { size: 11 })),
        );
      } else if (item.kind === 'error') {
        head.push(
          agentTag,
          stepTag,
          h('span', { className: 'rafx-liveKind', 'data-kind': 'error' }, t('live.error')),
          h('span', { className: 'rafx-livePreview' }, item.message),
          h('span', { className: 'rafx-liveChevron', 'aria-hidden': true }, h(ChevronGlyph, { size: 11 })),
        );
      } else if (item.kind === 'query') {
        head.push(
          agentTag,
          stepTag,
          h('span', { className: 'rafx-liveKind' }, 'llm_query'),
          h('span', { className: 'rafx-liveMeta' }, `chunks ${item.query.chunks} · rel ${item.query.relevant}`),
        );
      }
      let body = null;
      if (expandable && open) {
        if (item.kind === 'tool') {
          body = h(
            'div',
            { className: 'rafx-liveBody' },
            item.motivation === ''
              ? null
              : h(
                  'div',
                  { className: 'rafx-field' },
                  h('span', { className: 'rafx-liveLabel' }, t('live.motivation')),
                  h('p', { className: 'rafx-liveNote' }, item.motivation),
                ),
            h(
              'div',
              { className: 'rafx-field' },
              h('span', { className: 'rafx-liveLabel' }, t('view.arguments')),
              h('pre', { className: 'rafx-livePre' }, prettyJson(item.args)),
            ),
            item.query === null
              ? null
              : h('div', { className: 'rafx-liveMetaLine' }, `llm_query · chunks ${item.query.chunks} · relevant ${item.query.relevant} · memo ${item.query.memo}`),
            item.result === null
              ? h('div', { className: 'rafx-liveNote' }, runStatusLabel(t, 'running'))
              : h(
                  'div',
                  { className: 'rafx-field' },
                  h('span', { className: 'rafx-liveLabel' }, t('view.result')),
                  h('pre', { className: 'rafx-livePre' }, item.result === '' ? '—' : item.result),
                ),
            item.error === null ? null : h('div', { className: 'rafx-liveError' }, item.error),
          );
        } else if (item.kind === 'fold') {
          body = h(
            'div',
            { className: 'rafx-liveBody' },
            h('pre', { className: 'rafx-livePre' }, item.summary === '' ? '—' : item.summary),
            item.corrections.length === 0 ? null : h('div', { className: 'rafx-liveMetaLine' }, item.corrections.join('; ')),
          );
        } else if (item.kind === 'answer') {
          body = h('div', { className: 'rafx-liveBody' }, h('pre', { className: 'rafx-livePre' }, item.answer === '' ? '—' : item.answer));
        } else if (item.kind === 'error') {
          body = h('div', { className: 'rafx-liveBody' }, h('div', { className: 'rafx-liveError' }, item.message));
        }
      }
      if (!expandable) return h('div', base, ...head);
      return h(
        'div',
        { className: 'rafx-liveItem' },
        h('button', { ...base, type: 'button', 'aria-expanded': open, onClick: onToggle }, ...head),
        body,
      );
    }

    function RafLiveDock({ t, sessionId }) {
      const engine = useEngine(sessionId);
      const [run, setRun] = React.useState(null);
      const [selectedAgent, setSelectedAgent] = React.useState('all');
      const [openKey, setOpenKey] = React.useState(null);
      const [collapsed, setCollapsed] = React.useState(false);
      const [dismissed, setDismissed] = React.useState(null);
      const feedRef = React.useRef(null);
      const stickRef = React.useRef(true);

      React.useEffect(() => {
        if (engine !== ENGINE_RAF || typeof sessionId !== 'string' || !sessionId) {
          setRun(null);
          return undefined;
        }
        let active = true;
        let timer = 0;
        const tick = async () => {
          try {
            const list = await getRuns(sessionId);
            if (!active) return;
            const latest = list[0];
            if (
              latest === undefined ||
              (latest.status !== 'running' && (typeof latest.endedAt !== 'number' || Date.now() - latest.endedAt > LIVE_LINGER_MS))
            ) {
              setRun(null);
              timer = window.setTimeout(tick, 2000);
              return;
            }
            const detail = await getRun(latest.id);
            if (!active) return;
            setRun(detail);
            timer = window.setTimeout(tick, detail.status === 'running' ? 700 : 2000);
          } catch {
            if (active) timer = window.setTimeout(tick, 2000);
          }
        };
        void tick();
        return () => {
          active = false;
          if (timer !== 0) window.clearTimeout(timer);
        };
      }, [engine, sessionId]);

      React.useEffect(() => {
        setSelectedAgent('all');
        setOpenKey(null);
        setCollapsed(false);
        stickRef.current = true;
      }, [run?.id]);

      React.useEffect(() => {
        setDismissed(null);
      }, [sessionId]);

      const feed = React.useMemo(() => buildRunFeed(run), [run]);
      const visible = feed.entries.filter((item) => selectedAgent === 'all' || item.agent === selectedAgent);
      const shown = visible.length > LIVE_FEED_LIMIT ? visible.slice(-LIVE_FEED_LIMIT) : visible;

      React.useEffect(() => {
        if (collapsed) return;
        const element = feedRef.current;
        if (element === null || !stickRef.current) return;
        element.scrollTop = element.scrollHeight;
      }, [shown.length, selectedAgent, collapsed]);

      if (engine !== ENGINE_RAF || run === null || run.id === dismissed) return null;

      const duration = (run.endedAt ?? Date.now()) - run.startedAt;
      const status = run.status;

      return h(
        'section',
        { className: 'rafx-live', 'data-status': status },
        h(
          'header',
          { className: 'rafx-liveHead' },
          h('span', { className: 'rafx-liveTitle' }, 'RAF'),
          h(
            'span',
            { className: 'rafx-liveStatus', 'data-status': status },
            h('span', { className: 'rafx-liveDot', 'aria-hidden': true }),
            runStatusLabel(t, status),
          ),
          h('span', { className: 'rafx-liveQuestion', title: run.question }, run.question),
          h(
            'span',
            { className: 'rafx-liveMeta' },
            `${formatDuration(duration)} · ${run.stepCount} ${t('view.steps').toLowerCase()} · ${feed.agents.length} ${t('view.agents').toLowerCase()}`,
          ),
          h(
            'span',
            { className: 'rafx-liveActions' },
            h(
              'button',
              {
                type: 'button',
                className: 'rafx-liveIcon',
                'aria-label': collapsed ? t('live.expand') : t('live.collapse'),
                title: collapsed ? t('live.expand') : t('live.collapse'),
                onClick: () => setCollapsed((value) => !value),
              },
              h('span', { className: 'rafx-liveChevronButton', 'data-collapsed': collapsed ? 'true' : undefined }, h(ChevronGlyph, { size: 12 })),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'rafx-liveIcon',
                'aria-label': t('live.close'),
                title: t('live.close'),
                onClick: () => setDismissed(run.id),
              },
              '×',
            ),
          ),
        ),
        collapsed
          ? null
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'rafx-liveAgents' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'rafx-liveAgentChip',
                    'data-selected': selectedAgent === 'all' ? 'true' : undefined,
                    onClick: () => setSelectedAgent('all'),
                  },
                  t('live.all'),
                ),
                feed.agents.map((agent) =>
                  h(
                    'button',
                    {
                      key: agent.name,
                      type: 'button',
                      className: 'rafx-liveAgentChip',
                      'data-selected': selectedAgent === agent.name ? 'true' : undefined,
                      'data-depth': agent.depth,
                      style: { paddingLeft: `${6 + agent.depth * 10}px` },
                      onClick: () => setSelectedAgent(agent.name),
                    },
                    h('span', { className: 'rafx-liveAgentDot', 'data-status': agent.status, 'aria-hidden': true }),
                    agent.depth === 0 ? t('view.root') : agent.name,
                  ),
                ),
              ),
              shown.length === 0
                ? h('div', { className: 'rafx-liveEmpty' }, status === 'running' ? t('live.waiting') : t('view.noEvents'))
                : h(
                    'div',
                    {
                      className: 'rafx-liveFeed',
                      ref: feedRef,
                      onScroll: (event) => {
                        const element = event.currentTarget;
                        stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 32;
                      },
                    },
                    visible.length > shown.length ? h('div', { className: 'rafx-liveTruncated' }, t('live.truncated')) : null,
                    shown.map((item) =>
                      h(RafLiveRow, {
                        key: item.key,
                        t,
                        item,
                        open: openKey === item.key,
                        onToggle: () => setOpenKey((current) => (current === item.key ? null : item.key)),
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

      void postHostSettings(settingsStore.getSnapshot()).catch(() => {});

      ctx.effect(() => {
        const onStorage = (event) => {
          if (event.key === ENGINES_KEY) {
            engineStore.replace(readEngines());
            return;
          }
          if (event.key !== SETTINGS_KEY) return;
          settingsStore.replace(event.newValue === null ? DEFAULT_SETTINGS : parseSettings(event.newValue));
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
      }, 'raf: settings sync');

      ctx.effect(
        () => () => {
          if (settingsSyncTimer === 0) return;
          window.clearTimeout(settingsSyncTimer);
          settingsSyncTimer = 0;
        },
        'raf: settings sync timer',
      );

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
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'raf-live',
                order: 5,
                locale: NS,
              },
              RafLiveDock,
            ),
          ),
        'raf: live activity dock',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.view', () =>
            ctx.slots.register(
              {
                name: 'conversation.view',
                id: 'raf-runs',
                order: 30,
                locale: NS,
                label: () => t('view.label'),
              },
              RafRunsView,
            ),
          ),
        'raf: runs view',
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
