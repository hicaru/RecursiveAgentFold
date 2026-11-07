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
| mean steps | 3.3 |
| mean wall time | 218.1 s |
| format issues | 1 |
| folds granular / deep / corrected | 68 / 0 / 1 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 492940 / 373312 / 126677 |
| cache hit rate | 75.7% |
| cost (list price, USD) | **$0.8219** |
| cost per task | $0.1370 |
| cache saved | $0.4256 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 20 | 105304 | 70656 | 67.1% | 26014 | 0 |
| branch | 75 | 387636 | 302656 | 78.1% | 100663 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
