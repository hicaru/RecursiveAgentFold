# Benchmark summary

| metric | value |
|---|---|
| tasks | 10 |
| mean score (primary) | **0.6000** |
| correct (score = 1) | **6/10** |
| mean score (official OOLONG) | 0.6000 |
| mean score (lenient) | 0.6000 |
| errors / overflow | 0 |
| content-filtered | 2 |
| mean score (excluding errors) | 0.7500 |
| mean steps | 8.3 |
| mean wall time | 494.5 s |
| format issues | 16 |
| folds granular / deep / corrected | 73 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 321204 / 169408 / 354325 |
| cache hit rate | 52.7% |
| cost (list price, USD) | **$1.8156** |
| cost per task | $0.1816 |
| cache saved | $0.1931 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 92 | 321204 | 169408 | 52.7% | 354325 | 2 |

## By task

| task | n | score |
|---|---|---|
| TASK_TYPE.MOST_FREQ | 1 | 0.000 |
| TASK_TYPE.LEAST_FREQ | 1 | 1.000 |
| TASK_TYPE.RELATIVE_FREQ | 8 | 0.625 |
