# Benchmark summary

| metric | value |
|---|---|
| tasks | 20 |
| mean score (primary) | **0.0000** |
| correct (score = 1) | **0/20** |
| mean score (official OOLONG) | 0.0000 |
| mean score (lenient) | 0.0000 |
| errors / overflow | 0 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.0000 |
| mean steps | 3.0 |
| mean wall time | 0.0 s |
| format issues | 0 |
| folds granular / deep / corrected | 40 / 0 / 20 |
| llm_query calls | 20 |
| prompt / cached / completion tokens | 989591 / 283968 / 5620 |
| root cache hit rate | **91.3%** |
| branch cache hit rate | 0.0% |
| cache hit rate (all tiers) | 28.7% |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 60 | 249192 | 227392 | 91.3% | 3220 | 0 |
| llm_query | 96 | 740399 | 56576 | 7.6% | 2400 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 3 | 0.000 |
| T2. Sequencing & Structure Reconstruction | 3 | 0.000 |
| T5. Attribution & Citation Alignment | 2 | 0.000 |
| T6. Aggregation & Clustering | 7 | 0.000 |
| T9. Version & Code Diff Analysis | 1 | 0.000 |
| T3. Evidence-Grounded QA | 1 | 0.000 |
| T10. Rule Induction & In-Context Learning | 1 | 0.000 |
| T7. Consistency & Compliance Checking | 2 | 0.000 |
