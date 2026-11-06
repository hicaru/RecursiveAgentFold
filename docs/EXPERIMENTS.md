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

## 2026-11-06: сравнение с публичными бенчмарками GLM (web)

Модель прогонов: `glm-5.3-flash` (легкая варианта; флагман GLM-5.3 = 753B MoE, 1M контекст). Публичные long-context цифры для GLM-5.3: LongBench-Pro 72.6%, RULER 81.4%, OpenAI-MRCR 74.3%, NIAH 97.7% (насыщен, низкое доверие) — trustthebench.com. LongBench v2 (503 задачи, без инструментов): GLM-5 = 60.8% (#8, llmlearner.com, окт 2026); GLM-4.5 = 50.3% w/CoT (официальный longbench2.github.io); GLM-5.3 не публиковался.

| Наш прогон (n) | Наш результат | Публичный ориентир | Оценка |
|---|---|---|---|
| longbench-v2 (6) | 66.7% (4/6); Code Repo 3/3 | GLM-5: 60.8% (n=503, ±4.3pp, без тулов) | point-estimate выше, но 95% CI наш ≈ [37%, 90%] — статистически неотличимо; у нас тула + агент, не apples-to-apples |
| needle 1M (4) | 100% (4/4) | GLM-5.3 NIAH: 97.7% (насыщенный бенч) | оба у потолка, сравнение бессмысленно при n=4 |
| oolong trec_coarse (5) | 100% (5/5) | публичного аналога не найдено | — |
| codegraph (6) | 100% (6/6) @ d2 | собственный синтетический бенч | — |

Вывод: на пересекающихся бенчах наш агентный результат не хуже опубликованных цифр флагмана при том, что гонялась flash-варианта с тулами; выборка 4–6 задач статистически ничтожна. Следующий шаг для значимого сравнения: полный longbench-v2 (503) на d2. Источники: huggingface.co/zai-org/GLM-5.3, longbench2.github.io, llmlearner.com/rankings/longbench-v2, trustthebench.com/models/z-ai-glm-5-3, llm-stats.com/models/glm-5.3, docs.z.ai/guides/llm/glm-5.3.

## 2026-11-06 (позже): новые бенчмарки RULER / MRCR / LongBench-Pro

Добавлены генераторы+CLI (`ruler`, `mrcr`, `longbench-pro`) и общий `util/rng.ts`. Публичные ориентиры (GLM-5.3, trustthebench): RULER 81.4%, OpenAI-MRCR 74.3%, LongBench-Pro 72.6% — без инструментов, полные наборы длин; наши прогоны — glm-5.3-flash + тула, 131k, малые n, поэтому сравнение индикативное.

| Каталог | Гипотеза | Команда | Метрики | Публичный ориентир | Вердикт |
|---|---|---|---|---|---|
| `exp-ruler-131k-d2-v3` | RULER-синтетика решается тулами (grep/tally) на 131k | `bench ruler --tokens 131072 --tasks 1` | **11/11 (100%)**, cache 90.4%, $0.0071/задача, 2.2 шага | 81.4% (без тулов) | ✅ выше; оверхед-режим: tally решает cwe/fwe детерминированно |
| `exp-mrcr-131k-d2` | MRCR co-reference: агент выводит стратегию grep→tally→tally | `bench mrcr --tokens 131072 --tasks 6` | **F1 1.000 (6/6)**, cache 82.6%, $0.049/задача, 4 шага | 74.3% (OpenAI-MRCR) | ✅ выше; наш шаблон проще официального (1 предложение/инстанс) |
| `exp-longbench-pro-d2` | Реальный long-doc QA (v1.0 open-ended, публичное зеркало caskcsg; TIGER-Lab v1.1 gated) | `bench longbench-pro --limit 6` | **2/6 (33.3%)**; Sequencing 2/3, Retrieval 0/2, Attribution 0/1; cache 50.4%, $0.061/задача | 72.6% | ⚠️ НИЖЕ ориентира; n=6, скоринг lenient-containment вместо LLM-судьи, часть неудач — формат multi-item ответов |

Баги, найденные и починенные в процессе (все с юнит-тестами):
1. RULER v1: общая группа задач → runner строит ContextStore из документов первой задачи группы; разные стоги в одной группе = ответы из чужого стога (1/11). Фикс: per-task group. Тест: группы и стоги уникальны.
2. RULER v2: коллизия seed по длине имени подзадачи (single_1/2/3 → один стог). Фикс: name-hash.
3. cwe/fwe: label-слова и повторы компонентов шума доминировали в частотах. Фикс: digit-only токены + реальные слова-дистракторы (2×) vs commons/кодированные (частые/3×); инвариант top10==gold проверен скриптом и тестом.
4. vt: золото без транзитивного замыкания цепочек. Фикс: классы эквивалентности valueId, дистракторы не ссылаются в класс X1.
5. LongBench-Pro: TIGER-Lab v1.1 (MCQ) gated, HF_TOKEN в .env невалиден (whoami 401). Фикс: публичное зеркало caskcsg/LongBench-Pro (v1.0, open-ended) + адаптивная схема колонок через probe-строку.

## 2026-11-06 (вечер): LongBench-Pro — токен, валидный скоринг, n=20

Валидный HF-токен (пользователь Scouting8946) вписан в `.env`; гейт `TIGER-Lab/LongBench-Pro` (v1.1 MCQ) всё ещё не принят → работаем с публичным зеркалом авторов `caskcsg/LongBench-Pro` (v1.0, open-ended; 1500 строк; схемы: `question_nonthinking/question_thinking`, `answer` = список пунктов за маркером `[答案]/[Answer]`).

Найден и починен баг скоринга: normalizer резал `[^a-z0-9]` → китайские ответы обнулялись; парсер не знал маркер `[答案]` без двоеточия. Новый скоринг: unicode-нормализация пунктов, ordered=1 / set=0.5 / miss=0(+hits).

| Каталог | Скоринг | Метрики | Публичный ориентир | Вердикт |
|---|---|---|---|---|
| `exp-longbench-pro-d2` (n=6) | старый → новый | 0.333 → **0.583** | 72.6% | мал n |
| `exp-longbench-pro-20-d2` (n=20) | старый (в прогона) → оффлайн-пересчёт новым | 0.650 → **0.825** (16 полных + 1 set-hit; −1 ложный containment-хит старого) | GLM-5.3: 72.6% (без тулов, полный набор, LLM-judge) | ✅ выше ориентира; оверхед 5 fmt-ошибок, 1 llm_query с cache 1.3% |

По типам задач (n=20, новый скоринг): T2 Sequencing 3/3, T5 Attribution 2/2, T9 Code Diff 1/1, T3 Evidence QA 1/1, T10 Rule Induction 1/1, T6 Aggregation 5.5/7, T1 Retrieval 2/3, T7 Consistency 1/2. Слабые места: T7 compliance и длинные Chinese aggregation. Кавы: у нас тула+агент против соло-модели без тулов; set-кредит 0.5 мягче judge; n=20 → CI ≈ ±17pp.

## Итог кампании

- **`DEFAULT_MAX_DEPTH = 2`** (`runtime.ts:13`): правило выбора d* ∈ {2,3} → tie 6/6, d2 дешевле d3 в 1.38× (порог 1.25×). d0/d4 вне правила (d0 — соло брут-форс 11.5 шагов, d4 — нулевой прирост).
- Регресс: только oolong cost на одном сэмпле. Кандидат на будущую работу: кэширование llm_query/чанков (longbench long-doc, cache 25%).
- Коммит: `b5940be`.
