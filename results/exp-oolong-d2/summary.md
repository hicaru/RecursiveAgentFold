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
| mean steps | 1.6 |
| mean wall time | 142.5 s |
| format issues | 0 |
| folds granular / deep / corrected | 3 / 0 / 0 |
| llm_query calls | 3 |
| prompt / cached / completion tokens | 189755 / 75712 / 149170 |
| cache hit rate | 39.9% |
| cost (list price, USD) | **$0.1294** |
| cost per task | $0.0259 |
| cache saved | $0.0298 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 8 | 24335 | 20352 | 83.6% | 6608 | 0 |
| llm_query | 13 | 165420 | 55360 | 33.5% | 142562 | 5 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
