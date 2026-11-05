# Benchmark summary

| metric | value |
|---|---|
| tasks | 5 |
| mean score (primary) | **0.4000** |
| correct (score = 1) | **2/5** |
| mean score (official OOLONG) | 0.4000 |
| mean score (lenient) | 0.4000 |
| errors / overflow | 0 |
| content-filtered | 1 |
| mean score (excluding errors) | 0.5000 |
| mean steps | 9.6 |
| mean wall time | 767.1 s |
| format issues | 4 |
| folds granular / deep / corrected | 43 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 133039 / 90240 / 179449 |
| cache hit rate | 67.8% |
| cost (list price, USD) | **$0.8730** |
| cost per task | $0.1746 |
| cache saved | $0.1029 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 51 | 133039 | 90240 | 67.8% | 179449 | 1 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.LEAST_FREQ | 1 | 0.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
| TASK_TYPE.MOST_FREQ | 1 | 0.000 |
