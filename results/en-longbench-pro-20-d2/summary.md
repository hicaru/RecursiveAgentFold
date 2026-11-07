# Benchmark summary

| metric | value |
|---|---|
| tasks | 20 |
| mean score (primary) | **0.7750** |
| correct (score = 1) | **14/20** |
| mean score (official OOLONG) | 0.7750 |
| mean score (lenient) | 0.7750 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.7750 |
| mean steps | 4.0 |
| mean wall time | 189.5 s |
| format issues | 6 |
| folds granular / deep / corrected | 61 / 0 / 0 |
| llm_query calls | 4 |
| prompt / cached / completion tokens | 526073 / 218112 / 248463 |
| cache hit rate | 41.5% |
| cost (list price, USD) | **$1.3017** |
| cost per task | $0.0651 |
| cache saved | $0.2486 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 83 | 313947 | 218112 | 69.5% | 244818 | 0 |
| llm_query | 18 | 212126 | 0 | 0.0% | 3645 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 3 | 0.667 |
| T2. Sequencing & Structure Reconstruction | 3 | 0.667 |
| T5. Attribution & Citation Alignment | 2 | 1.000 |
| T6. Aggregation & Clustering | 7 | 0.929 |
| T9. Version & Code Diff Analysis | 1 | 1.000 |
| T3. Evidence-Grounded QA | 1 | 0.000 |
| T10. Rule Induction & In-Context Learning | 1 | 1.000 |
| T7. Consistency & Compliance Checking | 2 | 0.500 |
