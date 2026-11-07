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
| mean steps | 3.7 |
| mean wall time | 284.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 93 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 746178 / 573760 / 197456 |
| root cache hit rate | **68.2%** |
| branch cache hit rate | 78.6% |
| cache hit rate (all tiers) | 76.9% |
| cost (list price, USD) | **$1.2594** |
| cost per task | $0.2099 |
| cache saved | $0.6541 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 22 | 124613 | 84928 | 68.2% | 29996 | 0 |
| branch | 101 | 621565 | 488832 | 78.6% | 167460 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
