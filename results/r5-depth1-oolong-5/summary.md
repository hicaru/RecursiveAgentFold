# Benchmark summary

| metric | value |
|---|---|
| tasks | 5 |
| mean score (primary) | **0.8000** |
| correct (score = 1) | **4/5** |
| mean score (official OOLONG) | 0.8000 |
| mean score (lenient) | 0.8000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.8000 |
| mean steps | 1.2 |
| mean wall time | 72.7 s |
| format issues | 1 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 135350 / 16448 / 74842 |
| cache hit rate | 12.2% |
| cost (list price, USD) | **$0.0773** |
| cost per task | $0.0155 |
| cache saved | $0.0188 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 7 | 18852 | 16448 | 87.2% | 3793 | 0 |
| llm_query | 17 | 116498 | 0 | 0.0% | 71049 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
