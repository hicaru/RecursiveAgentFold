# Benchmark summary

| metric | value |
|---|---|
| tasks | 5 |
| mean score (primary) | **0.4000** |
| correct (score = 1) | **2/5** |
| mean score (official OOLONG) | 0.4000 |
| mean score (lenient) | 0.4000 |
| errors / overflow | 0 |
| content-filtered | 2 |
| mean score (excluding errors) | 0.6667 |
| mean steps | 13.2 |
| mean wall time | 863.8 s |
| format issues | 4 |
| folds granular / deep / corrected | 60 / 1 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 212530 / 117760 / 278504 |
| cache hit rate | 55.4% |
| cost (list price, USD) | **$1.3887** |
| cost per task | $0.2777 |
| cache saved | $0.1342 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 67 | 212530 | 117760 | 55.4% | 278504 | 2 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.LEAST_FREQ | 1 | 0.000 |
| TASK_TYPE.MOST_FREQ | 1 | 0.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
