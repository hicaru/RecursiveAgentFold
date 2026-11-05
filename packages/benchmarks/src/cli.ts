import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_DOCUMENT_TOOL_OPTIONS, DEFAULT_MAX_OBSERVATION_TOKENS } from '@raf/engine';
import { compareRuns } from './compare.js';
import { createModels, loadEnv, repoRoot } from './config.js';
import { buildNeedleTasks } from './needle/needle.js';
import { fetchOolong } from './oolong/dataset.js';
import { buildOolongTasks } from './oolong/tasks.js';
import { createMockModels } from './mock.js';
import { promptCheck } from './prompt-check.js';
import { priceFor } from './pricing.js';
import { runTasks, summarize, writeSummary, type BenchTask, type Method } from './runner.js';

const HELP = `Recursive AgentFold benchmarks

Usage: pnpm bench <command> [options]

Commands:
  models                         List models exposed by the configured endpoint
  prompt-check                   Live check of the Chinese prompts: per-tool probes, folding, reader, e2e
  compare <oldDir> <newDir>      Compare two result dirs by task id (score, steps, format, tokens)
  fetch-oolong                   Download + cache OOLONG-synth rows (HTTP range reads)
  oolong                         Run OOLONG-synth (trec_coarse@131K etc.)
  needle                         Run the synthetic mega-context needle/count benchmark

Common options:
  --method raf|agentfold|direct  (default raf)  raf = AgentFold + llm_query + branch,
                                 agentfold = plain AgentFold with grep/read, direct = single call
  --root-model <id>              override RAF_ROOT_MODEL
  --query-model <id>             override RAF_QUERY_MODEL
  --reserve-ratio <0..1>         llm_query chunk = window * (1 - ratio)   (default 0.3)
  --max-chunk-tokens <n>         cap llm_query chunk size
  --query-concurrency <n>        parallel llm_query chunk calls
  --max-steps <n>                root step budget (default 30)
  --max-depth <n>                branch recursion depth (default 1)
  --concurrency <n>              parallel task groups (default 1)
  --limit <n> --offset <n>       task slice
  --out <dir>                    results directory (default results/<timestamp>-<bench>-<method>)
  --mock                         offline scripted models (harness dry-run, scores meaningless)
  --no-share-memo                do not share the llm_query memo across questions of one context
  --only <name>                  prompt-check only: a tool name, folding, reader or e2e
  --system-extra <text>          append text to the agent system prompt (static, for A/B)

oolong / fetch-oolong:
  --dataset <name>               default trec_coarse
  --context-len <n>              default 131072
  --split test|validation        default: validation for trec_coarse/spam, else test
  --windows <n>                  only the first n context windows
  --no-hint                      do not prepend the dataset description

needle:
  --tools a,b,c                  override tool set (llm_query,branch,grep,tally,read,calculator);
                                 default: raf = all, agentfold (vanilla) = grep,read,calculator
  --resume                       with --out: skip tasks already in results.jsonl (re-runs errors)

needle:
  --tokens <n>                   haystack size (default 200000)
  --tasks <n>                    number of questions (default 4)
  --seed <n>

compare:
  pnpm bench compare <oldDir> <newDir>   join by task id; report common non-filtered
`;

function opt<T>(v: unknown, f: (s: string) => T): T | undefined {
  return v === undefined ? undefined : f(String(v));
}

