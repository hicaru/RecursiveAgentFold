# Recursive AgentFold

**Proactive context folding for long-horizon agents.** A TypeScript implementation of the AgentFold loop with recursive branches and a non-thinking reader for mega-large contexts — laid out so the provider prefix cache survives every fold.

![Recursive AgentFold benchmark overview](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-overview.png?raw=true)

*58 tasks · 50 solved · 0.9202 mean score · 3.48 steps per task · $0.063 per task. Generated from `results/` by `img/render_overview.py`.*

## What this is

A ReAct-style loop appends every observation, tool result and sub-agent report to one growing transcript; at 10⁵–10⁶ tokens that transcript saturates the window, cost grows at every step, and the provider prefix cache is invalidated on nearly every step. The usual fix — summarizing the whole history every N steps — is cheap but lossy: details that looked irrelevant at step 3 are exactly what step 40 needs, and once a fixed summarizer has dropped them they are gone.

Recursive AgentFold (RAF) implements the third option from **AgentFold** (*Long-Horizon Web Agents with Proactive Context Management*, [arXiv:2510.24699v1](https://arxiv.org/abs/2510.24699), Tongyi Lab, Alibaba, 2025-10-29): the agent manages its own context the way a human takes notes. After every step it emits a **folding** directive that condenses the past into contiguous, gap-free summary blocks, and keeps only the most recent interaction at full fidelity. A *granular* fold condenses one step; a *deep* fold retroactively consolidates a whole multi-step subtrajectory, including blocks written earlier.

## The loop, in one line of math

At step $t$ the model sees one window:

$$C_t = (Q,\; T,\; S_{t-2},\; I_{t-1})$$

$Q$ is the task. $T$ is the system prompt plus the tool schemas: byte-identical on every step, so the provider prefix cache hits. $S_{t-2} = (s_{x_1,y_1}, \dots, s_{x_m,y_m})$ is the set of folded summaries, a contiguous gap-free partition of steps $0 \dots t-2$. $I_{t-1}$ is the last interaction at full fidelity.

The model folds by emitting one directive:

$$\{\, \text{range}: [k, n],\; \text{summary}: \sigma \,\}$$

`fold/state.ts` forces $n = t-1$ and snaps $k$ down to the start of the block that contains it, then drops every block in $[k, n]$ and adds $s_{k,\,t-1} = \sigma$:

- $k = n$: **granular fold**, $|S_t| = |S_{t-1}| + 1$.
- $k < n$: **deep fold**, $|S_t| = |S_{t-1}| - r + 1$, with $r$ retracted blocks.

The partition invariant $\sum_i (y_i - x_i + 1) = n + 1$ holds after every fold: no step is lost, no step is stored twice. Only blocks at or after the first changed block are re-rendered, so the prompt prefix before it is byte-identical and stays cached.

Recursion adds one depth term. The root folds at $b_0 = 16$ blocks, a branch at $b_d = 6$ blocks, and $d \le 2$. A branch whose tokens repeat an ancestor at Jaccard similarity $J \ge 0.8$ is rejected as an echo, and at most $12$ specialists run at once.

## Results at a glance

| Benchmark | Context | Tasks | Correct | Score | Steps | Wall | Cost | Cache hit |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Needle in a haystack | 1,000,000 | 4 | 4/4 | **1.0000** | 2.25 | 19.4 s | $0.0297 | 88.8% |
| RULER | 131,072 | 11 | 11/11 | **1.0000** | 2.18 | 25.8 s | $0.0778 | 90.4% |
| MRCR | 131,072 | 6 | 6/6 | **1.0000** | 4.00 | 289.5 s | $0.2965 | 82.6% |
| LongBench-v2 | long docs | 6 | 4/6 | 0.6667 | 5.67 | 333.3 s | $0.6041 | 79.8% |
| LongBench-Pro | long docs | 20 | 14/20 | 0.7750 | 4.05 | 189.5 s | $1.3017 | 41.5% |
| OOLONG (`trec_coarse`) | 131,072 | 5 | 5/5 | **1.0000** | 1.60 | 102.7 s | $0.1116 | 19.7% |
| CodeGraph | 120,000 | 6 | 6/6 | **1.0000** | 3.67 | 284.0 s | $1.2594 | 76.9% |
| **Total** | — | **58** | **50** | **0.9202** | **3.48** | **1,244.2 s** | **$3.6807** | — |

That is **$0.063 per task** end to end, including branch specialists and reader calls.

All seven headline runs use `method=raf`, root model `glm-5.3`, reader model `glm-5.3-flash`, `temperature: 0`, `maxDepth = 2`, every tool enabled, and the Z.ai coding endpoint (`https://api.z.ai/api/coding/paas/v4`). Costs come from `packages/benchmarks/src/pricing.ts` using Z.ai list prices for `glm-5.3` — **$1.40 input / $0.26 cached / $4.40 output per 1M tokens** — and are computed as `(fresh * input + cached * cached + completion * output) / 1e6`. "Correct" means `score >= 1`, the exact rule at `packages/benchmarks/src/runner.ts:316`.

## Benchmark cards

Each card below is rendered from a real run directory in `results/`; the numbers in the image and in the bullets come from the same `summary.json`.

### Needle in a haystack — 1,000,000 tokens

![Needle at 1M tokens](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-needle.png?raw=true)

Two needles buried in a one-million-token haystack, four tasks (two `lookup`, two `count`), `results/exp-needle-1m-d2`.

- 4/4 correct, mean score 1.0000, 2.25 steps, 19.4 s wall clock
- 5 folds, **0** `llm_query` calls, 0 format retries
- 24,424 prompt tokens, 21,696 of them cached: **88.8% hit**, $0.0297 total (≈ $0.0074 per task)

### RULER — 131,072 tokens

![RULER at 131K tokens](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-ruler.png?raw=true)

Eleven synthetic long-context subtasks in `results/exp-ruler-131k-d2-v3`: single-needle retrieval at three depths, three multi-key variants, multi-query, multi-value, variable tracking, and common/frequent word extraction.

- 11/11 correct, score 1.0000, 2.18 steps, 25.8 s, $0.0778 (≈ $0.0071 per task)
- 13 folds and **90.4% cache hit**: every subtask shares the same long prefix

### MRCR — 131,072 tokens

![MRCR at 131K tokens](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-mrcr.png?raw=true)

Six multi-round coreference tasks (`mrcr_coref`) in `results/exp-mrcr-131k-d2`: the answer depends on an entity introduced many rounds earlier, so the fold state has to preserve referential identity rather than raw text.

- 6/6 correct, score 1.0000, 4.00 steps, 289.5 s, $0.2965 (≈ $0.0494 per task)
- 18 folds, 82.6% cache hit: each round is a new long prompt, so less of the prefix survives than in RULER

### LongBench-v2 — long documents

![LongBench-v2 long-context tasks](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-longbench.png?raw=true)

Six LongBench-v2 tasks in `results/en-longbench-d2`, spanning *Multi-Document QA* and *Code Repository Understanding*: folding has to keep enough cross-document detail for the answer to survive consolidation.

- 4/6 correct, score 0.6667, 5.67 steps, 333.3 s, $0.6041 (≈ $0.1007 per task)
- 28 folds, 2 format repairs, 79.8% cache hit
- Per domain: Multi-Document QA 4 tasks @ mean 0.5 · Code Repository Understanding 2 tasks @ 1.0
- Failure mode is detail loss, not protocol failure: deep folds consolidate aggressively and the agent sometimes answers from the summary instead of drilling back into the document with `search` / `read`

### LongBench-Pro — 20 tasks

![LongBench-Pro 20 tasks](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-longbench-pro.png?raw=true)

The largest single run (`results/en-longbench-pro-20-d2`): 20 tasks over 10 categories, mixing single-document QA, multi-document synthesis and counting.

- 14/20 correct, score 0.7750, 4.05 steps, 189.5 s, $1.3017 (≈ $0.0651 per task)
- 61 folds, 4 `llm_query` calls, 6 format repairs
- 41.5% cache hit at run level (root 69.5%) — the only benchmark below 50%, because every task starts a brand-new long prefix that the cache has never seen
- Per category: T6 7 @ 0.9286 · T1 3 @ 0.6667 · T2 3 @ 0.6667 · T5 2 @ 1.0 · T7 2 @ 0.5 · T3 1 @ 0.0 · T9 1 @ 1.0 · T10 1 @ 1.0

### OOLONG `trec_coarse` — 131,072 tokens

![OOLONG trec_coarse at 131K tokens](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-oolong.png?raw=true)

Five aggregation tasks over the TREC coarse dataset (`results/rlm-port-oolong-d2`). The question asks for counts and properties over thousands of labelled lines, which is exactly what the `llm_query` **extract** path was built for: classify every chunk, then aggregate with `calculator`.

- 5/5 correct, score 1.0000, 1.60 steps, 102.7 s, $0.1116 (≈ $0.0223 per task)
- A single `llm_query` fanned out to 18 chunk calls and classified all 3,182 lines (numeric value 969, entity 815, human being 416, description and abstract concept 388, location 303, abbreviation 291)
- 3 folds, 1 format repair, 19.7% cache hit (root 85.7%): the reader prompts are fresh per chunk, so that is where the cache hit is lost
- Sub-tasks: MOST_FREQ 1 · LEAST_FREQ 1 · RELATIVE_FREQ 3

### CodeGraph — 120,000 tokens

![CodeGraph at 120K tokens](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-codegraph.png?raw=true)

Six repository-graph tasks at 3 hops (`results/rlm-port-codegraph-d2`): diamond dependencies, chain hops and spec/specialist lookups over a large code base, where the agent must recurse into branches instead of reading everything.

- 6/6 correct, score 1.0000, 3.67 steps, 284.0 s, $1.2594 (≈ $0.2099 per task), because recursive branches re-read large code slices
- 93 folds 76.9% cache hit
- Sub-tasks: spec_specialist 2 · diamond_deps 2 · chain_hop 2

## Recursion depth ablation

Depth is the one knob that changes both quality and cost, so it was swept on CodeGraph 120K (6 tasks, 3 hops) in `results/exp-codegraph-d0` … `exp-codegraph-d4`:

| `maxDepth` | correct | score | steps | wall | cost | cache hit | folds |
|---|---|---|---|---|---|---|---|
| 0 (no branches) | 6/6 | 1.0000 | 11.5 | 117.6 s | $0.2825 | 84.3% | 63 |
| 1 | 5/6 | 0.8333 | 2.3 | 190.5 s | $0.6230 | 75.4% | — |
| **2 (default)** | **6/6** | **1.0000** | **2.7** | 157.1 s | **$0.6312** | 77.1% | 52 |
| 3 | 6/6 | 1.0000 | 3.2 | 258.0 s | $0.8729 | 78.8% | — |
| 4 | 6/6 | 1.0000 | 4.3 | 272.9 s | $0.8772 | 80.1% | — |

The step column is where depth pays. Depth 0 answers 6/6 but needs 11.5 steps, 63 folds and $0.2825; depth 1 falls to 5/6 (0.8333) at 2.3 steps and $0.6230; depth 2 recovers 6/6 at 2.7 steps and $0.6312. Depth 3 costs 1.38× depth 2 ($0.8729 / $0.6312) for the same 6/6, and depth 4 adds $0.0043 ($0.8772 - $0.8729) with no score change. The default is therefore `DEFAULT_MAX_DEPTH = 2` (`packages/engine/src/runtime.ts:24`).

<!-- RAF-APPEND -->
