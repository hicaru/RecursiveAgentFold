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
| mean steps | 2.7 |
| mean wall time | 157.1 s |
| format issues | 1 |
| folds granular / deep / corrected | 52 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 421121 / 324864 / 93637 |
| cache hit rate | 77.1% |
| cost (list price, USD) | **$0.6312** |
| cost per task | $0.1052 |
| cache saved | $0.3703 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 17 | 93786 | 65728 | 70.1% | 18536 | 0 |
| branch | 60 | 327335 | 259136 | 79.2% | 75101 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