async function main() {
  loadEnv();
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      method: { type: 'string', default: 'raf' },
      'root-model': { type: 'string' },
      'query-model': { type: 'string' },
      'reserve-ratio': { type: 'string' },
      'max-chunk-tokens': { type: 'string' },
      'query-concurrency': { type: 'string' },
      'max-steps': { type: 'string' },
      'max-depth': { type: 'string' },
      concurrency: { type: 'string' },
      limit: { type: 'string' },
      offset: { type: 'string' },
      out: { type: 'string' },
      dataset: { type: 'string', default: 'trec_coarse' },
      'context-len': { type: 'string', default: '131072' },
      split: { type: 'string' },
      windows: { type: 'string' },
      'no-hint': { type: 'boolean', default: false },
      'no-share-memo': { type: 'boolean', default: false },
      only: { type: 'string' },
      'system-extra': { type: 'string' },
      mock: { type: 'boolean', default: false },
      tools: { type: 'string' },
      resume: { type: 'boolean', default: false },
      'max-read-lines': { type: 'string' },
      'max-read-tokens': { type: 'string' },
      'max-grep-matches': { type: 'string' },
      'max-obs-tokens': { type: 'string' },
      tokens: { type: 'string', default: '200000' },
      tasks: { type: 'string', default: '4' },
      seed: { type: 'string', default: '42' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) {
    console.log(HELP);
    return;
  }
  if (cmd === 'compare') {
    const [oldDir, newDir] = positionals.slice(1);
    if (!oldDir || !newDir) throw new Error('usage: pnpm bench compare <oldDir> <newDir>');
    const resolvePath = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);
    console.log(compareRuns(resolvePath(oldDir), resolvePath(newDir)));
    return;
  }
  const root = repoRoot();
  const cacheDir = join(root, '.cache');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const method = values.method as Method;
  if (!['raf', 'agentfold', 'direct'].includes(method)) throw new Error(`unknown --method ${method}`);
  // --out is relative to where the user invoked pnpm (INIT_CWD), not the package dir
  const outDir = values.out ? resolve(process.env.INIT_CWD ?? process.cwd(), values.out) : join(root, 'results', `${stamp}-${cmd}-${method}`);
  const modelOverrides = {
    rootModel: values['root-model'],
    queryModel: values['query-model'],
    reserveRatio: opt(values['reserve-ratio'], Number),
    maxChunkTokens: opt(values['max-chunk-tokens'], Number),
    queryConcurrency: opt(values['query-concurrency'], Number),
  };

  if (cmd === 'models') {
    const base = process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4';
    const res = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${process.env.ZAI_API_KEY}` } });
    console.log(await res.text());
    return;
  }

  if (cmd === 'prompt-check') {
    mkdirSync(outDir, { recursive: true });
    const ok = await promptCheck(createModels(modelOverrides), outDir, console.log, values.only);
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const oolongOpts = {
    // trec_coarse and spam only exist in the validation split (as used by RLM).
    split: (values.split ?? (['trec_coarse', 'spam'].includes(values.dataset!) ? 'validation' : 'test')) as 'test' | 'validation',
    dataset: values.dataset,
    contextLen: Number(values['context-len']),
    cacheDir,
    hfToken: process.env.HF_TOKEN || undefined,
    log: (s: string) => console.log(s),
  };

  if (cmd === 'fetch-oolong') {
    const rows = await fetchOolong(oolongOpts);
    console.log(`${rows.length} rows, ${new Set(rows.map((r) => r.context_window_id)).size} context windows`);
    return;
  }

  let tasks: BenchTask[];
  if (cmd === 'oolong') {
    let rows = await fetchOolong(oolongOpts);
    if (values.windows) {
      const keep = new Set([...new Set(rows.map((r) => r.context_window_id))].slice(0, Number(values.windows)));
      rows = rows.filter((r) => keep.has(r.context_window_id));
    }
    tasks = buildOolongTasks(rows, { hint: !values['no-hint'] });
  } else if (cmd === 'needle') {
    tasks = buildNeedleTasks({ tokens: Number(values.tokens), tasks: Number(values.tasks), seed: Number(values.seed) });
  } else {
    console.log(HELP);
    throw new Error(`unknown command ${cmd}`);
  }
  const offset = Number(values.offset ?? 0);
  tasks = tasks.slice(offset, values.limit ? offset + Number(values.limit) : undefined);

  const models = values.mock
    ? createMockModels({ reserveRatio: modelOverrides.reserveRatio ?? 0.3, maxChunkTokens: modelOverrides.maxChunkTokens })
    : createModels(modelOverrides);
  mkdirSync(outDir, { recursive: true });
  const config = {
    bench: cmd,
    method,
    startedAt: new Date().toISOString(),
    tasks: tasks.length,
    taskIds: tasks.map((t) => t.id),
    argv: process.argv.slice(2),
    tools: values.tools ?? (method === 'raf' ? 'all' : method === 'agentfold' ? 'grep,read,calculator' : 'none'),
    systemPromptExtra: values['system-extra'],
    models: models.describe(),
  };
  writeFileSync(join(outDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`running ${tasks.length} task(s) → ${outDir}`);
  const results = await runTasks(tasks, {
    method,
    root: models.root,
    query: models.query,
    llmQuery: models.llmQuery,
    maxDepth: opt(values['max-depth'], Number),
    rootMaxSteps: opt(values['max-steps'], Number),
    concurrency: opt(values.concurrency, Number),
    shareQueryMemo: !values['no-share-memo'],
    tools: values.tools?.split(',').map((t) => t.trim()).filter(Boolean),
    resume: values.resume,
    documentTools: {
      maxReadLines: opt(values['max-read-lines'], Number) ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadLines,
      maxReadTokens: opt(values['max-read-tokens'], Number) ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxReadTokens,
      maxGrepMatches: opt(values['max-grep-matches'], Number) ?? DEFAULT_DOCUMENT_TOOL_OPTIONS.maxGrepMatches,
    },
    maxObservationTokens: opt(values['max-obs-tokens'], Number) ?? DEFAULT_MAX_OBSERVATION_TOKENS,
    systemPromptExtra: values['system-extra'],
    outDir,
  });
  const prices = { root: priceFor(models.root.profile.name), query: priceFor(models.query.profile.name) };
  const md = writeSummary(outDir, summarize(results, { bench: cmd, method }, prices));
  console.log(`\n${md}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
