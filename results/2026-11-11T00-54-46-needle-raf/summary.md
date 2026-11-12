# Benchmark summary

| metric | value |
|---|---|
| tasks | 4 |
| mean score (primary) | **0.0267** |
| correct (score = 1) | **0/4** |
| mean score (official OOLONG) | 0.0267 |
| mean score (lenient) | 0.0267 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.0267 |
| mean steps | 3.0 |
| mean wall time | 0.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 8 / 0 / 4 |
| llm_query calls | 4 |
| prompt / cached / completion tokens | 309160 / 51456 / 1319 |
| root cache hit rate | **83.5%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 16.6% |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 12 | 49681 | 41472 | 83.5% | 644 | 0 |
| llm_query | 27 | 259479 | 9984 | 3.8% | 675 | 0 |

## By task

| task | n | score |
|---|---|---|
| lookup | 2 | 0.000 |
| count | 2 | 0.053 |
