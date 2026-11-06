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
| mean steps | 3.5 |
| mean wall time | 209.7 s |
| format issues | 0 |
| folds granular / deep / corrected | 68 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 496832 / 372544 / 108847 |
| cache hit rate | 75.0% |
| cost (list price, USD) | **$0.7498** |
| cost per task | $0.1250 |
| cache saved | $0.4247 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 21 | 117260 | 81984 | 69.9% | 24129 | 0 |
| branch | 71 | 379572 | 290560 | 76.5% | 84718 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
