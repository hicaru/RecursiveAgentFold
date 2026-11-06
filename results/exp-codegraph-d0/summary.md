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
| mean steps | 11.5 |
| mean wall time | 117.6 s |
| format issues | 2 |
| folds granular / deep / corrected | 63 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 256257 / 216064 / 38646 |
| cache hit rate | 84.3% |
| cost (list price, USD) | **$0.2825** |
| cost per task | $0.0471 |
| cache saved | $0.2463 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 70 | 256257 | 216064 | 84.3% | 38646 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
