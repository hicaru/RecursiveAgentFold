# Benchmark summary

| metric | value |
|---|---|
| tasks | 2 |
| mean score (primary) | **1.0000** |
| correct (score = 1) | **2/2** |
| mean score (official OOLONG) | 1.0000 |
| mean score (lenient) | 1.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 1.0000 |
| mean steps | 3.0 |
| mean wall time | 194.4 s |
| format issues | 2 |
| folds granular / deep / corrected | 35 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 234993 / 197440 / 54482 |
| root cache hit rate | **72.1%** |
| branch cache hit rate | 85.9% |
| cache hit rate (all tiers) | 84.0% |
| cost (list price, USD) | **$0.3436** |
| cost per task | $0.1718 |
| cache saved | $0.2251 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 6 | 31951 | 23040 | 72.1% | 6627 | 0 |
| branch | 42 | 203042 | 174400 | 85.9% | 47855 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 1 | 1.000 |
| diamond_deps | 1 | 1.000 |
