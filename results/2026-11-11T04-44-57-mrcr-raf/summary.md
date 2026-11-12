# Benchmark summary

| metric | value |
|---|---|
| tasks | 6 |
| mean score (primary) | **0.8333** |
| correct (score = 1) | **5/6** |
| mean score (official OOLONG) | 0.8333 |
| mean score (lenient) | 0.8333 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.8333 |
| mean steps | 4.2 |
| mean wall time | 194.4 s |
| format issues | 0 |
| folds granular / deep / corrected | 19 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 239982 / 92928 / 80947 |
| root cache hit rate | **82.4%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 38.7% |
| cost (list price, USD) | **$0.3923** |
| cost per task | $0.0654 |
| cache saved | $0.1059 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 25 | 112804 | 92928 | 82.4% | 71995 | 0 |
| llm_query | 5 | 127178 | 0 | 0.0% | 8952 | 0 |

## By task

| task | n | score |
|---|---|---|
| mrcr_coref | 6 | 0.833 |
