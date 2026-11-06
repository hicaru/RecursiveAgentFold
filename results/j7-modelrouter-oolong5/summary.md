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
| mean wall time | 70.8 s |
| format issues | 1 |
| folds granular / deep / corrected | 1 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 142271 / 18816 / 99237 |
| cache hit rate | 13.2% |
| Jev calls / decisions | 7 / 7 |
| cost (list price, USD) | **$0.0846** |
| provider-reported cost | $0.000300 |
| cost per task | $0.0169 |
| cache saved | $0.0183 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| jev | 7 | 7153 | 0 | 0.0% | 217 | 0 |
| root | 7 | 20490 | 15744 | 76.8% | 1861 | 0 |
| llm_query | 17 | 114628 | 3072 | 2.7% | 97159 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
