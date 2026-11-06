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
| mean steps | 1.4 |
| mean wall time | 100.2 s |
| format issues | 0 |
| folds granular / deep / corrected | 2 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 142717 / 26560 / 101190 |
| cache hit rate | 18.6% |
| cost (list price, USD) | **$0.0861** |
| cost per task | $0.0172 |
| cache saved | $0.0212 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 7 | 20703 | 17664 | 85.3% | 2416 | 0 |
| llm_query | 18 | 122014 | 8896 | 7.3% | 98774 | 1 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
