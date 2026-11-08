# Recursive AgentFold

**Proactive context folding for long-horizon agents.** A TypeScript implementation of the [AgentFold](https://arxiv.org/abs/2510.24699) loop — *AgentFold: Long-Horizon Web Agents with Proactive Context Management* (Ye et al., Tongyi Lab / Alibaba Group, 2025) — extended with an out-of-window document store, a cheap chunk reader, recursive branch specialists, and a cache-preserving prompt layout.

![Recursive AgentFold benchmark overview](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-overview.png?raw=true)

Long-horizon tasks fail in a specific way: tool output floods the window, the transcript gets truncated or summarised badly, and quality collapses exactly when the task becomes interesting. RAF treats the context as **a data structure the model edits**, not an append-only log. After each tool result the agent may emit a `folding` directive that replaces a contiguous range of earlier steps with one summary block. The context therefore stays a gap-free partition of the run: the task, a static system prompt, a stack of summaries, and the latest interaction.

| | |
|---|---|
| **Paper** | AgentFold, arXiv:2510.24699v1 (29 October 2025) |
| **Engine** | `@raf/engine` — dependency-free TypeScript, Node ≥ 22, ESM |
| **Benchmarks** | `@raf/benchmarks` — seven live-model harnesses over any OpenAI-compatible API |
| **UI** | `@raf/dsh-plugin` — Cordis plugin for the DeepSeek Harness Web UI |
| **Tests** | 76 unit tests, clean `pnpm typecheck` |

## What makes it different

- **The context is folded, not truncated.** The model decides what to compress and when, and writes the summary itself. Granular folds replace one step; deep folds merge many.
- **The corpus lives outside the context.** `ContextStore` holds the documents; the agent sees only a manifest (id, title, tokens, lines) and reaches into the store with `search`, `outline`, `grep`, `tally`, `read`, `list_documents`.
- **Reading is delegated.** `llm_query` ships a chunk plus a question to a cheap non-thinking model and returns a compact report, so the expensive root model never ingests raw corpus text.
- **Recursion is cheap.** `branch` spawns child agents with their own fold state that share the store and the reader memo. Only their final answer comes back.
- **Cache is a first-class constraint.** Prompt layout, chunk boundaries, and fold policy are all designed so the provider prefix cache keeps hitting — often 80–90 % of prompt tokens.

## Results at a glance

Seven featured runs, 5–7 November 2026, every number taken from the run's `summary.json`. All use `--method raf`, `glm-5.3` as the root and branch model, `glm-5.3-flash` as the `llm_query` reader, temperature 0.

| Benchmark | Context | Tasks | Passed | Score | Avg steps | Wall time | Cost | Cache hit |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Needle in a Haystack | 1,000,000 | 4 | 4 | **1.0000** | 2.25 | 19.4 s | $0.0297 | 88.8 % |
| RULER | 131,072 | 11 | 11 | **1.0000** | 2.18 | 25.8 s | $0.0778 | 90.4 % |
| OpenAI-MRCR | 131,072 | 6 | 6 | **1.0000** | 4.00 | 289.5 s | $0.2965 | 82.6 % |
| LongBench-v2 | long docs | 6 | 4 | **0.6667** | 5.67 | 333.3 s | $0.6041 | 79.8 % |
| LongBench-Pro | long docs | 20 | 14 | **0.7750** | 4.05 | 189.5 s | $1.3017 | 41.5 % |
| OOLONG `trec_coarse` | 131,072 | 5 | 5 | **1.0000** | 1.60 | 102.7 s | $0.1116 | 19.7 % |
| CodeGraph | 120,000 | 6 | 6 | **1.0000** | 3.67 | 284.0 s | $1.2594 | 76.9 % |
| **Total** | | **58** | **50** | **0.9202** | **3.48** | **1,244.2 s** | **$3.6807** | |

`Score` is the mean per-task score, `Passed` counts tasks scored 1.0, `Avg steps` is the mean agent step count per task, `Cache hit` is cached prompt tokens ÷ total prompt tokens, and `Cost` is the summed model spend at Z.ai list price (input $1.40, cached input $0.26, output $4.40 per 1M tokens). The total row's score is the **mean of the seven benchmark scores**, not a task-weighted accuracy; the total cost is $0.063 per task.

## Benchmark cards

### Needle in a Haystack — 1M tokens, 4 tasks

![Needle in a Haystack](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-needle.png?raw=true)

A 1,000,000-token haystack with one to three planted needles; tasks are `lookup` (what is the value) and `count` (how many times it appears). 4/4 in 2.25 steps, 88.8 % prompt-cache hit, $0.0074 per task. Run: `results/exp-needle-1m-d2`.

### RULER — 131K tokens, 11 subtasks

![RULER](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-ruler.png?raw=true)

Eleven synthetic long-context subtasks: single-key, multi-key, multi-query and multi-value NIAH, variable tracking, and the two word-frequency tasks (`cwe`, `fwe`). 11/11; the word-frequency ones are settled deterministically by `tally` instead of being estimated. 90.4 % cache hit and $0.0071 per task make this the cheapest run in the set. Run: `results/exp-ruler-131k-d2-v3`.

### OpenAI-MRCR — 131K tokens, 6 questions

![OpenAI-MRCR](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-mrcr.png?raw=true)

Multi-round coreference over a 131,072-token conversation. F1 1.000 (6/6) in four steps and 289 s. The generated template is simpler than the official benchmark (one sentence per instance), so read this as a harness check rather than a leaderboard entry. 82.6 % cache hit, $0.0494 per task. Run: `results/exp-mrcr-131k-d2`.

### LongBench-v2 — 6-task slice

![LongBench-v2](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-longbench.png?raw=true)

Six tasks across Code Repository Understanding and Multi-Document QA: 4/6 = 0.6667 (1.000 on code, 0.500 on multi-document QA). Both failures were answer-format failures, not retrieval failures — the run logged two format repairs. With n = 6 the 95 % interval is roughly [37 %, 90 %], so this is a direction, not a verdict. Run: `results/en-longbench-d2`.

### LongBench-Pro — 20 tasks, nine families

![LongBench-Pro](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-longbench-pro.png?raw=true)

14/20 = 0.775 with 61 folds and six format repairs. Strongest families: T6 aggregation 0.9286 (7 tasks), T5 attribution 1.0, T9 version & diff 1.0, T10 rule induction 1.0. Weakest: T3 evidence-grounded QA 0.0 (1 task) and T7 consistency 0.5 (2 tasks). Overall cache hit is only 41.5 % because four `llm_query` reader passes are uncached; the root prompt cache alone is 69.5 %. $0.0651 per task. Run: `results/en-longbench-pro-20-d2`.

### OOLONG `trec_coarse` — 131K tokens, 5 tasks

![OOLONG](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-oolong.png?raw=true)

Five label-frequency questions over a 131,072-token corpus: 5/5 in 1.6 steps and 102.7 s. The counting work is delegated — one `llm_query` invocation (18 underlying chunk calls) classified all 3,182 lines, which is why the overall cache hit drops to 19.7 % while the root prompt cache stays at 85.7 %. $0.0223 per task. Run: `results/rlm-port-oolong-d2`.

### CodeGraph — 120K tokens, 6 questions

![CodeGraph](https://github.com/hicaru/RecursiveAgentFold/blob/master/img/bench-codegraph.png?raw=true)

Six questions over a 120,000-token codebase in three families — single-hop symbol (`spec_specialist`), diamond dependency (`diamond_deps`), multi-hop chain (`chain_hop`). 6/6 in 3.67 steps. This is the most branch-heavy run: 93 folds, 22 root model calls against 101 branch calls, 76.9 % cache hit (root 68.2 %, branch 78.6 %). $0.2099 per task. Run: `results/rlm-port-codegraph-d2`.

## How it works

Each step the model sees the same four-part window, `C_t = (Q, T, S_{t-2}, I_{t-1})`:

| Part | Content |
|---|---|
| `Q` | the question, under a fixed `### Task` heading |
| `T` | system prompt and tool schemas, byte-identical across steps and tasks |
| `S` | multi-scale summaries, rendered as `**[Compressed Step x]**` and `**[Compressed Steps x-y]**` |
| `I` | the latest interaction: motivation, tool call, observation, board findings |

The agent may fold before it acts. A fold names a range of history blocks and replaces them with one summary, `{range: [k, n], summary: ...}`. `k == n` is a granular fold (one step condensed); `k < n` is a deep fold that merges several blocks into a coarser one, so the summary stack stays a contiguous, gap-free partition of everything that happened.

Folding is deliberately boring at runtime: `packages/engine/src/fold/state.ts` validates and normalizes every request (range end forced to the latest step, start snapped to a real block boundary, empty summary rejected). A missing directive falls back to a granular auto-fold, a malformed response is retried with a repair message appended at the tail (`maxFormatRetries`, default 2), and a step limit forces a final answer instead of a truncated trajectory.

Beyond the paper, four additions carry most of the long-context work:

1. **ContextStore** - documents live outside the window. The prompt carries only a manifest (id, title, token count, line count); tools fetch exactly the lines they need.
2. **llm_query** - a cheap, non-thinking reader model scans chunks in parallel in two modes: `locate` returns relevant lines, `extract` classifies and counts against an explicit category list. Chunk size follows the reader window and `reserveRatio` (0.3), so locate clamps at 32K tokens and extract at 8K.
3. **branch** - a child agent with fresh fold state, the same store and tools, depth+1 and its own budget (default `maxDepth = 2`). Only the final answer crosses back.
4. **Cache-first prompt layout** - see below.

### Recursion without echo chambers

`packages/engine/src/tools/branch.ts` and the research board (`context/board.ts`) keep sub-agents honest: candidates are deduplicated against ancestor results with a Jaccard echo guard (`ECHO_JACCARD = 0.8`), a specialist cap (`maxSpecialists = 12`), and demotion when a branch only repeats what the parent already knows. Root deep folding is suppressed until 16 blocks accumulate (`DEFAULT_ROOT_MIN_DEEP_FOLD_BLOCKS = 16`) while branches fold at 6, because the root prefix is the one that must stay stable across a whole run.

### Why the cache survives

Prompt caching only pays if the prefix is byte-identical across calls, so the layout is built around that:

- chunks are deterministic and line-aligned; the same line range always produces the same bytes
- the prompt order is system, then chunk, then query - the chunk comes *before* the question, so different questions share the same prefix
- chunk sizes are quantized to powers of two
- granular folds append a block after the fixed prefix; only the tail changes
- deep consolidation is the only operation that invalidates the prefix, and it is rare by construction

Measured hits: 88.8 % on needle, 90.4 % on RULER, 82.6 % on MRCR, 79.8 % on LongBench-v2, 76.9 % on CodeGraph. OOLONG looks low at 19.7 % only because a single `llm_query` fan-out dominates its token count; the agent window itself hits 85.7 %.

## Package layout

| Path | Role |
|---|---|
| `packages/engine/src/agent/agent-fold.ts` | the step loop: render, call, fold, parse, act |
| `packages/engine/src/fold/state.ts` | fold validation, normalization, block bookkeeping |
| `packages/engine/src/protocol/parser.ts` | tolerant parser for think, folding, motivation, tool call, answer |
| `packages/engine/src/context/` | `store.ts`, `bm25.ts`, `board.ts`, `ingest.ts`, `walk.ts`, `anydoc.ts`, `md-cache.ts` |
| `packages/engine/src/tools/` | `llm-query.ts`, `document-tools.ts`, `branch.ts`, `calculator.ts` |
| `packages/engine/src/prompts/` | `agent.ts` (root and branch prompts), `llm-query.ts` |
| `packages/engine/src/llm/` | `openai-compatible.ts`, `mock.ts`, `usage.ts` |
| `packages/engine/src/runtime.ts` | public API, `DEFAULT_MAX_DEPTH = 2`, tool wiring |
| `packages/benchmarks/src/` | `cli.ts`, `runner.ts`, `config.ts`, `pricing.ts`, `compare.ts`, `prompt-check.ts`, `dsh-host.ts`, one folder per benchmark |
| `packages/benchmarks/test/scoring.test.ts` | official OOLONG scoring rules ported to TypeScript |
| `packages/dsh-plugin/` | Cordis plugin: settings page, per-Session Standard / RAF switch, branch tool view |
| `results/` | one directory per run: `config.json`, `results.jsonl`, `traces/`, `summary.md` |
| `img/render_cards.py`, `img/render_overview.py` | generate the cards above from `summary.json` |
