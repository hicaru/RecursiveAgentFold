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
| mean wall time | 408.4 s |
| format issues | 0 |
| folds granular / deep / corrected | 73 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 671528 / 499200 / 132140 |
| root cache hit rate | **65.9%** |
| branch cache hit rate | 76.8% |
| cache hit rate (all tiers) | 74.3% |
| cost (list price, USD) | **$0.9525** |
| cost per task | $0.1587 |
| cache saved | $0.5691 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 21 | 149814 | 98752 | 65.9% | 21398 | 0 |
| branch | 75 | 521714 | 400448 | 76.8% | 110742 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
