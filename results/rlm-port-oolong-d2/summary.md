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
| mean wall time | 102.7 s |
| format issues | 0 |
| folds granular / deep / corrected | 3 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 148820 / 29376 / 108359 |
| root cache hit rate | **85.7%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 19.7% |
| cost (list price, USD) | **$0.1116** |
| cost per task | $0.0223 |
| cache saved | $0.0262 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 8 | 25901 | 22208 | 85.7% | 7413 | 0 |
| llm_query | 18 | 122919 | 7168 | 5.8% | 100946 | 1 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
