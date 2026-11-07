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
| mean steps | 1.8 |
| mean wall time | 84.0 s |
| format issues | 2 |
| folds granular / deep / corrected | 4 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 146678 / 26176 / 73582 |
| cache hit rate | 17.8% |
| cost (list price, USD) | **$0.0977** |
| cost per task | $0.0195 |
| cache saved | $0.0298 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 11 | 30435 | 26176 | 86.0% | 7874 | 0 |
| llm_query | 17 | 116243 | 0 | 0.0% | 65708 | 0 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 1.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 3 | 0.667 |
