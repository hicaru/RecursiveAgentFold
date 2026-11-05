# Benchmark summary

| metric | value |
|---|---|
| tasks | 5 |
| mean score (primary) | **0.2000** |
| correct (score = 1) | **1/5** |
| mean score (official OOLONG) | 0.2000 |
| mean score (lenient) | 0.2000 |
| errors / overflow | 0 |
| content-filtered | 3 |
| mean score (excluding errors) | 0.5000 |
| mean steps | 8.4 |
| mean wall time | 567.5 s |
| format issues | 0 |
| folds granular / deep / corrected | 36 / 1 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 129496 / 58304 / 131115 |
| cache hit rate | 45.0% |
| cost (list price, USD) | **$0.6917** |
| cost per task | $0.1383 |
| cache saved | $0.0665 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 42 | 129496 | 58304 | 45.0% | 131115 | 3 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.LEAST_FREQ | 1 | 0.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.333 |
| TASK_TYPE.MOST_FREQ | 1 | 0.000 |
