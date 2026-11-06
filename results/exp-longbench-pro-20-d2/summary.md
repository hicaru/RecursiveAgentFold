# Benchmark summary

| metric | value |
|---|---|
| tasks | 20 |
| mean score (primary) | **0.6500** |
| correct (score = 1) | **13/20** |
| mean score (official OOLONG) | 0.6500 |
| mean score (lenient) | 0.6500 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.6500 |
| mean steps | 3.9 |
| mean wall time | 210.2 s |
| format issues | 5 |
| folds granular / deep / corrected | 58 / 0 / 0 |
| llm_query calls | 1 |
| prompt / cached / completion tokens | 484152 / 227200 / 238799 |
| cache hit rate | 46.9% |
| cost (list price, USD) | **$1.2826** |
| cost per task | $0.0641 |
| cache saved | $0.2572 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 81 | 342456 | 225408 | 65.8% | 235822 | 0 |
| llm_query | 16 | 141696 | 1792 | 1.3% | 2977 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 3 | 0.333 |
| T2. Sequencing & Structure Reconstruction | 3 | 1.000 |
| T5. Attribution & Citation Alignment | 2 | 1.000 |
| T6. Aggregation & Clustering | 7 | 0.571 |
| T9. Version & Code Diff Analysis | 1 | 1.000 |
| T3. Evidence-Grounded QA | 1 | 1.000 |
| T10. Rule Induction & In-Context Learning | 1 | 1.000 |
| T7. Consistency & Compliance Checking | 2 | 0.000 |
