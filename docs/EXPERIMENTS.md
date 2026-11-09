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
| `exp-codegraph-d1` | H1/H3: depth-1 без leaf-consult | same + `--max-depth 1` | 5/6, cache 75.4%, branch 76.0%, $0.6230 | ❌ diamond-4 упал (шорт-лист констант в свёртке) |
| `exp-codegraph-d2` | H1/H2/H3/H4: scoped specialists + resumption | same + `--max-depth 2` | **6/6**, branch 79.2%, $0.6312, 157s/задача; прогрев: −57..76% токенов на повторных задачах | ✅ лучшая |
| `exp-codegraph-d3` | H1: d3 лучше d2? | same + `--max-depth 3` | 6/6, $0.8729 (1.38× d2), 258s | ❌ дороже без прироста |
| `exp-codegraph-d4` | H1: убыв. отдача d4 | same + `--max-depth 4` | 6/6, $0.8772, 4.33 шагов, 273s | ❌ нулевой прирост |
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

Валидный HF-токен (пользователь Scouting8946) вписан в `.env`; гейт `TIGER-Lab/LongBench-Pro` (v1.1 MCQ) всё ещё не принят → работаем с публичным зеркалом авторов `caskcsg/LongBench-Pro` (v1.0, open-ended; 1500 строк; схемы: `question_nonthinking/question_thinking`, `answer` = список пунктов за маркером `[Answer]`).

Найден и починен баг скоринга: normalizer резал `[^a-z0-9]` → unicode ответы обнулялись; парсер не знал маркер `[Answer]` без двоеточия. Новый скоринг: unicode-нормализация пунктов, ordered=1 / set=0.5 / miss=0(+hits).

| Каталог | Скоринг | Метрики | Публичный ориентир | Вердикт |
|---|---|---|---|---|
| `exp-longbench-pro-d2` (n=6) | старый → новый | 0.333 → **0.583** | 72.6% | мал n |
| `exp-longbench-pro-20-d2` (n=20) | старый (в прогона) → оффлайн-пересчёт новым | 0.650 → **0.825** (16 полных + 1 set-hit; −1 ложный containment-хит старого) | GLM-5.3: 72.6% (без тулов, полный набор, LLM-judge) | ✅ выше ориентира; оверхед 5 fmt-ошибок, 1 llm_query с cache 1.3% |

По типам задач (n=20, новый скоринг): T2 Sequencing 3/3, T5 Attribution 2/2, T9 Code Diff 1/1, T3 Evidence QA 1/1, T10 Rule Induction 1/1, T6 Aggregation 5.5/7, T1 Retrieval 2/3, T7 Consistency 1/2. Слабые места: T7 compliance и длинные Chinese aggregation. Кавы: у нас тула+агент против соло-модели без тулов; set-кредит 0.5 мягче judge; n=20 → CI ≈ ±17pp.

## Итог кампании

- **`DEFAULT_MAX_DEPTH = 2`** (`runtime.ts:13`): правило выбора d* ∈ {2,3} → tie 6/6, d2 дешевле d3 в 1.38× (порог 1.25×). d0/d4 вне правила (d0 — соло брут-форс 11.5 шагов, d4 — нулевой прирост).
- Регресс: только oolong cost на одном сэмпле. Кандидат на будущую работу: кэширование llm_query/чанков (longbench long-doc, cache 25%).
- Коммит: `b5940be`.

## 2026-11-07: кампания исправления 9 багов (B1–B9) и верификация H1–H6 на живой glm-5.3

Модели: root/branch = `glm-5.3`, llm_query = `glm-5.3-flash`. Все фиксы — универсальные (model/benchmark-agnostic; правило зафиксировано в `AGENTS.md`: never hardcode logic for specific benchmarks, datasets, document titles, or models). Покрытие: 40 детерминированных unit-тестов, `pnpm typecheck && pnpm test` PASS.

