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
| mean steps | 1.6 |
| mean wall time | 73.0 s |
| format issues | 2 |
| folds granular / deep / corrected | 3 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 146034 / 28416 / 80830 |
| cache hit rate | 19.5% |
| Jev calls / decisions | 0 / 0 |
| cost (list price, USD) | **$0.0974** |
| provider-reported cost | $0.000000 |
| cost per task | $0.0195 |
| cache saved | $0.0298 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 10 | 30029 | 25856 | 86.1% | 7002 | 0 |
| llm_query | 17 | 116005 | 2560 | 2.2% | 73828 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
