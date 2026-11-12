# Benchmark summary

| metric | value |
|---|---|
| tasks | 50 |
| mean score (primary) | **0.0000** |
| correct (score = 1) | **0/50** |
| mean score (official OOLONG) | 0.0000 |
| mean score (lenient) | 0.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.0000 |
| mean steps | 3.0 |
| mean wall time | 0.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 100 / 0 / 50 |
| llm_query calls | 50 |
| prompt / cached / completion tokens | 852565 / 603520 / 8900 |
| root cache hit rate | **90.9%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 70.8% |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 150 | 649719 | 590848 | 90.9% | 8050 | 0 |
| llm_query | 34 | 202846 | 12672 | 6.2% | 850 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 5 | 0.000 |
| TASK_TYPE.LEAST_FREQ | 4 | 0.000 |
| TASK_TYPE.RELATIVE_FREQ | 29 | 0.000 |
| TASK_TYPE.NUMERIC_ONE_CLASS | 12 | 0.000 |
