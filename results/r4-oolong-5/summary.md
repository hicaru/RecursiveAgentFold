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
| mean wall time | 74.1 s |
| format issues | 0 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 131379 / 13888 / 80219 |
| cache hit rate | 10.6% |
| cost (list price, USD) | **$0.0732** |
| cost per task | $0.0146 |
| cache saved | $0.0158 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 6 | 16224 | 13888 | 85.6% | 2279 | 0 |
| llm_query | 17 | 115155 | 0 | 0.0% | 77940 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 1.000 |
