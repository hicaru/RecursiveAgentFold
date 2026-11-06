# Benchmark summary

| metric | value |
|---|---|
| tasks | 20 |
| mean score (primary) | **0.7500** |
| correct (score = 1) | **14/20** |
| mean score (official OOLONG) | 0.7500 |
| mean score (lenient) | 0.7500 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.7500 |
| mean steps | 3.8 |
| mean wall time | 156.7 s |
| format issues | 3 |
| folds granular / deep / corrected | 55 / 0 / 0 |
| llm_query calls | 2 |
| prompt / cached / completion tokens | 434242 / 207296 / 183542 |
| cache hit rate | 47.7% |
| cost (list price, USD) | **$0.9809** |
| cost per task | $0.0490 |
| cache saved | $0.2340 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 75 | 281233 | 204992 | 72.9% | 181135 | 0 |
| llm_query | 16 | 153009 | 2304 | 1.5% | 2407 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 3 | 0.667 |
| T2. Sequencing & Structure Reconstruction | 3 | 0.833 |
| T5. Attribution & Citation Alignment | 2 | 1.000 |
| T6. Aggregation & Clustering | 7 | 0.786 |
| T9. Version & Code Diff Analysis | 1 | 1.000 |
| T3. Evidence-Grounded QA | 1 | 0.000 |
| T10. Rule Induction & In-Context Learning | 1 | 1.000 |
| T7. Consistency & Compliance Checking | 2 | 0.500 |
