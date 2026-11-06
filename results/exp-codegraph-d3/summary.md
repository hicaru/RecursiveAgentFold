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
| mean steps | 3.2 |
| mean wall time | 258.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 72 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 528307 / 416320 / 138154 |
| cache hit rate | 78.8% |
| cost (list price, USD) | **$0.8729** |
| cost per task | $0.1455 |
| cache saved | $0.4746 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 19 | 100671 | 72640 | 72.2% | 20321 | 0 |
| branch | 80 | 427636 | 343680 | 80.4% | 117833 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 1.000 |
| diamond_deps | 2 | 1.000 |
| chain_hop | 2 | 1.000 |
