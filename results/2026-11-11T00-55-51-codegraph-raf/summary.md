# Benchmark summary

| metric | value |
|---|---|
| tasks | 6 |
| mean score (primary) | **0.0000** |
| correct (score = 1) | **0/6** |
| mean score (official OOLONG) | 0.0000 |
| mean score (lenient) | 0.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.0000 |
| mean steps | 3.0 |
| mean wall time | 0.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 12 / 0 / 6 |
| llm_query calls | 6 |
| prompt / cached / completion tokens | 248127 / 81344 / 1566 |
| root cache hit rate | **86.4%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 32.8% |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 18 | 83956 | 72512 | 86.4% | 966 | 0 |
| llm_query | 24 | 164171 | 8832 | 5.4% | 600 | 0 |

## By task

| task | n | score |
|---|---|---|
| spec_specialist | 2 | 0.000 |
| diamond_deps | 2 | 0.000 |
| chain_hop | 2 | 0.000 |
