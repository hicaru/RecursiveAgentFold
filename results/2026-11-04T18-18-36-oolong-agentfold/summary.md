# Benchmark summary

| metric | value |
|---|---|
| tasks | 50 |
| mean score (primary) | **0.6305** |
| correct (score = 1) | **31/50** |
| mean score (official OOLONG) | 0.6305 |
| mean score (lenient) | 0.6305 |
| errors / overflow | 0 |
| content-filtered | 8 |
| mean score (excluding errors) | 0.7506 |
| mean steps | 8.3 |
| mean wall time | 654.8 s |
| format issues | 44 |
| folds granular / deep / corrected | 333 / 28 / 3 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 2523479 / 1182976 / 2315963 |
| cache hit rate | 46.9% |
| cost (list price, USD) | **$12.3745** |
| cost per task | $0.2475 |
| cache saved | $1.3486 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 445 | 2523479 | 1182976 | 46.9% | 2315963 | 8 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 5 | 0.600 |
| TASK_TYPE.LEAST_FREQ | 4 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 29 | 0.828 |
| TASK_TYPE.NUMERIC_ONE_CLASS | 12 | 0.044 |
