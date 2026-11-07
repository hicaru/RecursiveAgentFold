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
      rootModel: '',
      branchModel: '',
      queryModel: '',
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
      'tuning.rootModel.title': 'Root model',
      'tuning.rootModel.desc': 'Orchestrator model (provider/model). Blank uses the Session model.',
      'tuning.branchModel.title': 'Branch model (sub-agents)',
      'tuning.branchModel.desc': 'Scoped specialist model (e.g. deepseek/deepseek-chat). Blank uses Root.',
      'tuning.queryModel.title': 'Reader model (llm_query)',
      'tuning.queryModel.desc': 'Fast chunk reader model (e.g. zai-coding-cn/glm-5.3-flash). Blank uses Root.',
      'tuning.modelPlaceholder': 'Session default (or provider/model)',
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
      'view.rootCache': 'Root cache',
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
      'view.root': 'Root (orchestrator)',
      'view.errorLabel': 'Error',
      'view.llmCalls': 'LLM calls',
      'view.openAgent': 'Open subagent',
      'view.parent': 'Parent',
      'view.motivation': 'Motivation',
      'view.inspector': 'Inspector',
      'tool.branch.title': 'Branch',
      'tool.branch.tasks': 'tasks',
      'tool.branch.running': 'running',
      'tool.branch.failed': 'failed',
      'tool.branch.stopped': 'stopped',
      'tool.branch.result': 'Result',
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
      'tuning.rootModel.title': 'Модель корня (root)',
      'tuning.rootModel.desc': 'Модель оркестратора (provider/model). Пусто — модель сессии.',
      'tuning.branchModel.title': 'Модель веток (branch)',
      'tuning.branchModel.desc': 'Модель суб-агентов (например deepseek/deepseek-chat). Пусто — корень.',
      'tuning.queryModel.title': 'Модель читателя (llm_query)',
      'tuning.queryModel.desc': 'Быстрая модель чтения чанков (например zai-coding-cn/glm-5.3-flash).',
      'tuning.modelPlaceholder': 'По умолчанию сессии (или provider/model)',
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
      'view.rootCache': 'Кэш корня',
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
      'view.root': 'Корень (оркестратор)',
      'view.errorLabel': 'Ошибка',
      'view.llmCalls': 'Вызовы LLM',
      'view.openAgent': 'Открыть суб-агента',
      'view.parent': 'Родитель',
      'view.motivation': 'Мотивация',
      'view.inspector': 'Инспектор',
      'tool.branch.title': 'Ветки',
      'tool.branch.tasks': 'задачи',
      'tool.branch.running': 'выполняется',
      'tool.branch.failed': 'ошибка',
      'tool.branch.stopped': 'остановлено',
      'tool.branch.result': 'Результат',
    });

    const CSS = `
.rafx-branch{display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:var(--dsh-content-font-size-secondary,13px)}
.rafx-branchHead{display:flex;align-items:center;gap:6px;min-height:calc(24px + var(--dsh-content-font-delta,0px));cursor:pointer;transition:color .1s;min-width:0}
.rafx-branchHead:hover{color:var(--dsw-alias-label-secondary)}
.rafx-branchHead[data-state=running]{color:var(--dsw-alias-state-business-primary)}
.rafx-branchHead[data-state=error]{color:var(--dsw-alias-state-error-primary)}
.rafx-branchHead[data-state=stopped]{color:var(--dsw-alias-state-warn-label)}
.rafx-branchChevron{width:12px;flex:none;color:inherit}
.rafx-branchIcon{width:16px;height:16px;display:inline-flex;align-items:center;justify-content:center;flex:none}
.rafx-branchTitle{flex:none;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.rafx-branchSep{width:2px;height:2px;border-radius:1px;background:currentColor;opacity:.55;flex:none;margin:0 2px}
.rafx-branchSummary{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px))}
.rafx-branchBody{display:flex;flex-direction:column;gap:6px;margin:2px 0 6px 22px;padding-left:9px;border-left:.5px solid var(--dsw-alias-border-l2)}
.rafx-branchTaskWrap{display:flex;flex-direction:column;gap:2px}
.rafx-branchTask{display:flex;gap:6px;align-items:flex-start;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary)}
.rafx-branchTaskNo{flex:none;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:11px;line-height:1.6}
.rafx-branchScope{flex:none;padding:0 5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:4px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,monospace);font-size:10px;line-height:16px}
.rafx-branchTaskText{min-width:0;white-space:pre-wrap;word-break:break-word}
.rafx-branchTaskResult{margin:2px 0 2px 18px;padding:4px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.rafx-branchResult{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.rafx-branchResultLabel{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:500}
.rafx-branchResultText{margin:0;padding:5px 7px;border-radius:5px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-markdown-code-block-small);white-space:pre-wrap;word-break:break-word;max-height:160px;overflow:auto}
.rafx-branchInspect{align-self:flex-start;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:2px 8px;font-size:11px;line-height:16px}
.rafx-branchInspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}
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
.rafx-input{box-sizing:border-box;width:240px;max-width:100%;height:30px;padding:0 10px;border:.5px solid var(--rafx-line);border-radius:8px;background:var(--rafx-surface-2);color:var(--rafx-ink);font-family:var(--ds-font-family-code,monospace);font-size:12px}
.rafx-input::placeholder{color:var(--rafx-ink-3);font-family:inherit}
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
.rafx-tool[data-tool=add_document] .rafx-toolGlyph,.rafx-tool[data-tool=list_documents] .rafx-toolGlyph{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.rafx-tool[data-tool=grep] .rafx-toolGlyph,.rafx-tool[data-tool=read] .rafx-toolGlyph,.rafx-tool[data-tool=search] .rafx-toolGlyph,.rafx-tool[data-tool=outline] .rafx-toolGlyph,.rafx-tool[data-tool=tally] .rafx-toolGlyph{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
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
.rafx-dockBtn{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 7px;border:.5px solid var(--rafx-line);border-radius:6px;background:var(--rafx-surface);color:var(--rafx-ink-2);font:inherit;font-size:10.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.rafx-dockBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--rafx-ink)}
.rafx-runsEmpty{flex:1}
.rafx-runsEmpty h2{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--rafx-ink-3)}
.rafx-runsEmpty p{margin:0;font-size:12px;line-height:18px;max-width:44ch}
.rafx-agentErrors{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.rafx-panelTabs{display:flex;align-items:center;gap:6px;padding:10px 20px;border-bottom:.5px solid var(--rafx-line);background:var(--rafx-surface)}
[data-platform=darwin] .rafx-panelTabs{padding-top:calc(10px + var(--dsh-frame-top-clearance,0px))}
.rafx-panelTab{height:28px;padding:0 12px;border:.5px solid transparent;border-radius:8px;background:transparent;color:var(--rafx-ink-3);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .14s,color .14s}
.rafx-panelTab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--rafx-ink)}
.rafx-panelTab[aria-selected=true]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--rafx-surface-2));border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);color:var(--rafx-ink)}
.rafx-treeAgentChevron{display:inline-flex;flex:none;color:var(--dsw-alias-label-caption);font-size:10px;width:12px;justify-content:center}
.rafx-treeTask{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:6px;background:var(--rafx-surface-2);font-size:11px;color:var(--rafx-ink-2);overflow-wrap:anywhere}
.rafx-stepToggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.rafx-stepPills{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap}
.rafx-stepPill{padding:0 5px;border-radius:4px;background:var(--rafx-surface-2);color:var(--dsw-alias-label-caption);font-family:var(--ds-font-family-code,monospace);font-size:9px;font-weight:600;line-height:16px}
.rafx-toolMot{flex:1;min-width:40px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10.5px;color:var(--rafx-ink-3)}
.rafx-childLinks{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
@keyframes rafx-pulse{0%{opacity:.35}50%{opacity:1}100%{opacity:.35}}
@media (max-width:820px){.rafx-runsBody{grid-template-columns:1fr}.rafx-agents{max-height:150px;border-right:0;border-bottom:.5px solid var(--rafx-line)}.rafx-agentList{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}.rafx-timeline{padding:12px 14px 40px}.rafx-runsTop{padding:12px 14px 10px}}
@media (prefers-reduced-motion:reduce){.rafx-runsChip[data-status=running] .rafx-runsDot,.rafx-agentDot[data-status=running]{animation:none}}
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

    function toModelString(value) {
      return typeof value === 'string' ? value.trim().slice(0, 160) : '';
    }

    function sanitizeSettings(value) {
      const source = value !== null && typeof value === 'object' ? value : {};
      return Object.freeze({
        depth: toInteger(source.depth, DEFAULT_SETTINGS.depth, DEPTH_MIN, DEPTH_MAX),
        reserve: toReserve(source.reserve),
        concurrency: toInteger(source.concurrency, DEFAULT_SETTINGS.concurrency, CONCURRENCY_MIN, CONCURRENCY_MAX),
        rootModel: toModelString(source.rootModel),
        branchModel: toModelString(source.branchModel),
        queryModel: toModelString(source.queryModel),
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
            rootModel: DEFAULT_SETTINGS.rootModel,
            branchModel: DEFAULT_SETTINGS.branchModel,
            queryModel: DEFAULT_SETTINGS.queryModel,
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
      const query =
        typeof sessionId === 'string' && sessionId.trim() !== ''
          ? 'sessionId=' + encodeURIComponent(sessionId.trim())
          : undefined;
      return requestHost('GET', undefined, query, RUNS_API).then((data) =>
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

    function RafSettingsContent({ t }) {
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
              label: t('tuning.rootModel.title'),
              hint: t('tuning.rootModel.desc'),
              control: h('input', {
                type: 'text',
                className: 'rafx-input',
                value: settings.rootModel ?? '',
                placeholder: t('tuning.modelPlaceholder'),
                'aria-label': t('tuning.rootModel.title'),
                onChange: (event) => settingsStore.update({ rootModel: event.target.value }),
              }),
            }),
            h(SettingRow, {
              label: t('tuning.branchModel.title'),
              hint: t('tuning.branchModel.desc'),
              control: h('input', {
                type: 'text',
                className: 'rafx-input',
                value: settings.branchModel ?? '',
                placeholder: t('tuning.modelPlaceholder'),
                'aria-label': t('tuning.branchModel.title'),
                onChange: (event) => settingsStore.update({ branchModel: event.target.value }),
              }),
            }),
            h(SettingRow, {
              label: t('tuning.queryModel.title'),
              hint: t('tuning.queryModel.desc'),
              control: h('input', {
                type: 'text',
                className: 'rafx-input',
                value: settings.queryModel ?? '',
                placeholder: t('tuning.modelPlaceholder'),
                'aria-label': t('tuning.queryModel.title'),
                onChange: (event) => settingsStore.update({ queryModel: event.target.value }),
              }),
            }),
          ),
        ),
      );
    }

    function RafPanel({ t, sessionId }) {
      const [tab, setTab] = React.useState('inspector');
      return h(
        'section',
        { className: 'rafx-page', 'aria-label': t('panel.title') },
        h(
          'div',
          { className: 'rafx-panelTabs', role: 'tablist', 'aria-label': t('panel.title') },
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'rafx-panelTab',
              'aria-selected': tab === 'inspector',
              onClick: () => setTab('inspector'),
            },
            t('view.inspector'),
          ),
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              className: 'rafx-panelTab',
              'aria-selected': tab === 'settings',
              onClick: () => setTab('settings'),
            },
            t('view.settings'),
          ),
        ),
        tab === 'inspector'
          ? h(RafRunsView, { t, sessionId, allowAllSessions: true })
          : h(RafSettingsContent, { t }),
      );
    }

    const TOOL_BADGES = Object.freeze({
      add_document: 'AD',
      list_documents: 'LD',
      llm_query: 'LQ',
      search: 'SR',
      outline: 'OL',
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

    function baseToolName(name) {
      return typeof name === 'string' ? name.replace(/^(?:raf|ref|dsh)_/, '') : String(name ?? '');
    }

    function toolBadge(name) {
      if (typeof name !== 'string') return '?';
      const base = baseToolName(name);
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
      if (run === null || typeof run !== 'object') return { ...usageOfCalls([]), rootCacheHitRate: 0 };
      let rootInput = 0;
      let rootCached = 0;
      for (const entry of Array.isArray(run.events) ? run.events : []) {
        const event = entry === null || typeof entry !== 'object' ? null : entry.event;
        if (event !== null && typeof event === 'object' && event.type === 'llm_call' && event.role === 'root' && event.usage !== null && typeof event.usage === 'object') {
          rootInput += Number(event.usage.promptTokens ?? 0);
          rootCached += Number(event.usage.cachedTokens ?? 0);
        }
      }
      const computedRootCache = rootInput > 0 ? rootCached / rootInput : 0;
      if (run.usage !== null && typeof run.usage === 'object') {
        return {
          input: Number(run.usage.input ?? 0),
          output: Number(run.usage.output ?? 0),
          cached: Number(run.usage.cached ?? 0),
          calls: Number(run.usage.calls ?? 0),
          errors: Number(run.usage.errors ?? 0),
          latencyMs: Number(run.usage.latencyMs ?? 0),
          cacheHitRate: Number(run.usage.cacheHitRate ?? 0),
          rootCacheHitRate: Number(run.usage.rootCacheHitRate ?? computedRootCache),
        };
      }
      let usage = { input: 0, output: 0, cached: 0, calls: 0, cacheHitRate: 0, rootCacheHitRate: computedRootCache };
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
      usage.rootCacheHitRate = computedRootCache;
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

    function summarizeEventActivity(event) {
      if (event === null || typeof event !== 'object') return '';
      switch (event.type) {
        case 'run_start':
          return String(event.question ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        case 'step_start':
          return `Step ${event.step ?? 0} · ctx ${formatTokens(event.contextTokens ?? 0)} tok · ${event.blocks ?? 0} blocks`;
        case 'llm_call':
          return `LLM ${event.model ?? event.role ?? ''} · ${formatTokens(event.usage?.promptTokens ?? 0)} in / ${formatTokens(event.usage?.completionTokens ?? 0)} out`;
        case 'llm_response':
          return String(event.reasoning || event.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        case 'fold': {
          const directive = event.outcome?.directive ?? event.requested;
          return `Fold ${event.outcome?.kind ?? ''}: ${String(directive?.summary ?? '').slice(0, 100)}`.trim();
        }
        case 'tool_call': {
          const action = event.action !== null && typeof event.action === 'object' ? event.action : {};
          const mot = String(event.motivation ?? '').replace(/\s+/g, ' ').trim();
          return `${action.name ?? 'tool'}${mot ? ': ' + mot.slice(0, 100) : ''}`;
        }
        case 'tool_result':
          return `${event.name ?? 'tool'} → ${formatTokens(event.tokens ?? 0)} tok`;
        case 'llm_query':
          return `llm_query (${event.mode ?? 'locate'}, ${event.relevant ?? 0}/${event.chunks ?? 0} hits): ${String(event.query ?? '').slice(0, 90)}`;
        case 'answer':
          return `Answer: ${String(event.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 110)}`;
        case 'error':
        case 'format_error':
          return `Error: ${String(event.message ?? (Array.isArray(event.errors) ? event.errors.join('; ') : 'error')).slice(0, 110)}`;
        default:
          return '';
      }
    }

    function buildRunModel(run) {
      if (run === null || typeof run !== 'object' || !Array.isArray(run.events)) return null;
      const agents = [];
      const agentsByName = new Map();
      const activeByDepth = [];
      const now = Date.now();

      const createAgentNode = (name, depth, parent, at, question, scope, isFollowUp) => {
        const agent = {
          id: 'agent:' + String(agents.length),
          name,
          depth,
          parentId: parent === null ? null : parent.id,
          parentName: parent === null ? (depth > 0 ? 'root' : null) : parent.name,
          scope: scope ?? null,
          isFollowUp: Boolean(isFollowUp),
          question: String(question ?? ''),
          startedAt: at,
          endedAt: null,
          terminated: null,
          steps: [],
          events: [],
          errors: [],
          childAgentIds: [],
          usage: usageOfCalls([]),
          currentStage: 'starting',
          lastActivity: String(question ?? '').replace(/\s+/g, ' ').trim().slice(0, 120),
        };
        agents.push(agent);
        agentsByName.set(name, agent);
        activeByDepth[depth] = agent;
        if (parent !== null) {
          if (!parent.childAgentIds.includes(agent.id)) {
            parent.childAgentIds.push(agent.id);
          }
          const parentStep = parent.steps[parent.steps.length - 1];
          if (parentStep !== undefined) {
            const branchTool =
              [...parentStep.tools].reverse().find((tool) => baseToolName(tool.name) === 'branch' && tool.result === null) ??
              [...parentStep.tools].reverse().find((tool) => baseToolName(tool.name) === 'branch');
            if (branchTool !== undefined) {
              if (branchTool.childAgentId === null) branchTool.childAgentId = agent.id;
              if (!branchTool.childAgentIds.includes(agent.id)) {
                branchTool.childAgentIds.push(agent.id);
              }
            }
          }
        }
        return agent;
      };

      const ensureStep = (agent, stepIndex, at) => {
        let step = agent.steps.find((candidate) => candidate.index === stepIndex);
        if (step === undefined) {
          const previous = agent.steps[agent.steps.length - 1];
          if (previous !== undefined && previous.endedAt === null) previous.endedAt = at;
          step = {
            index: stepIndex,
            at,
            endedAt: null,
            contextTokens: 0,
            blocks: 0,
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
        }
        return step;
      };

      for (const entry of run.events) {
        const event = entry === null || typeof entry !== 'object' ? null : entry.event;
        if (event === null || typeof event !== 'object') continue;
        if (event.type === 'run_start') {
          const name = String(event.agent ?? 'root');
          const depth = Number(event.depth ?? (name === 'root' ? 0 : 1));
          if (
            name === 'root' &&
            agents.length === 1 &&
            agents[0].name === 'root' &&
            agents[0].question === ''
          ) {
            const existingRoot = agents[0];
            existingRoot.question = String(event.question ?? '');
            existingRoot.currentStage = 'starting';
            if (!existingRoot.lastActivity) {
              existingRoot.lastActivity = summarizeEventActivity(event);
            }
            continue;
          }
          const parentName = typeof event.parent === 'string' && event.parent !== '' && event.parent !== 'user' ? event.parent : null;
          const parent =
            parentName !== null
              ? agentsByName.get(parentName) ?? (depth > 0 ? activeByDepth[depth - 1] ?? agents[0] ?? null : null)
              : depth > 0
                ? activeByDepth[depth - 1] ?? agents[0] ?? null
                : null;
          createAgentNode(
            name,
            depth,
            parent,
            entry.at,
            event.question ?? '',
            event.scope ?? null,
            event.isFollowUp,
          );
          continue;
        }
        if (event.type === 'run_end') {
          const name = String(event.agent ?? 'root');
          const depth = Number(event.depth ?? 0);
          const agent = agentsByName.get(name) ?? activeByDepth[depth] ?? agents[0] ?? null;
          if (agent !== null) {
            agent.endedAt = entry.at;
            agent.terminated = String(event.terminated ?? 'answer');
            agent.currentStage =
              agent.terminated === 'error' || agent.terminated === 'filtered' ? 'error' : 'done';
          }
          continue;
        }
        const agentName = String(event.agent ?? 'root');
        let agent = agentsByName.get(agentName);
        if (agent === undefined) {
          const fallbackDepth = Number(event.depth ?? (agentName === 'root' ? 0 : 1));
          const fallbackParent = fallbackDepth > 0 ? agents[0] ?? null : null;
          agent = createAgentNode(
            agentName,
            fallbackDepth,
            fallbackParent,
            entry.at,
            agentName === 'root' ? (run.question ?? '') : '',
            null,
            false,
          );
        }
        const activity = summarizeEventActivity(event);
        if (activity !== '') agent.lastActivity = activity;

        if (event.type === 'step_start') {
          const stepIndex = Number(event.step ?? agent.steps.length);
          const step = ensureStep(agent, stepIndex, entry.at);
          step.contextTokens = Number(event.contextTokens ?? step.contextTokens);
          step.blocks = Number(event.blocks ?? step.blocks);
          step.events.push(entry);
          agent.events.push(entry);
          agent.currentStage = 'perceive';
          continue;
        }

        const targetStepIndex =
          event.step !== undefined
            ? Number(event.step)
            : agent.steps.length > 0
              ? agent.steps[agent.steps.length - 1].index
              : 0;
        const step = ensureStep(agent, targetStepIndex, entry.at);
        agent.events.push(entry);
        step.events.push(entry);

        switch (event.type) {
          case 'llm_call':
            step.llmCalls.push(event);
            agent.currentStage = 'llm';
            break;
          case 'llm_response':
            step.responses.push(event);
            agent.currentStage = 'reason';
            break;
          case 'fold':
            step.folds.push(event);
            agent.currentStage = 'fold';
            break;
          case 'tool_call': {
            const action = event.action !== null && typeof event.action === 'object' ? event.action : {};
            const toolName = String(action.name ?? 'tool');
            agent.currentStage = `tool:${toolName}`;
            step.tools.push({
              key: `${agent.id}:${step.index}:${step.tools.length}`,
              name: toolName,
              args: action.arguments ?? {},
              motivation: String(event.motivation ?? ''),
              at: entry.at,
              endedAt: null,
              result: null,
              tokens: null,
              error: null,
              childAgentId: null,
              childAgentIds: [],
            });
            break;
          }
          case 'tool_result': {
            const tool =
              [...step.tools].reverse().find((candidate) => candidate.result === null && candidate.name === event.name) ??
              [...step.tools].reverse().find((candidate) => candidate.result === null);
            if (tool !== undefined) {
              tool.result = String(event.observation ?? '');
              tool.tokens = Number(event.tokens ?? 0);
              tool.error = event.error === undefined ? null : String(event.error);
              tool.endedAt = entry.at;
            }
            break;
          }
          case 'llm_query':
            step.queries.push(event);
            agent.currentStage = 'query';
            break;
          case 'format_error':
            step.errors.push(event);
            agent.currentStage = 'error';
            break;
          case 'error':
            agent.errors.push(event);
            step.errors.push(event);
            agent.currentStage = 'error';
            break;
          case 'answer':
            step.answer = String(event.answer ?? '');
            agent.currentStage = 'answer';
            break;
          default:
            break;
        }
      }

      for (const agent of agents) {
        if (agent.endedAt === null && run.status !== 'running') {
          agent.endedAt = run.endedAt ?? now;
          agent.currentStage = run.status === 'error' ? 'error' : 'done';
        }
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

      // Order agents in tree hierarchy (DFS from roots) so sub-agents group under their parent.
      const ordered = [];
      const visited = new Set();
      const byId = new Map(agents.map((a) => [a.id, a]));
      const visit = (agent) => {
        if (!agent || visited.has(agent.id)) return;
        visited.add(agent.id);
        ordered.push(agent);
        for (const childId of agent.childAgentIds) {
          const child = byId.get(childId);
          if (child) visit(child);
        }
      };
      for (const agent of agents) {
        if (agent.parentId === null) visit(agent);
      }
      for (const agent of agents) {
        if (!visited.has(agent.id)) visit(agent);
      }
      return { agents: ordered };
    }

    if (typeof window !== 'undefined') {
      window.__RAF_BUILD_RUN_MODEL__ = buildRunModel;
    }

    function RunTool({ t, tool, open, onToggle, agentById, onOpenAgent }) {
      const status = tool.error !== null ? 'error' : tool.result !== null ? 'done' : 'running';
      const childIds =
        Array.isArray(tool.childAgentIds) && tool.childAgentIds.length > 0
          ? tool.childAgentIds
          : tool.childAgentId !== null
            ? [tool.childAgentId]
            : [];
      const children = childIds.map((id) => agentById.get(id)).filter(Boolean);
      const displayTool = baseToolName(tool.name);
      const motPreview = tool.motivation ? tool.motivation.replace(/\s+/g, ' ').trim() : '';
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
          motPreview !== '' ? h('span', { className: 'rafx-toolMot', title: motPreview }, motPreview) : null,
          h(
            'span',
            { className: 'rafx-toolMeta' },
            [
              children.length > 0 ? `${children.length} sub` : null,
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
              tool.motivation
                ? h(
                    'div',
                    { className: 'rafx-field' },
                    h('span', { className: 'rafx-fieldLabel' }, t('view.motivation')),
                    h('pre', { className: 'rafx-pre' }, tool.motivation),
                  )
                : null,
              h(
                'div',
                { className: 'rafx-field' },
                h('span', { className: 'rafx-fieldLabel' }, t('view.arguments')),
                h('pre', { className: 'rafx-pre' }, prettyJson(tool.args)),
              ),
              children.length === 0
                ? null
                : h(
                    'div',
                    { className: 'rafx-childLinks' },
                    children.map((child) =>
                      h(
                        'button',
                        {
                          key: child.id,
                          type: 'button',
                          className: 'rafx-dockBtn',
                          onClick: () => onOpenAgent(child.id),
                        },
                        `${t('view.openAgent')} → ${child.name}`,
                      ),
                    ),
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

    function RunStep({ t, step, open = true, onToggleStep, openTools, onToggleTool, agentById, onOpenAgent }) {
      const duration = (step.endedAt ?? Date.now()) - step.at;
      const stagePills = [];
      if (step.llmCalls.length > 0) stagePills.push(`LLM×${step.llmCalls.length}`);
      if (step.responses.length > 0) stagePills.push('REASON');
      if (step.folds.length > 0) stagePills.push(`FOLD:${step.folds[step.folds.length - 1]?.outcome?.kind ?? 'ok'}`);
      if (step.tools.length > 0) stagePills.push(`TOOL×${step.tools.length}`);
      if (step.queries.length > 0) stagePills.push(`QUERY×${step.queries.length}`);
      if (step.answer !== null) stagePills.push('ANSWER');
      if (step.errors.length > 0) stagePills.push('ERROR');

      const headerContent = h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'rafx-stepPills' },
          onToggleStep !== undefined
            ? h('span', { className: 'rafx-treeAgentChevron', 'aria-hidden': true }, open ? '▾' : '▸')
            : null,
          h('span', { className: 'rafx-stepTag' }, `step ${step.index}`),
          stagePills.map((pill) => h('span', { key: pill, className: 'rafx-stepPill' }, pill)),
        ),
        h(
          'span',
          { className: 'rafx-stepMeta' },
          [
            `ctx ${formatTokens(step.contextTokens)}`,
            `blocks ${step.blocks}`,
            step.usage.input > 0
              ? `${formatTokens(step.usage.input)} in / ${formatTokens(step.usage.output)} out · cache ${formatPercent(step.usage.cacheHitRate)}`
              : null,
            formatDuration(duration),
          ]
            .filter((v) => v !== null)
            .join(' · '),
        ),
      );

      return h(
        'section',
        { className: 'rafx-step' },
        h(
          'header',
          { className: 'rafx-stepHead' },
          onToggleStep !== undefined
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'rafx-stepToggle',
                  'aria-expanded': open,
                  onClick: onToggleStep,
                },
                headerContent,
              )
            : headerContent,
        ),
        !open
          ? null
          : h(
              React.Fragment,
              null,
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
                          h(
                            'span',
                            null,
                            `cache ${formatPercent(call.usage?.promptTokens ? (call.usage.cachedTokens ?? 0) / call.usage.promptTokens : 0)}`,
                          ),
                          call.finishReason ? h('span', null, `finish=${call.finishReason}`) : null,
                          call.attempt ? h('span', null, `retry=${call.attempt}`) : null,
                          h('span', null, formatDuration(call.latencyMs ?? 0)),
                        ),
                      ),
                    ),
                  ),
              step.responses.map((response, responseIndex) =>
                h(
                  'details',
                  { className: 'rafx-response', key: `${step.index}:response:${responseIndex}` },
                  h(
                    'summary',
                    null,
                    h('span', null, t('view.thinking')),
                    response.reasoning
                      ? h(
                          'span',
                          { className: 'rafx-llmMeta' },
                          `${t('view.reasoning')} (${formatTokens(response.reasoning.length / 3.6)} tok)`,
                        )
                      : null,
                  ),
                  response.reasoning === undefined || response.reasoning === ''
                    ? null
                    : h(
                        'div',
                        { className: 'rafx-field' },
                        h('span', { className: 'rafx-fieldLabel' }, t('view.reasoning')),
                        h('pre', { className: 'rafx-pre' }, response.reasoning),
                      ),
                  h(
                    'div',
                    { className: 'rafx-field' },
                    h('span', { className: 'rafx-fieldLabel' }, t('view.thinking')),
                    h('pre', { className: 'rafx-pre' }, response.text === '' ? '—' : response.text),
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
            ),
      );
    }

    function RafRunsView({ t, sessionId, allowAllSessions = false }) {
      const [runs, setRuns] = React.useState([]);
      const [selectedRunId, setSelectedRunId] = React.useState(null);
      const [run, setRun] = React.useState(null);
      const [selectedAgentId, setSelectedAgentId] = React.useState(null);
      const [openSteps, setOpenSteps] = React.useState(() => new Set());
      const [openTools, setOpenTools] = React.useState(() => new Set());
      const [error, setError] = React.useState(null);
      const manual = React.useRef(false);
      const runningRef = React.useRef(false);

      React.useEffect(() => {
        const hasSession = typeof sessionId === 'string' && sessionId.trim() !== '';
        if (!hasSession && !allowAllSessions) return undefined;
        let active = true;
        let timer = 0;
        const load = async () => {
          try {
            const next = await getRuns(hasSession ? sessionId : undefined);
            if (!active) return;
            setRuns(next);
            if (!manual.current && next[0] !== undefined) setSelectedRunId(next[0].id);
            setError(null);
          } catch (reason) {
            if (active) setError(reason instanceof Error ? reason.message : String(reason));
          } finally {
            if (active) timer = window.setTimeout(load, 1800);
          }
        };
        void load();
        return () => {
          active = false;
          if (timer !== 0) window.clearTimeout(timer);
        };
      }, [sessionId, allowAllSessions]);

      React.useEffect(() => {
        setSelectedAgentId(null);
        setOpenSteps(new Set());
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
            if (active) timer = window.setTimeout(load, runningRef.current ? 600 : 2500);
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

      const toggleStep = (stepKey) => {
        setOpenSteps((current) => {
          const next = new Set(current);
          if (next.has(stepKey)) next.delete(stepKey);
          else next.add(stepKey);
          return next;
        });
      };

      const toggleTool = (key) => {
        setOpenTools((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };

      const hasSession = typeof sessionId === 'string' && sessionId.trim() !== '';
      if (!hasSession && !allowAllSessions) {
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
                h(
                  'span',
                  { className: 'rafx-runsChip', 'data-status': status },
                  h('span', { className: 'rafx-runsDot', 'aria-hidden': true }),
                  runStatusLabel(t, status),
                ),
                modelName === '' ? null : h('span', { className: 'rafx-runsChip' }, modelName),
                settings === null || settings === undefined
                  ? null
                  : h(
                      'span',
                      { className: 'rafx-runsChip' },
                      `depth ${settings.depth} · reserve ${Math.round(settings.reserve * 100)}% · readers ${settings.concurrency}`,
                    ),
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
            h(RafStat, { label: t('view.agents'), value: String(agents.length || (run?.agentCount ?? selectedSummary?.agentCount ?? 0)) }),
            h(RafStat, { label: t('view.tokens'), value: `${formatTokens(usage.input)} / ${formatTokens(usage.output)}` }),
            h(RafStat, { label: t('view.rootCache'), value: formatPercent(usage.rootCacheHitRate ?? usage.cacheHitRate) }),
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
                      `${candidate.steps.length} ${t('view.steps').toLowerCase()} · ${formatTokens(candidate.usage.input)} in · ${candidate.currentStage}`,
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
                            `← ${t('view.parent')} (${agent.parentName ?? 'root'})`,
                          ),
                      h('h2', null, agent.depth === 0 ? t('view.root') : agent.name),
                      h('span', { className: 'rafx-agentDepth' }, `d${agent.depth}`),
                      agent.scope ? h('span', { className: 'rafx-agentDepth' }, `scope=${agent.scope}`) : null,
                      h('span', { className: 'rafx-agentState', 'data-status': agentStatus(agent) }, agentStateLabel(t, agent)),
                    ),
                    agent.question
                      ? h('div', { className: 'rafx-treeTask' }, agent.question)
                      : null,
                    h(
                      'div',
                      { className: 'rafx-agentHeadMeta' },
                      `${agent.steps.length} ${t('view.steps').toLowerCase()} · ${formatTokens(agent.usage.input)} in / ${formatTokens(agent.usage.output)} out · cache ${formatPercent(agent.usage.cacheHitRate)}`,
                    ),
                  ),
                  agent.steps.length === 0
                    ? h('div', { className: 'rafx-timelineEmpty' }, h('p', null, t('view.noSteps')))
                    : agent.steps.map((step) => {
                        const stepKey = `${agent.id}:${step.index}`;
                        const isStepOpen = !openSteps.has(`closed:${stepKey}`);
                        return h(RunStep, {
                          key: stepKey,
                          t,
                          step,
                          open: isStepOpen,
                          onToggleStep: () => toggleStep(`closed:${stepKey}`),
                          openTools,
                          onToggleTool: toggleTool,
                          agentById,
                          onOpenAgent: (id) => setSelectedAgentId(id),
                        });
                      }),
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

    function parseBranchArgs(raw) {
      if (typeof raw !== 'string' || raw.trim() === '') return null;
      try {
        const value = JSON.parse(raw);
        return value !== null && typeof value === 'object' ? value : null;
      } catch {
        return null;
      }
    }

    function branchTasksOf(args) {
      if (args === null || typeof args !== 'object') return [];
      const raw = Array.isArray(args.tasks)
        ? args.tasks
        : typeof args.task === 'string'
          ? [{ scope: args.scope, task: args.task }]
          : [];
      const tasks = [];
      for (const item of raw) {
        if (typeof item === 'string') {
          if (item.trim() !== '') tasks.push({ scope: '', task: item });
          continue;
        }
        if (item !== null && typeof item === 'object' && typeof item.task === 'string' && item.task.trim() !== '') {
          tasks.push({ scope: typeof item.scope === 'string' ? item.scope : '', task: item.task });
        }
      }
      return tasks;
    }

    function branchResultText(block) {
      const parts = [];
      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (item !== null && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
            parts.push(item.text);
          } else if (item !== null && item !== undefined) {
            try {
              parts.push(JSON.stringify(item, null, 2));
            } catch {
              // Skip a value that JSON cannot render.
            }
          }
        }
      }
      if (parts.length === 0 && block.error !== undefined && block.error !== null) {
        if (typeof block.error === 'string') parts.push(block.error);
        else if (typeof block.error.name === 'string') {
          parts.push(`${block.error.name}${typeof block.error.code === 'string' ? `: ${block.error.code}` : ''}`);
        }
      }
      return parts.join('\n').trim();
    }

    function splitBranchResults(text) {
      const results = new Map();
      if (typeof text !== 'string' || text === '') return results;
      const parts = text.split(/\n(?=\[Subtask #\d+\])/);
      for (const part of parts) {
        const match = /^\[Subtask #(\d+)\]\s*/.exec(part.trimStart());
        if (match === null) continue;
        const index = Number(match[1]) - 1;
        results.set(index, part.trimStart().slice(match[0].length).trim());
      }
      return results;
    }

    function cleanBranchResult(result, task) {
      let text = result;
      text = text.replace(/^\[scope=[^\]]*\]\s*/i, '');
      if (task !== '' && text.startsWith(task)) text = text.slice(task.length);
      text = text.replace(/^\[scope=[^\]]*\]\s*/i, '');
      return text.trim();
    }

    function runHasBranch(run, args) {
      if (run === null || typeof run !== 'object' || args === null) return true;
      const target = JSON.stringify(args);
      for (const entry of Array.isArray(run.events) ? run.events : []) {
        const event = entry === null || typeof entry !== 'object' ? undefined : entry.event;
        if (
          event !== null &&
          typeof event === 'object' &&
          event.type === 'tool_call' &&
          event.agent === 'root' &&
          event.action?.name === 'raf_branch' &&
          JSON.stringify(event.action.arguments ?? null) === target
        ) {
          return true;
        }
      }
      return false;
    }

    function findBranchAgent(agents, task, index) {
      const scoped = task.scope === '' ? [] : agents.filter((agent) => agent.scope === task.scope);
      const pool = scoped.length > 0 ? scoped : agents;
      const text = task.task;
      const byText = pool.find((agent) => {
        if (typeof agent.question !== 'string' || agent.question === '') return false;
        return (
          agent.question === text ||
          agent.question.includes(text.slice(0, 80)) ||
          text.includes(agent.question.slice(0, 80))
        );
      });
      return byText ?? pool[index];
    }

    /** Native tool row for raf_branch: per-task disclosure with live child steps. */
    function RafBranchToolView(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const [expanded, setExpanded] = React.useState(() => {
        const initial = props.block;
        return !(props.phase === 'result' || (initial !== null && typeof initial === 'object' && 'kind' in initial));
      });
      const [openTasks, setOpenTasks] = React.useState(() => new Set());
      const [openSteps, setOpenSteps] = React.useState(() => new Set());
      const [openTools, setOpenTools] = React.useState(() => new Set());
      const [run, setRun] = React.useState(null);
      const block = props.block;
      const done = block !== null && typeof block === 'object' && 'kind' in block;
      const phase = props.phase !== undefined ? props.phase : done ? 'result' : block?.phase;
      const argsRaw = done ? block.call?.argsRaw ?? '' : block?.argsRaw ?? '';
      const args = parseBranchArgs(argsRaw);
      const tasks = branchTasksOf(args);
      const result = done ? branchResultText(block) : '';
      const perTask = done ? splitBranchResults(result) : new Map();
      const sessionId = typeof props.rafSessionId === 'string' ? props.rafSessionId : '';
      const state = done
        ? block.error?.code === 'interrupted'
          ? 'stopped'
          : block.isError === true || block.meta?.stopped === true
            ? 'error'
            : 'ok'
        : phase === 'preparing'
          ? 'preparing'
          : 'running';

      React.useEffect(() => {
        if (sessionId === '') return undefined;
        let active = true;
        let timer = 0;
        let attempts = 0;
        const load = async () => {
          attempts += 1;
          try {
            const runs = await getRuns(sessionId);
            if (!active) return;
            const latest = Array.isArray(runs) ? runs[0] : undefined;
            if (latest === undefined) {
              if (attempts < 10) timer = window.setTimeout(load, 3000);
              return;
            }
            const detail = await getRun(latest.id);
            if (!active) return;
            setRun(runHasBranch(detail, args) ? detail : null);
            if (!done && latest.status === 'running') timer = window.setTimeout(load, 800);
          } catch {
            if (active && attempts < 10) timer = window.setTimeout(load, done ? 5000 : 2000);
          }
        };
        void load();
        return () => {
          active = false;
          if (timer !== 0) window.clearTimeout(timer);
        };
      }, [sessionId, done, argsRaw]);

      const model = React.useMemo(() => (run === null ? null : buildRunModel(run)), [run]);
      const branchAgents = model === null ? [] : model.agents.filter((agent) => agent.depth === 1);
      const agentById = React.useMemo(() => new Map((model?.agents ?? []).map((agent) => [agent.id, agent])), [model]);

      const scopes = [];
      for (const task of tasks) {
        if (task.scope !== '' && !scopes.includes(task.scope)) scopes.push(task.scope);
      }
      const countLabel =
        tasks.length > 0 ? `${t('tool.branch.tasks')}: ${tasks.length}` : phase === 'preparing' ? t('tool.branch.running') : '';
      const summary = [countLabel, ...scopes].filter(Boolean).join(' · ');
      const expandable = tasks.length > 0 || result !== '';
      const open = expanded && expandable;
      const toggle = () => {
        if (expandable) setExpanded((value) => !value);
      };
      const onKeyDown = (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle();
        }
      };
      const toggleTask = (index) => {
        setOpenTasks((current) => {
          const next = new Set(current);
          if (next.has(index)) next.delete(index);
          else next.add(index);
          return next;
        });
      };
      const toggleStep = (key) => {
        setOpenSteps((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      const toggleTool = (key) => {
        setOpenTools((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
      };
      return h(
        'div',
        { className: 'rafx-branch', 'data-state': state },
        h(
          'div',
          {
            className: 'rafx-branchHead',
            'data-state': state,
            role: expandable ? 'button' : undefined,
            tabIndex: expandable ? 0 : undefined,
            'aria-expanded': expandable ? open : undefined,
            onClick: toggle,
            onKeyDown,
          },
          h('span', { className: 'rafx-branchChevron', 'aria-hidden': true }, expandable ? (open ? '▾' : '▸') : ''),
          h('span', { className: 'rafx-branchIcon', 'aria-hidden': true }, h(RafMark, { size: 14 })),
          h('span', { className: 'rafx-branchTitle' }, t('tool.branch.title')),
          ...(summary !== ''
            ? [
                h('span', { className: 'rafx-branchSep', 'aria-hidden': true }),
                h('span', { className: 'rafx-branchSummary' }, summary),
              ]
            : []),
        ),
        open
          ? h(
              'div',
              { className: 'rafx-branchBody' },
              tasks.map((task, index) => {
                const agent = findBranchAgent(branchAgents, task, index);
                const taskResult = perTask.get(index);
                const cleanedResult = taskResult === undefined ? undefined : cleanBranchResult(taskResult, task.task);
                const taskOpen = openTasks.has(index);
                const stage =
                  agent === undefined
                    ? ''
                    : agent.currentStage || (agent.status === 'running' ? t('tool.branch.running') : agent.status === 'done' ? t('tool.branch.done') : '');
                return h(
                  'div',
                  { className: 'rafx-branchTaskWrap', key: `branch-task:${index}` },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'rafx-branchTaskHead',
                      'aria-expanded': taskOpen,
                      onClick: () => toggleTask(index),
                    },
                    h('span', { className: 'rafx-branchTaskChevron', 'aria-hidden': true }, taskOpen ? '▾' : '▸'),
                    h('span', { className: 'rafx-branchTaskNo' }, `#${index}`),
                    task.scope !== '' ? h('span', { className: 'rafx-branchScope' }, task.scope) : null,
                    h('span', { className: 'rafx-branchTaskText' }, task.task),
                    stage !== '' ? h('span', { className: 'rafx-branchTaskStage' }, stage) : null,
                  ),
                  taskOpen
                    ? h(
                        'div',
                        { className: 'rafx-branchTaskBody' },
                        agent !== undefined && agent.steps.length > 0
                          ? agent.steps.map((step) => {
                              const stepKey = `${agent.id}:${step.index}`;
                              return h(RunStep, {
                                key: stepKey,
                                t,
                                step,
                                open: openSteps.has(stepKey) || step === agent.steps[agent.steps.length - 1],
                                onToggleStep: () => toggleStep(stepKey),
                                openTools,
                                onToggleTool: toggleTool,
                                agentById,
                                onOpenAgent: () => {},
                              });
                            })
                          : cleanedResult !== undefined && cleanedResult !== ''
                            ? h('div', { className: 'rafx-branchTaskResult' }, cleanedResult)
                            : h('div', { className: 'rafx-branchTaskEmpty' }, t('tool.branch.noSteps')),
                      )
                    : null,
                );
              }),
              result !== '' && perTask.size === 0
                ? h(
                    'div',
                    { className: 'rafx-branchResult' },
                    h('span', { className: 'rafx-branchResultLabel' }, t('tool.branch.result')),
                    h('pre', { className: 'rafx-branchResultText' }, result),
                  )
                : null,
              typeof props.inspect === 'function'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'rafx-branchInspect',
                      onClick: (event) => {
                        event.stopPropagation();
                        props.inspect();
                      },
                    },
                    t('view.inspector'),
                  )
                : null,
            )
          : null,
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

      ctx.inject(['configForms'], (scope) => {
        try {
          const chatSettings = scope.configForms?.get?.('ui-chat');
          if (chatSettings === undefined || typeof chatSettings.set !== 'function') return;
          const current = chatSettings.getSnapshot?.().value?.transcriptView;
          if (current !== 'verbose') void chatSettings.set('transcriptView', 'verbose').catch(() => {});
        } catch {
          // Chat settings are optional; the native selector still works.
        }
      });

      ctx.effect(
        () =>
          ctx.slots.inject('tool.call.toolview', () => {
            const offBranch = ctx.slots.register(
              {
                name: 'tool.call.toolview',
                key: 'branch',
                locale: NS,
                inject: (sessionId) => ({ rafSessionId: sessionId }),
              },
              RafBranchToolView,
            );
            const offLegacy = ctx.slots.register(
              {
                name: 'tool.call.toolview',
                key: 'raf_branch',
                locale: NS,
                inject: (sessionId) => ({ rafSessionId: sessionId }),
              },
              RafBranchToolView,
            );
            return () => {
              if (typeof offBranch === 'function') offBranch();
              if (typeof offLegacy === 'function') offLegacy();
            };
          }),
        'raf: branch tool view',
      );

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
