# Benchmark summary

| metric | value |
|---|---|
| tasks | 2 |
| mean score (primary) | **0.2109** |
| correct (score = 1) | **0/2** |
| mean score (official OOLONG) | 0.2109 |
| mean score (lenient) | 0.2109 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.2109 |
| mean steps | 3.0 |
| mean wall time | 0.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 2 / 2 / 0 |
| llm_query calls | 2 |
| prompt / cached / completion tokens | 68897 / 43136 / 472 |
| root cache hit rate | **79.8%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 62.6% |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 6 | 27171 | 21696 | 79.8% | 322 | 0 |
| llm_query | 6 | 41726 | 21440 | 51.4% | 150 | 0 |

## By task

| task | n | score |
|---|---|---|
| lookup | 1 | 0.000 |
| count | 1 | 0.422 |
