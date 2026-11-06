# Benchmark summary

| metric | value |
|---|---|
| tasks | 6 |
| mean score (primary) | **0.3333** |
| correct (score = 1) | **2/6** |
| mean score (official OOLONG) | 0.3333 |
| mean score (lenient) | 0.3333 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.3333 |
| mean steps | 4.0 |
| mean wall time | 355.2 s |
| format issues | 1 |
| folds granular / deep / corrected | 18 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 131700 / 66368 / 69505 |
| cache hit rate | 50.4% |
| cost (list price, USD) | **$0.3666** |
| cost per task | $0.0611 |
| cache saved | $0.0757 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 25 | 96974 | 66368 | 68.4% | 68339 | 0 |
| llm_query | 2 | 34726 | 0 | 0.0% | 1166 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 2 | 0.000 |
| T2. Sequencing & Structure Reconstruction | 3 | 0.667 |
| T5. Attribution & Citation Alignment | 1 | 0.000 |
