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
| mean wall time | 87.4 s |
| format issues | 2 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 136290 / 15744 / 101532 |
| cache hit rate | 11.6% |
| cost (list price, USD) | **$0.0906** |
| cost per task | $0.0181 |
| cache saved | $0.0179 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 8 | 19639 | 15744 | 80.2% | 3288 | 0 |
| llm_query | 17 | 116651 | 0 | 0.0% | 98244 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
