# Benchmark summary

| metric | value |
|---|---|
| tasks | 5 |
| mean score (primary) | **1.0000** |
| correct (score = 1) | **5/5** |
| mean score (official OOLONG) | 1.0000 |
| mean score (lenient) | 1.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 1.0000 |
| mean steps | 1.2 |
| mean wall time | 72.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 139534 / 19200 / 93270 |
| cache hit rate | 13.8% |
| Jev calls / decisions | 5 / 5 |
| cost (list price, USD) | **$0.0830** |
| provider-reported cost | $0.000139 |
| cost per task | $0.0166 |
| cache saved | $0.0182 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| jev | 5 | 3318 | 0 | 0.0% | 195 | 0 |
| root | 6 | 19854 | 15616 | 78.7% | 2385 | 0 |
| llm_query | 17 | 116362 | 3584 | 3.1% | 90690 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
