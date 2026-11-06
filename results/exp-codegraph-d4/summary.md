# Benchmark summary

| metric | value |
|---|---|
| tasks | 6 |
| mean score (primary) | **1.0000** |
| correct (score = 1) | **6/6** |
| mean score (official OOLONG) | 1.0000 |
| mean score (lenient) | 1.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 1.0000 |
| mean steps | 4.3 |
| mean wall time | 272.9 s |
| format issues | 0 |
| folds granular / deep / corrected | 71 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 537107 / 430144 / 139904 |
| cache hit rate | 80.1% |
| cost (list price, USD) | **$0.8772** |
| cost per task | $0.1462 |
| cache saved | $0.4904 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 26 | 142182 | 113472 | 79.8% | 44010 | 0 |
| branch | 71 | 394925 | 316672 | 80.2% | 95894 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
