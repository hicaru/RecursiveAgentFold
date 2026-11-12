# Benchmark summary

| metric | value |
|---|---|
| tasks | 20 |
| mean score (primary) | **0.4250** |
| correct (score = 1) | **8/20** |
| mean score (official OOLONG) | 0.4250 |
| mean score (lenient) | 0.4250 |
| errors / overflow | 1 |
| content-filtered | 0 |
| mean score (excluding errors) | 0.4474 |
| mean steps | 4.6 |
| mean wall time | 676.8 s |
| format issues | 6 |
| folds granular / deep / corrected | 82 / 0 / 0 |
| llm_query calls | 0 |
| prompt / cached / completion tokens | 532019 / 407360 / 269567 |
| root cache hit rate | **77.1%** |
| branch cache hit rate | 72.5% |
| cache hit rate (all tiers) | 76.6% |
| cost (list price, USD) | **$1.4665** |
| cost per task | $0.0733 |
| cache saved | $0.4644 |

## By role

| role | calls | prompt | cached | hit rate | completion | errors |
|---|---|---|---|---|---|---|
| root | 93 | 466839 | 360128 | 77.1% | 259227 | 1 |
| branch | 11 | 65180 | 47232 | 72.5% | 10340 | 0 |

## By task

| task | n | score |
|---|---|---|
| T1. Retrieval & Ranking | 3 | 0.000 |
| T2. Sequencing & Structure Reconstruction | 3 | 0.500 |
| T5. Attribution & Citation Alignment | 2 | 0.500 |
| T6. Aggregation & Clustering | 7 | 0.571 |
| T9. Version & Code Diff Analysis | 1 | 1.000 |
| T3. Evidence-Grounded QA | 1 | 0.000 |
| T10. Rule Induction & In-Context Learning | 1 | 1.000 |
| T7. Consistency & Compliance Checking | 2 | 0.000 |