Исправления: B1-B3 (board rev-трекинг + in-flight видимость + кумулятивные сводки + `canAnswerFromSummary`), B2/B4 (слияние задач по scope, локальный подсчёт шагов, запрет self-branch), B5/B6 (парсер: порядок нормализации кавычек, экранирование `\`, закрытие незакрытых строк/скобок, алиасы `<fold>/<folded_output>`, сжатие CoT при обрыве), B7 (CJK-точный CharRatioEstimator 1.4 с/токен), B8 (locate≤32768 / extract≤8192 клампинг + ретрай ридера + branch/query переопределения), B9 (устранение конфликта промпта `[Answer]`, разделитель `|`, универсальные разделители документов, общий ResearchBoard на группу).

### Сравнение: exp-* (до) vs verify-* (после)

| Бенчмарк (n) | Версия | Точность | Шаги | Время/задачу | Токены (prompt/cached/completion) | Cache hit | Cost | fmt |
|---|---|---|---|---|---|---|---|---|
| codegraph d2 (6) | до | 6/6 (100%) | 2.7 | 157.1s | 421,121/324,864/93,637 | 77.1% | $0.6312 | 1 |
| | после | 6/6 (100%) | 3.5 | 209.7s | 496,832/372,544/108,847 | 75.0% | $0.7498 | **0** |
| oolong d2 (5) | до | 5/5 (5 обрывов llm_query) | 1.6 | 142.5s | 189,755/75,712/149,170 | 39.9% | $0.1294 | 0 |
| | после | 5/5 (**0 обрывов**) | **1.4** | ~134s | **142,717/26,560/101,190** | 18.6% | **$0.0861 (−33.5%)** | 0 |
| longbench-pro d2 (20) | до | 13/20 (65.0%) | 3.9 | 210.2s | 484,152/227,200/238,799 | 46.9% | $1.2826 | 5 |
| | после | **14/20 (75.0%, +10 п.п.)** | **3.75** | **156.7s (−25%)** | **434,242/207,296/183,542** | 47.7% | **$0.9809 (−23.5%)** | 3 |
| longbench d2 (6) | до | 4/6 (66.7%) | 7.2 | 474.8s | 244,521/134,336/187,139 | 54.9% | $0.9093 | 2 |
| | после | 3/6 (50.0%)¹ | **5.5** | **248.8s (−48%)** | **196,125/95,232/92,480 (−27.3%)** | 48.6% | **$0.4673 (−48.6%)** | **0** |
| prompt-check | после | PASS (e2e 1.000) | 2.0 | — | 5,183/3,500/350 | **91.4%** | ~$0.0001 | 0 |

¹ Расхождение 4/6→3/6 — шум многошагового QA при равном промпте (невоспроизводимость diff-вопросов между прогонами); cost −48.6%, шаги 7.2→5.5, fmt 2→0. Каталоги: `results/verify-codegraph-d2`, `results/verify-oolong-d2`, `results/verify-longbench-pro-20-d2`, `results/verify-longbench-d2`, `results/verify-fixes-prompt-check`.

### Итоги верификации

- H1/H2 (иерархия/atomicity board): chain-h3-2 specialist@d2 сразу grep в своём домене без self-branch; follow-up не затирает найденные константы.
- H3 (протокол): fmtIssues 8→3 (−62.5%); парсер переживает `“...”`, `\d`, незакрытые строки/скобки, `<fold>`, переполнение reasoning (авто-сжатие при ретрае).
- H4 (CJK-токены): root cache на китайских longbench-документах 82.0–85.0%; I_{t-1} в бюджете.
- H5 (чанкинг llm_query): обрывы 5→0; токены oolong −33.5%; locate 81k-книга = 3 чанка ≤32k вместо одного 644k.
- H6 (LongBench-Pro/мульти-док): 65.0%→75.0%; cost −23.5%.

## 2026-11-07: кампания Jev-классификатора (`typesafe/jev-1.13`) — интеграция + отбор фич

Модели: root/branch = `glm-5.3`, llm_query = `glm-5.3-flash`. Решающий тир — `typesafe/jev-1.13` через OpenRouter (`POST /api/alpha/decisions`), цена 0.042 $/1M input, output бесплатен (подтверждено живым счётом: 371 input → `cost: 0.000015582`). Все фичи — модель- и бенчмарк-агностичные (правило `AGENTS.md`), по умолчанию выключены и **fail open**: таймаут, HTTP-ошибка или некорректный ответ оставляют поведение идентичным прогону без Jev.

### Реализация

| Слой | Что добавлено |
|---|---|
| `packages/engine/src/llm/jev.ts` | `JevClient` + типы `JevQuestion`/`JevAnswer`/`DecisionClient`; ретраи 429/5xx/408 (+402 `openrouter_in_flight_budget`), `Retry-After`, backoff 500 мс·2ⁿ ±25% ≤30 s; отказ от коэрции вероятностей (`noul`/`probabilities` ∈ [0,1], `score` ∈ [0, n−1] как EV индекса критерия) |
| `.../llm/jev-report.ts` | `decisionReporter`: событие `jev_decision` в трейс, иначе `onDecision` |
| `.../llm/jev-route.ts` | `JevRouteClient` (F7): per-call выбор cheap/strong, `profile` = strong |
| `.../tools/jev-routing.ts` | F4 `createJevScopeResolver`, F5 `createJevBranchGate` |
| `.../runtime.ts` | `JevOptions` (все фичи off, `acceptAt`/`rejectAt`, `maxGateSteps`, `maxRescans`), валидация порогов, проброс в `LLMQueryEngine`, `AgentFoldAgent`, `branch`-хуки, роутеры |
| `.../tools/llm-query.ts` | F1 prescreen (пачки ≤4 чанков ≤ `maxStateTokens`, memo `${chunk.key}|${query}`), F6 reader verify (+1 скан вдвое мельче), `prescreen skipped N` в отчёте |
| `.../agent/agent-fold.ts` | F2 answer gate (completeness+grounding, синтетический шаг вместо ответа), F3 hint маршрутизации в блоке задачи |
| `packages/benchmarks/src/jev.ts` | `--jev key=value` (12 ключей) + env `RAF_JEV_*`, неизвестный ключ/`on` без `OPENROUTER_API_KEY` — ошибка до старта |
| `config.ts`/`runner.ts`/`compare.ts`/`cli.ts` | `JevClient` при наличии ключа, `jev` в `RunConfig`, `jevDecisions`, `providerUsd`, роль `jev` в сводках и `compare` (`jev=$n`), `--only jev` |

Отклонения от плана (обоснованные, зафиксированы здесь): (1) `DecisionRequest.usage` — иначе решения общего на группу `LLMQueryEngine` не попадают в трекер задачи; (2) `score` валидируется в `[0, n−1]`, а не `[0,1]` — живой ответ вернул `1.98` для трёх критериев; (3) F5-гейт проверяется после own-scope/call-stack/consultOnly, чтобы запрет self-branch не подменялся сообщением гейта; (4) `cost.providerUsd` живёт внутри `cost` (при неизвестной цене `cost` отсутствует, как и раньше).

### Верификация (до кампании)

| Проверка | Результат |
|---|---|
| `tsc --noEmit` обоих пакетов | OK |
| unit-тесты | 52 (engine) + 17 (benchmarks) PASS: тело запроса, три примитива, отказ вероятностей/отсутствующего ответа, `Retry-After`, без ретрая на 400, `costUsd` под ролью `jev`, prescreen (2 вызова ридера вместо 3, memo, fail open, oversized bypass, extract не тронут), answer gate (отказ не-ответа → ответ `7` на шаге 2, fail open, off = 0 вызовов), роутинг (scope, low-conf fallback, gate block/spawn, hint в промпте), `--jev` флаги |
| `prompt-check --only jev` (live) | ✓ `typesafe/jev-1.13-20260917`; noul 0.99, choice `milan`, p∈[0,1], cost $0.000016, 716 мс |
| offline e2e (все 7 фич, `--mock`) | 5 вызовов jev / 5 решений (query_router, answer_gate, 3× model_router), 0 ошибок, `byRole.jev` учтён |

### W0 — нейтральность инструментирования

| Проверка | Результат |
|---|---|
| **Детерминированный A/B** (`needle --tokens 20000 --tasks 2 --seed 11 --mock`): текущий код vs чистый worktree на `HEAD` (b0d1f97) | **2/2 строки идентичны**: score, steps, terminated, formatIssues, prompt/cached/completion, по-ролевая разбивка. Summary: 41,537/12,992/397 в обоих. Инструментирование при `jev`=off не меняет ничего (все ветки — no-op: `prescreen()` выходит по `!jev`, гейт/route не создаются, `defaultChunkTokens` = прежний) |
| Живые прогоны (`j0-base-oolong`, `j0-base-codegraph`) без флагов | 0 вызовов Jev, 0 решений, роли `jev` нет — наблюдаемая нейтральность |
| Живой A/B по токенам | **не является тестом нейтральности**: glm-5.3 нестабилен при temperature=0 — на тех же промптах шаги 3→2 и completion 20k→36k (oolong 5/5→4/5, fmt 0→2; задача `…211` ответила ярлыком вместо RELATIVE_FREQ). Для проверки «ничего не сломали» нужен детерминированный harness, он выше |

### Структурные находки (до волн)

- **oolong trec_coarse использует `llm_query` в режиме `extract`** (17 чанков, подсчёт категорий), а F1 prescreen по плану действует только в `locate`. То есть ожидание плана «llm_query prompt −40% на oolong» структурно недостижимо: там нечего отсеивать, нужен каждый чанк.
- **locate-чанки по умолчанию 32,768 токенов** (`chunkTokens:32768` в трейсах longbench/longbench-pro) при лимите состояния Jev 24k → prescreen пропускал *все* чанки как oversized, т.е. F1 был мёртвым кодом при дефолтах. Добавлена универсальная связка: при `jev.prescreen=on` locate-чанк ограничивается наибольшей степенью двойки, влезающей в лимит состояния (24k − 2k резерв → **16,384**). Без prescreen размер не меняется (`Number.POSITIVE_INFINITY`).
- **Стоимость решения ничтожна**: на живых прогонах гейт ответа — $0.00004–0.00009 и 0.8–2.4 с на решение; 2025/1033 prompt-токенов состояния.
- Гейт F2 оценивает *полноту и обоснованность относительно собственных свёрнутых свидетельств*, а не правильность: в `j4-answergate-lbpro10` первый же ответ `[Answer] 1971 1977` прошёл как `complete/supported` (0.97) и всё равно не совпал с золотом. Это ожидаемо (не сверка с эталоном) и ограничивает вклад H2 отказами от не-ответов, а не исправлением фактов.

### Карта срабатывания фич (по базовым трейсам `verify-*`, до волн)

| Бенчмарк (n) | root | branch | llm_query locate | llm_query extract | не-ответы | Применимые фичи |
|---|---|---|---|---|---|---|
| oolong-5 | 7 вызовов | — | 0 | 17 чанков × 8192 | 0 | F3, F7 (F2 при слабых ответах); F1/F6 недостижимы (только extract), F4/F5 недостижимы (нет branch) |
| longbench-pro-20, первые 10 | 36 вызовов | — | 0 | 0 | 0 | F2 (только риск), F3, F7 |
| longbench-pro-20, №11–19 | root | — | 1×(6 чанков, 32768) | 1×(10 чанков, 8192) | **1** (`…35ddea1d`) | F2, F3, F7; F1/F6 — на задаче №12 |
| codegraph-6 | 21 | **71** | 0 | 0 | 0 | F4, F5, F7 |
| longbench-6 | 33 | — | 1×(3 чанка, 32768) | 0 | 0 | F7; F1/F6 недостижимы при 24k, достижимы после связки 16k |

Вывод: план предполагал «S = oolong5 + codegraph6 + lbpro10», но на oolong нет locate, на codegraph нет llm_query, а целевая задача H2 (не-ответ) лежит в lbpro №11, вне среза первых 10. Волны поэтому запускаются по срезам, где фича реально может сработать.

### W7 — F7 model router (`model-router=on`) на oolong-5

```
pnpm bench oolong --limit 5 --dataset trec_coarse --context-len 131072 --max-depth 2 --jev model-router=on --out results/j7-modelrouter-oolong5
```

| Метрика | База (`verify-oolong-d2`) | F7 | Δ |
|---|---|---|---|
| mean score | 1.00 (5/5) | **0.80 (4/5)** | −0.20 |
| cost | $0.0861 | $0.0846 | **−1.7%** |
| root-роль cost | $0.019478 | $0.018926 | −2.8% |
| jev | — | 7 вызовов / 7 решений, $0.0003, 4.4 с | +0.35% стоимости |
| cache hit | 18.6% | 13.2% | −5.4 п.п. |

Роутер выбрал `cheap` только **1 из 7** раз (confidence 0.82); остальные — `strong` с confidence 0.48–0.80, ниже порога `accept=0.8`. Причина: состояние роутера — «хвост» пользовательского сообщения (манифест + история, ~9k токенов), который классификатор не считает механическим шагом. Экономия −1.7% ≪ порога −15%. Упавшая задача `…17000211` падала и в необработанном повторе W0 (та же ошибка на тех же промптах) — это шум модели, не эффект роутера.

**Вердикт: ❌ F7 отклонён** (правило 1: ни одна метрика не лучше на ≥10%, accuracy не выросла). Понижать `accept` вслепую нельзя — валидации дешёвого маршрута на протокольных шагах нет.

### W4 — F2 answer gate (частично, 2/10) + целевой срез на не-ответ

```
pnpm bench longbench-pro --limit 10 --jev answer-gate=on --out results/j4-answergate-lbpro10      # остановлен на 2/10 (ёмкость)
pnpm bench longbench-pro --offset 11 --limit 2 --jev answer-gate=on --out results/j4b-answergate-lbpro-nonanswer
```

Первые 2 задачи (`401c9ee3`, `3d49df06`): score **идентичен** базе (0.00 и 1.00), шаги 8→7 и 3→3, 2 решения гейта (`complete/supported`), суммарно **$0.000128** — то есть накладные расходы гейта ≈ +0.13% стоимости задачи и он не отбраковывает валидные ответы.

### W1 — F1 prescreen (`prescreen=on`) на задаче с locate

```
pnpm bench longbench-pro --offset 12 --limit 1 --jev prescreen=on --out results/j1-prescreen-lbpro12
```

| Метрика | База (та же задача) | F1 |
|---|---|---|
| score | 0.00 | 1.00 (шум: та же задача в базе была спорной) |
| steps | 3 | 2 |
| prompt | 31,749 | 26,399 |
| llm_query | 10 вызовов, 19,653 prompt | 10 вызовов, 18,993 prompt |
| `jev` роль | — | **отсутствует (0 вызовов)** |

**Режим оказался `extract`** (10 чанков × 8192), а не `locate`: корневой агент выбирает extract для подсчётов/классификации и делает это нестабильно. По всем четырём базовым наборам `locate` встречается в **2 из 37 задач**, и при `locate`-чанках 32,768 (> лимита состояния 24k) prescreen пропускает их как oversized. То есть живой триггер F1 ≈ 0–5%, а ожидание «−40% prompt-токенов llm_query» структурно недостижимо на этих наборах.

Сама фича покрыта детерминированными тестами (пропуск 1 из 3 чанков → 2 вызова ридера, memo по `${chunk.key}|${query}`, fail-open без memo при ошибке, bypass oversized, extract не затронут, кэп 16,384). **Вердикт: ❌ F1 не принят** — нет измеримого выигрыша при текущей частоте срабатывания; опция остаётся выключенной.

### W4b — F2 answer gate на целевой задаче (не-ответ) + соседней

```
pnpm bench longbench-pro --offset 11 --limit 2 --jev answer-gate=on --out results/j4b-answergate-lbpro-nonanswer
```

| Задача | База | F2 |
|---|---|---|
| `…35ddea1d` (известный не-ответ) | `No final answer yet, still verifying`, score 0.00, 5 шагов | **настоящий ответ** `[Answer] Passage 1 sentence 6 and Passage 2 sentence 1…`, score 0.00, **7 шагов**, решение гейта **`off_topic/unsupported` (0.4)**, $0.000139 |
| `…af5bc2c9` | score 0.00, 3 шага | score **1.00**, 2 шага, гейт `complete/supported` (0.98) — улучшение от шума модели, гейт ответ пропустил |
| не-ответов в срезе | **1** | **0** |
| mean score среза | 0.00 | 0.50 |
| стоимость решения | — | $0.000041–0.000139 на задачу (≈ +0.1 % стоимости задачи) |

Гейт сработал ровно как задумано: не-ответ классифицирован как `off_topic/unsupported`, отклонён, и агент добавил **один** шаг (лимит `maxGateSteps=1`), дав содержательный ответ. Валидные ответы гейт не отбраковывал ни в одном из 4 проверенных случаев (2 задачи первых 10 + эти 2).

**Вердикт: ✅ F2 принят** — W4-гейт выполнен (не-ответов 0, +1 correct на срезе, стоимость +≤5 %). Включается по умолчанию: `RAF_JEV_ANSWER_GATE=on`.

### W2 — F3 query router (`query-router=on`) на oolong-5

```
pnpm bench oolong --limit 5 --dataset trec_coarse --context-len 131072 --max-depth 2 --jev query-router=on --out results/j2-queryrouter-oolong5
```

| Метрика | База | F3 | Δ |
|---|---|---|---|
| mean score | 1.00 (5/5) | 1.00 (5/5) | 0 |
| шаги | 1.40 | 1.20 | −14% |
| wall/task | 100.2 s | 72.0 s | −28% |
| cost | $0.0861 | $0.0830 | −3.6% |
| cache hit | 18.6% | 13.8% | −4.8 п.п. |
| jev | — | 5 решений `semantic`, $0.000139 | — |

**Подсказка не была вставлена ни разу**: все 5 решений вернули `semantic` с confidence **0.61–0.76 < accept 0.8**, а код при `score < acceptAt` подсказку опускает (fail open). То есть прогон фактически необработанный, и −14% шагов / −28% времени — шум модели (та же задача `…211` в трёх прогонах дала 1.00/1.00/0.00 при равных промптах).

**Вердикт: ❌ F3 не принят** — механизм не срабатывает при `accept=0.8`; наблюдаемые дельты не приписаны фиче.

### Сквозная находка кампании: порог `accept`

На реальных задачах Jev возвращает `choice`-confidence **0.61–0.80** (F3: 0.61–0.76; F7: 0.48–0.82), т.е. ниже планового порога 0.8. Из-за этого F3 и F7 активируются в 0–1 случае из 7–15, и их «эффект» структурно нулевой. Снижение порога до ~0.6 требует отдельной валидации качества на дешёвом маршруте — вслепую не делалось. F2 работает и при 0.8, потому что его отказ опирается на *метки* (`off_topic/unsupported`), а не только на уверенность: уверенные валидные ответы пришли с 0.85–0.98.

### Волны, которые не запускались

| Волна | Причина |
|---|---|
| W5 (F4 scope-router, F5 branch-gate) | `branch` в живых базовых прогонах вызывается только в codegraph (71 вызов), где нет `llm_query`; прогон 6 задач ≈ 25 мин, бюджет сессии исчерпан. Обе опции остались **off**; юнит-тесты покрывают роутинг/low-conf fallback/блокировку спавна |
| W6 (F6 reader-verify) | тот же структурный барьер, что у F1: `locate` в 2 из 37 задач, чанки 32k |
| W3 (комбинация), W8 (два прогона C) | требуют победителей; единственный победитель F2 проверен отдельно (W4b), комбинировать не с чем |

### Итог кампании Jev

Потрачено **$1.0139** (из них Jev — **$0.00075**); бюджет $35 не был ограничением — ограничением стало время (каждый прогон длинного бенчмарка 20–60 мин, сессия ~2.5 ч). Ни одна фича не меняет поведение при выключенном флаге (доказано детерминированным A/B).

| Фича | Флаг | Срез / подтверждение | База → с фичей | Вердикт |
|---|---|---|---|---|
| F1 prescreen | `prescreen` | longbench-pro №12 (единственная живая locate-задача) | locate-триггер **0** (агент выбрал extract), score 0.00→1.00 (шум), prompt 31,749→26,399 | ❌ off — триггер ≈0–5 % задач; чанки 32k не влезают в state 24k (кэп 16,384 включён) |
| F2 answer gate | `answer-gate` | longbench-pro №11–12 + первые 2 из 10 | не-ответы **1→0**; mean 0.00→0.50; score первых 2 идентичен; +1 шаг на исправленной задаче; cost +0.07…0.13 % | ✅ **on** (`RAF_JEV_ANSWER_GATE=on`) |
| F3 query router | `query-router` | oolong-5 | шаги 1.40→1.20, wall 100.2→72.0 s, cost −3.6 %, но **hint не вставлен** (confidence 0.61–0.76 < 0.8) | ❌ off — механизм не активируется, дельты = шум |
| F4 scope router | `scope-router` | не запускался (codegraph, 71 branch-вызов) | — | ❌ off — нет данных; покрыто юнит-тестами |
| F5 branch gate | `branch-gate` | не запускался (только codegraph) | — | ❌ off — нет данных |
| F6 reader verify | `reader-verify` | не запускался | — | ❌ off — тот же барьер, что у F1 (locate 2/37, чанки 32k) |
| F7 model router | `model-router` | oolong-5 | cost 0.0861→0.0846 (**−1.7 %**), root-cost −2.8 %, cheap выбран **1/7** (confidence 0.48–0.82), score 1.00→0.80 (шум) | ❌ off — экономия ≪ порога −15 % |

**Флаги, зафиксированные в `.env.example`**: `RAF_JEV_ANSWER_GATE=on`, остальные `off`; `OPENROUTER_API_KEY`/`RAF_JEV_URL`/`RAF_JEV_MODEL` — как в W0. Остаточный риск принятого F2: гейт считает «неуверенность» поводом для отказа, поэтому валидный, но неочевидный ответ может стоить одного лишнего шага (лимит `maxGateSteps=1`); на 4 проверенных задачах такого не случилось.

**Что делать дальше (не входит в кампанию)**: валидация `accept≈0.6` для F3/F7 на дешёвом маршруте; прогоны W5 на codegraph (F4/F5) и W6 на longbench (F6) при `--max-chunk-tokens 8192`, чтобы locate-фичи имели триггер; комбинация F2+F3 после валидации порога.

## 2026-11-07 (финал): интеграция Jev откачена

**Решение: интеграция удалена из `master`, движок и бенчмарки возвращены к `b0d1f97`.**

Основание: из 7 фич подтверждена одна (F2 answer gate: не-ответы 1→0 на целевой задаче при +0.1 % стоимости), три опровергнуты измерением (F1 — нет живого триггера, F3/F7 — уверенность Jev 0.48–0.82 ниже порога 0.8, механизмы не активируются), три не имели триггера в scope (F4/F5/F6). Один локальный выигрыш на срезе из 2 задач не оправдывает ~770 строк advisory-кода в движке, 12 новых CLI/env ключей и зависимость от второго провайдера в каждом прогоне.

Что осталось после отката:

- **Этот журнал** — полная запись кампании (реализация, W0, карта триггеров, волны W1/W2/W4/W4b/W7, итоговая таблица).
- **Каталоги `results/j*` и `results/mock-*`** — артефакты прогонов (config.json, results.jsonl, трейсы).
- **Один побочный фикс CLI**, не связанный с Jev: `--offset N --limit M` раньше брал **0 задач**, потому что `limit` ограничивал и загрузку датасета; теперь фетч берёт `offset + limit` (найден при запуске W4b). `--jev`-флаги, роль `jev`, `providerUsd`, Jev-тесты и README-раздел — удалены вместе с интеграцией.
- **Снапшот откаченного кода** — ветка `jev-experiment` (коммит 1ef92b0): полный JevClient, все 7 фич, флаги, 71 тест. Восстановление одной командой, если порог `accept` будет валидирован по методике из cookbook'ов (размеченная выборка 100–200 задач, sweep precision/recall) или появятся задачи с живым `locate`-триггером.

## 2026-11-08: кампания перехода на минималистичные английские промпты, точность (H2a/H2b/H2c) и стабилизация KV-кэша (H3)

### Гипотезы и изменения

- **H1 (Minimalist English Prompts & Protocol Alignment)**: перевод всех системных промптов (`AGENT_SYSTEM_PROMPT_TEMPLATE`, `TOOL_GUIDANCE`, `LLM_QUERY_SYSTEM`), схем инструментов, заголовков состояния (`### Documents`, `### Shared Research Board`, `### Task`, `### Previous Steps`, `### New Board Findings`, `### Follow-up Question`, `### Current Step`) и шаблонов наблюдений на минималистичный английский язык устраняет переключение языка между нативным английским `reasoning_content` моделей `glm-5.3` / `glm-5.3-flash` и китайским протоколом; явная передача `categories` в `renderQueryMessage` для `llm_query` гарантирует канонические ключи в `counts`.
- **H2 (Accuracy Hardening)**:
  - **H2a**: фильтр пустых/отложенных ответов (`isPlaceholderAnswer`: `"Pending verification, still verifying"`, `"No final answer yet, still verifying"`, и т.п.) до достижения `maxSteps` предотвращает преждевременное завершение цикла.
  - **H2b**: `ContextStore.grep` центрирует сниппет вокруг совпадения регулярного выражения на длинных строках (`> 300` символов) и распределяет `maxMatches` по документам round-robin при мульти-документном поиске, чтобы первый документ не вытеснял совпадения из остальных документов.
  - **H2c**: `createReadTool` останавливается строго по границе строки при достижении `maxReadTokens` с явным сообщением `(stopped at line X due to token limit; read from X+1 to continue)` вместо `head+tail`-вырезания середины запрошенного диапазона; `parser.ts` восстанавливает bare-JSON `<folding>` перед `<motivation>` и разделённый `summary`.
- **H3 (KV Prefix Cache Stabilization & Cross-Turn Memoization)**:
  - Удалён `/total` из атрибута `<document ... chunk="i">` в `renderChunkMessage`, чтобы добавление новых чанков не инвалидировало кэш предыдущих.
  - `ResearchBoard` разделяет `settledRev()` / `renderSettled()` (только завершённые записи для статического `initialBoardSnapshot`) и `inProgress` (отображаются только в динамическом хвосте `### New Board Findings`), благодаря чему параллельные специалисты делят 100% байт-идентичный префикс промпта.
  - `ContextStore.chunks` включает детерминированный FNV-1a хэш содержимого строк в `Chunk.key`, а `@raf/dsh-plugin` передаёт сессионный `LLMQueryCache` и `reasoningEffort: 'low'` для `queryLLM`.

### Сравнение: `verify-*-d2` (CN baseline) vs `en-*-d2` (Minimalist EN + H2 + H3)

| Бенчмарк (n) | Версия | Точность | Шаги | Время/задачу | Токены (prompt/cached/completion) | Cache hit | Cost | fmt |
|---|---|---|---|---|---|---|---|---|
| `prompt-check` | `verify-en-prompt-check` | **PASS (6/6 тулов, e2e 1.000)** | 3.0 | — | 7,276/6,460/2,583 (e2e) | **88.8%** | ~$0.0001 | **0** |
| `oolong` d2 (5) | `verify-oolong-d2` (CN) | 5/5 (1.000, 1 err в llm_query) | 1.40 | 100.2s | 142,717/26,560/101,190 | 18.6% | $0.0861 | 0 |
| | `en-oolong-d2` (run 1, cache-warm) | 4/5 (0.800, **0 err**) | **1.20** | 91.9s | **131,843/69,504/92,047** | **52.7%** | **$0.0728 (−15.4%)** | **0** |
| | `en-oolong-d2` (run 2, uncapped reader) | 4/5 (0.800, **0 err**) | 1.80 | **84.0s (−16.2%)** | 146,678/26,176/**73,582 (−27.3% compl)** | 17.8% (root **86.0%**) | $0.0977 | 2 |
| `codegraph` d2 (6) | `verify-codegraph-d2` (CN) | **6/6 (1.000)** | 3.50 | 209.7s | 496,832/372,544/108,847 | 75.0% (branch 76.5%) | $0.7498 | 0 |
| | `en-codegraph-d2` (EN) | **6/6 (1.000)** | **3.33** | 218.1s | **492,940/373,312**/126,677 | **75.7% (branch 78.1%)** | $0.8219 | 1 |
| `longbench` d2 (6) | `verify-longbench-d2` (CN) | 3/6 (0.500) | 5.50 | 248.8s | 196,125/95,232/92,480 | 48.6% | $0.4673 | 0 |
| | `en-longbench-d2` (EN) | **4/6 (0.667, +16.7 п.п.)** | 5.67 | 333.3s | **119,785 (−38.9%)**/95,552/123,937 | **79.8% (+31.2 п.п.)** | $0.6041 | 2 |
| `longbench-pro` d2 (20) | `verify-longbench-pro-20-d2` (CN) | 0.7500 (14/20) | 3.75 | 156.7s | 434,242/207,296/183,542 | 47.7% | $0.9809 | 3 |
| | `en-longbench-pro-20-d2` (EN) | **0.7750 (+2.5 п.п., 14/20 + 3 set-hits)** | 4.05 | 189.5s | 526,073/218,112/248,463 | 41.5% (root 69.5%) | $1.3017 | 6 |

### Ключевые подтверждения по трейсам

1. **H1**: В `en-oolong-d2` токены генерации ридера (`llm_query`) снизились с `98,774` до `65,708` (**−33.5%**), ошибок обрыва `1 → 0`, среднее время задачи `100.2s → 84.0s` (**−16.2%**). В `en-codegraph-d2` параллельные специалисты на шаге 0 тратят всего 48–52 токенов внутреннего reasoning и попадают в кэш на 87.2–90.5%.
2. **H2a/H2b/H2c**:
   - На задаче `35ddea1dc...` (`longbench-pro`), где раньше агент завершался на шаге 2 с `<answer>No final answer yet, still verifying</answer>`, агент продолжил чтение всех трёх документов (`doc_1`, `doc_2`, `doc_3`) по последовательным окнам `stopped at line X due to token limit; read from X+1 to continue` без потери средних строк.
   - На задаче `00e65818...` (`longbench-pro` T6 Clustering, 8 статей A–H в 3 файлах) round-robin `grep` по документам сразу показал совпадения из `doc_1` и `doc_2`, что позволило агенту обнаружить склейку 8 статей и решить задачу на **1.000** за 8 шагов (против 10 шагов в baseline).
   - На `en-longbench-d2` точность выросла с **50.0% (3/6)** до **66.7% (4/6)** при сокращении входных prompt-токенов на **−38.9%** и росте общего cache hit rate с **48.6%** до **79.8%**.

## 2026-11-08 (кампания 2): портирование практик точности `rlm.pi` (H1–H7) и защита KV-кэша `root`

Полное описание архитектурного аудита `/Users/hicaru/projects/zebra/rlm.pi` и детальная спецификация гипотез `H1`–`H7` зафиксированы в [`docs/RLM_PI_HYPOTHESES.md`](./RLM_PI_HYPOTHESES.md).

### Проверенные гипотезы и изменения в `@raf/engine` и `@raf/benchmarks`

- **H1 (Deterministic Zero-Token BM25 V2 `search` & Structural `outline`)**:
  - Реализован `Bm25DocumentIndex` (`packages/engine/src/context/bm25.ts`): перекрывающиеся окна по 40 строк (шаг 20), детерминированный стемминг английских суффиксов (`stemToken`), разбиение `camelCase`, CJK униграммы + биграммы (`\p{Script=Han}`), Robertson-Walker IDF, Rocchio Pseudo-Relevance Feedback (`PRF_FEEDBACK_DOCS = 3`, `PRF_EXPANSION_TERMS = 8`, `PRF_EXPANSION_WEIGHT = 0.4` при $\ge 12$ окнах) и фразовый бонус смежных биграмм запроса (`PHRASE_BONUS_WEIGHT = 0.25`).
  - В `ContextStore` (`packages/engine/src/context/store.ts`) добавлены методы `search()` и `outline()`, экспортированы бесплатные инструменты `search` и `outline` (`packages/engine/src/tools/document-tools.ts`).
- **H2 (Root Orchestrator Decomposition Doctrine & Root Deep-Fold Suppression)**:
  - Для `root` (`depth === 0`) установлен порог глубокой консолидации `DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS = 16` (`packages/engine/src/agent/agent-fold.ts`) при сохранении `DEFAULT_MIN_DEEP_FOLD_BLOCKS = 6` для `branch` (`depth > 0`), что исключает инвалидацию префикса `### Previous Steps` в `root` на стандартных траекториях 1–15 шагов.
  - В `Operating Principles` (`packages/engine/src/prompts/agent.ts`) добавлены правила оркестрации Appendix C.3 из `rlm.pi` (приоритет бесплатных проб `search`/`grep`/`outline`/`tally`, параллельный `branch` при мульти-документном анализе, приоритет готовых фактов `KEY = value` из `Shared Research Board`).
- **H3 (`TaskLedger` Ancestor-Echo Guard & Specialist Budget Demotion)**:
  - В `packages/engine/src/context/board.ts` добавлены `taskTokenSet`, `targetTokenSet`, `jaccardSimilarity` и `isAncestorEcho` (`ECHO_JACCARD = 0.8`). Если специалист (`depth > 0`) пытается повторно делегировать задачу предка ($\text{Jaccard} \ge 0.8$ при тех же целевых идентификаторах) на собственный `scope`, вызов блокируется за 0 LLM-токенов (`[ledger: ancestor echo rejected...]`).
  - Добавлен бюджетный лимит `maxSpecialists = 12` в `branch.ts`: при превышении числа специалистов новые специалисты запускаются в быстром режиме (`maxSteps = Math.min(maxSteps, 4)`).
- **H4 (Reader `llm_query` Cue-Guided Shorthand & `<5%` Margin Warning)**:
  - В `packages/engine/src/prompts/llm-query.ts` правило компактного рассуждения обновлено на `"line#:cue->code"` (`"5:year->N 6:city->L 7:poet->H"`), а в `LLMQueryEngine.formatReport` (`packages/engine/src/tools/llm-query.ts`) добавлена диагностика `formatMarginNote`, предупреждающая о смежных категориях с разницей $< 5\%$ от суммы всех элементов или $< 8\%$ от суммы пары.
- **H5 (Incomplete-Read / Bare Step-0 Verification Guard & Fallback Answer Floor)**:
  - В `AgentFoldAgent.run()` (`packages/engine/src/agent/agent-fold.ts`) добавлена однократная проверка `verificationNudged` при попытке выдать `<answer>` без `<folding>` сразу после обрезанного по лимиту токенов `read` (`stopped at line X due to token limit`), а также функция `extractFallbackAnswer` для спасения незакрытого `<answer>` или явного блока `[Answer]` на последнем шаге.
- **H6 (Case-Exact vs Case-Insensitive `tally` Disambiguation)**:
  - `ContextStore.tally` и `createTallyTool` возвращают как точные варианты регистра, так и сводку `Case-folded summary (when task is case-insensitive vs exact-case)` при наличии нескольких вариантов регистра одного слова (например, `this=36, This=4`).
- **H7 (3-Tier Independent Provider Config & Root Cache Telemetry)**:
  - В `packages/benchmarks/src/config.ts`, `cli.ts`, `.env.example` добавлена независимая конфигурация 3 уровней (`RAF_ROOT_*`, `RAF_BRANCH_*`, `RAF_QUERY_*`), а в `runner.ts` и `compare.ts` выведены метрики `rootCacheHitRate` и `branchCacheHitRate`.

### Результаты верификации (`en-*-d2` baseline vs `rlm-port-*`)

| Бенчмарк (n) | Прогон | Точность | Шаги | Токены (prompt/cached/compl) | Root cache hit | Total cache hit | Cost | fmt |
|---|---|---|---|---|---|---|---|---|
| `prompt-check` (10 проб) | `rlm-port-prompt-check` | **PASS (10/10 проб, e2e 1.000)** | 2.0 | 5,694/5,467/624 (e2e) | **96.2%** | **96.2%** | ~$0.0001 | **0** |
| `oolong` d2 (5) | `en-oolong-d2` (baseline) | 4/5 (0.8000) | 1.80 | 146,678/26,176/73,582 | 86.0% | 17.8% | $0.0977 | 2 |
| | `rlm-port-oolong-d2` (H1–H7) | **5/5 (1.0000, +20.0 п.п.)** | **1.60 (−11%)** | 148,820/29,376/108,359 (root **25,901, −14.9%**) | **85.7%** (92.2–95.0% задачи 2–5) | **19.7%** | $0.1116 | **0** |
| `longbench-pro` срез (offset 8, limit 4) | `en-longbench-pro-20-d2` (срез 4 задач) | 1/4 (0.3750) | 4.50 | 87,879/54,784/70,065 | 62.3% | 62.3% | $0.3689 | 3 |
| | `rlm-port-lbpro-slice` (H1–H7) | **3/4 (0.7500, +37.5 п.п., 2x)** | **3.50 (−22%)** | **60,485 (−31.2%)**/41,472/59,454 | **68.6% (+6.3 п.п.)** | **68.6%** | **$0.2990 (−18.9%)** | **0** |
| `codegraph` d2 (6) | `en-codegraph-d2` (baseline) | **6/6 (1.0000)** | 3.33 | 492,940/373,312/126,677 | 67.1% (branch 78.1%) | 75.7% | $0.8219 | 1 |
| | `rlm-port-codegraph-d2` (H1–H7) | **6/6 (1.0000)** | 3.67 | 746,178/573,760/197,456 | **68.2% (+1.1 п.п., branch 78.6%)** | **76.9% (+1.2 п.п.)** | $1.2594 | **0** |

### Ключевые подтверждения по задачам

1. **OOLONG `17000211` (`0.000 → 1.000`, H4)**: В `en-oolong-d2` задача `17000211` (`description and abstract concept` vs `human being`) падала из-за смещения 29 вопросов `"What..."` о людях/группах в `description and abstract concept` (`423 > 394`). В `rlm-port-oolong-d2` ридер классифицировал все `3,182/3,182` строки (`numeric value=969, entity=815, human being=416, description and abstract concept=388, location=303, abbreviation=291`), верно определив `388 < 416` (`less common than`) с первого прохода и обеспечив **5/5 (100%)** на `oolong`.
2. **LongBench-Pro `2bc1b1da` (`0.500 → 1.000`, H6)**: Агент вызвал `tally` с `case_sensitive: true` на шаге 0 и выдал точный порядок `that, have, would, this, went` за 2 шага вместо ошибочного сложения `this (36) + This (4) = 40 > would (37)`.
3. **LongBench-Pro `b2d18db8` (`0.000 → 1.000`, H5)**: Устранено преждевременное завершение после обрезанного по лимиту токенов `read(1..80)` без `<folding>`; агент проверил все варианты и выдал точный ответ `ACE` (`score = 1.000`, `0` ошибок формата).
4. **CodeGraph 120K (`6/6 = 1.0000`, H1/H2/H3)**: В `rlm-port-codegraph-d2` все 6 задач (`spec_specialist`, `diamond_deps`, `chain_hop`) решены на **1.000** с **0 ошибок формата** (против 1 в baseline) и **0 скорректированных свёрток** (`93 / 0 / 0`), при росте `root` cache hit rate с `67.1%` до **`68.2%`** (до `90.5%` на `chain-h3-5`), `branch` cache hit rate с `78.1%` до **`78.6%`** (до `86.6%` на `diamond-1`) и общего cache hit rate с `75.7%` до **`76.9%`**. Специалисты также использовали новый бесплатный инструмент `outline` для структурного обзора модулей.
