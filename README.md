# Recursive AgentFold

A pnpm + TypeScript workspace containing the **engine** and **benchmarks** for a recursive version of [AgentFold](docs/AgentFold.pdf) (proactive context folding, Ye et al. 2025). The engine adds three things on top of the paper:

- **`llm_query`**: a non-thinking reader model that scans contexts of up to millions of tokens. It splits them into fixed chunks of `contextWindow × (1 − reserveRatio)` tokens (default reserve 30%, configurable) and runs all chunks in parallel.
- **`branch`**: recursive AgentFold sub-agents. Each one starts with its own fresh folded context.
- **A cache-preserving layout**: deterministic chunks placed before the query, append-only summaries, a static system prompt and shared memos. This targets RLM's main weakness, cache misses on its sub-calls.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

```
packages/
  engine/       @raf/engine      – AgentFold loop, fold state, parser, llm_query, tools, runtime
  benchmarks/   @raf/benchmarks  – OOLONG-synth, synthetic needle/count, live prompt checks
docs/
  AgentFold.pdf, paper/agentfold.txt (text extraction), ARCHITECTURE.md
```

## Setup

```bash
pnpm install
cp .env.example .env     # set ZAI_API_KEY (Z.ai GLM coding plan) and model choices
pnpm typecheck && pnpm test
pnpm build               # emits packages/engine/dist
```

## Using the engine

```ts
import { ContextStore, OpenAICompatibleClient, RecursiveAgentFold } from '@raf/engine';

const store = new ContextStore();
store.add(hugeText, { id: 'corpus', title: 'My 2M-token corpus' });

const raf = new RecursiveAgentFold({
  rootLLM: new OpenAICompatibleClient({ baseUrl, apiKey, model: 'glm-5.1', contextWindow: 200_000, maxOutputTokens: 16_000, thinking: 'enabled' }),
  queryLLM: new OpenAICompatibleClient({ baseUrl, apiKey, model: 'glm-4.5-air', contextWindow: 128_000, maxOutputTokens: 1024, thinking: 'disabled' }),
  store,
  llmQuery: { reserveRatio: 0.3, concurrency: 4 },
  maxDepth: 1,
  onEvent: (e) => console.log(e.type),
});
const { answer, usage } = await raf.run('…question…');
console.log(answer, usage.byRole()); // per-role tokens + cache hit rate
```

## Benchmarks

```bash
pnpm bench --help
pnpm prompt-check                                           # live: reachability, llm_query JSON contract, tiny e2e run
pnpm bench fetch-oolong --dataset trec_coarse --context-len 131072   # HTTP range reads from HF parquet → .cache/
pnpm bench oolong --method raf --limit 10 --max-chunk-tokens 16384
pnpm bench oolong --method agentfold --limit 10             # plain AgentFold (grep/read/tally, no llm_query)
pnpm bench oolong --method direct --limit 10                # single-call baseline (official OOLONG prompt layout)
pnpm bench needle --method raf --tokens 1000000 --tasks 4   # synthetic mega-context lookup + count
pnpm bench oolong --mock --limit 4                          # offline harness dry-run (no network)
```

Each run writes `results/<stamp>-<bench>-<method>/` containing:

- `config.json`
- `results.jsonl`: one row per task, with score, steps, folds, and tokens/cache per role
- `traces/*.jsonl`: every agent event
- `summary.md` / `summary.json`

OOLONG notes:

- `trec_coarse` and `spam` exist only in the **validation** split, which is what RLM used. That split is selected automatically.
- Scoring is a TypeScript port of the official `eval_helpers.py`. Exact match, `0.75^|Δ|` for numeric answers, comparison phrases and dates are handled as in the original. A lenient score (as used in the RLM env) is reported alongside it.
