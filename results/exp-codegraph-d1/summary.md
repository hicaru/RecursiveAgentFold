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
| mean steps | 2.3 |
| mean wall time | 190.5 s |
| format issues | 0 |
| folds granular / deep / corrected | 61 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 437761 / 329856 / 87772 |
| cache hit rate | 75.4% |
| cost (list price, USD) | **$0.6230** |
| cost per task | $0.1038 |
| cache saved | $0.3760 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 14 | 74407 | 53888 | 72.4% | 12105 | 0 |
| branch | 65 | 363354 | 275968 | 76.0% | 75667 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 0.500 |
| chain_hop | 2 | 1.000 |
