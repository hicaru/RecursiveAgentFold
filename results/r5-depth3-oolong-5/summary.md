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
| mean wall time | 80.1 s |
| format issues | 1 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 133033 / 16448 / 85868 |
| cache hit rate | 12.4% |
| cost (list price, USD) | **$0.0762** |
| cost per task | $0.0152 |
| cache saved | $0.0188 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 7 | 18541 | 16448 | 88.7% | 2275 | 0 |
| llm_query | 17 | 114492 | 0 | 0.0% | 83593 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
