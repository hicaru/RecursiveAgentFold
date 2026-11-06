# Журнал экспериментов

Формат: дата | каталог `results/<run>` | гипотеза (зачем) | команда | ключевые метрики | вердикт.
Артефакты каждого прогона: `config.json` (конфиг), `results.jsonl` (по задачам), `traces/*.jsonl` (пошаговые трейсы), `summary.md`. Каталоги `results/` в git не ходят.

## 2026-11-05 (baseline, сессия r5)

| Каталог | Гипотеза | Метрики | Вердикт |
|---|---|---|---|
| `r5-depth0-oolong-5` | H1: глубина 0 на oolong | 5/5 | baseline |
| `r5-depth1-oolong-5` | H1: глубина 1 | 5/5 | baseline |
| `r5-depth2-oolong-5` | H1: глубина 2 | 5/5, fmt=1, cache 21.4%, $0.0977 | baseline |
| `r5-depth3-oolong-5` | H1: глубина 3 | 5/5 | baseline |
| `r5-depth2-needle-1m` | H1: глубина 2 на needle 1M | 0.7750 (3/4), count-3=0.100 | baseline |

## 2026-11-06 (multi-agent specialists, ветка scoped specialists)

| Каталог | Гипотеза | Команда | Метрики | Вердикт |
|---|---|---|---|---|
| `verify-prompt-check` | H5: новые CN-промпты не ломают протокол | `bench prompt-check` | все пробы PASS, e2e cache 92.2%, fmt=0 | ✅ H5 |
| `exp-codegraph-d0` | H1: соло-агент на codegraph 120k | `bench codegraph --tokens 120000 --tasks 6 --hops 3 --max-depth 0` | 6/6, 11.5 шагов, cache 84.3%, $0.2825, fmt=2 | 6/6 брут-форсом; делегация не задействована |
| `exp-codegraph-d1` | H1/H3: depth-1 без leaf-consult | 同 + `--max-depth 1` | 5/6, cache 75.4%, branch 76.0%, $0.6230 | ❌ diamond-4 упал (шорт-лист констант в свёртке) |
| `exp-codegraph-d2` | H1/H2/H3/H4: scoped specialists + resumption | 同 + `--max-depth 2` | **6/6**, branch 79.2%, $0.6312, 157s/задача; прогрев: −57..76% токенов на повторных задачах | ✅ лучшая |
| `exp-codegraph-d3` | H1: d3 лучше d2? | 同 + `--max-depth 3` | 6/6, $0.8729 (1.38× d2), 258s | ❌ дороже без прироста |
| `exp-codegraph-d4` | H1: убыв. отдача d4 | 同 + `--max-depth 4` | 6/6, $0.8772, 4.33 шагов, 273s | ❌ нулевой прирост |
| `exp-longbench-d2` | H2/H4: реальный multi-doc (LongBench-v2) | `bench longbench --limit 6 --max-depth 2` | 4/6; Code Repo 3/3; root cache 82.0%; 2 неудачи на long-doc | база создана; llm_query без кэша — будущая работа |
| `exp-oolong-d2` | регрессия после multi-agent апгрейда | `bench oolong --limit 5 --max-depth 2` | 5/5, fmt 1→0, cache 21.4→39.9%, cost +32% (1 сэмпл: 2 llm_query) | ✅ точность/fmt/cache; ⚠️ cost-шум |
| `exp-needle-1m-d2` | регрессия после multi-agent апгрейда | `bench needle --tokens 1000000 --tasks 4 --max-depth 2` | 4/4 (+0.225), count-3 0.1→1.0, cost тот же | ✅ прогресс |

## Итог кампании

- **`DEFAULT_MAX_DEPTH = 2`** (`runtime.ts:13`): правило выбора d* ∈ {2,3} → tie 6/6, d2 дешевле d3 в 1.38× (порог 1.25×). d0/d4 вне правила (d0 — соло брут-форс 11.5 шагов, d4 — нулевой прирост).
- Регресс: только oolong cost на одном сэмпле. Кандидат на будущую работу: кэширование llm_query/чанков (longbench long-doc, cache 25%).
- Коммит: `b5940be`.
