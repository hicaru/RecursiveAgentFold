import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheSaved, costOf, type TokenPrice } from './pricing.js';
import {
  ContextStore,
  LLMQueryEngine,
  RecursiveAgentFold,
  UsageTracker,
  createLimiter,
  type AgentEvent,
  type LLMClient,
  type LLMQueryOptions,
  type UsageBucket,
} from '@raf/engine';

export type Method = 'direct' | 'agentfold' | 'raf';

export interface BenchDocument {
  id: string;
  title: string;
  text: string;
  tokens?: number;
}

export interface BenchTask {
  id: string;
  /** Tasks sharing a group share the same documents (and provider caches). */
  group: string;
  question: string;
  documents: BenchDocument[];
  meta: Record<string, unknown>;
  score(output: string): { score: number; parsed?: string; extra?: Record<string, number> };
  /** Prompt for the direct baseline (defaults to OOLONG's official layout). */
  directMessages?: () => Array<{ role: 'system' | 'user'; content: string }>;
}

export interface RunConfig {
  method: Method;
  root: LLMClient;
  query?: LLMClient;
  llmQuery?: LLMQueryOptions;
  maxDepth?: number;
  rootMaxSteps?: number;
  branchMaxSteps?: number;
  systemPromptExtra?: string;
  /** Parallel task groups. Tasks inside a group run sequentially (cache reuse). */
  concurrency?: number;
  /** Share the llm_query memo across questions of the same document group. Default true. */
  shareQueryMemo?: boolean;
  /** Tool set override (default: method preset). */
  tools?: string[];
  documentTools?: { maxReadLines?: number; maxReadTokens?: number; maxGrepMatches?: number };
  maxObservationTokens?: number;
  /** Skip tasks already present (without error) in outDir/results.jsonl. */
  resume?: boolean;
  outDir: string;
  log?: (s: string) => void;
}

export interface TaskResult {
  id: string;
  group: string;
  method: Method;
  meta: Record<string, unknown>;
  output: string | null;
  parsed?: string;
  score: number;
  extra?: Record<string, number>;
  steps: number;
  terminated: string;
  formatIssues: number;
  error?: string;
  wallMs: number;
  usage: Record<string, UsageBucket & { cacheHitRate: number }>;
  total: UsageBucket & { cacheHitRate: number };
  folds: { granular: number; deep: number; corrected: number };
  llmQueryCalls: number;
}

function buildStore(docs: BenchDocument[]): ContextStore {
  const store = new ContextStore();
  for (const d of docs) store.add(d.text, { id: d.id, title: d.title, tokens: d.tokens });
  return store;
}

async function runDirect(task: BenchTask, cfg: RunConfig, usage: UsageTracker): Promise<Pick<TaskResult, 'output' | 'steps' | 'terminated' | 'error' | 'formatIssues'>> {
  const messages =
    task.directMessages?.() ??
    [
      { role: 'system' as const, content: `You are a helpful assistant.\n\n${task.documents.map((d) => d.text).join('\n\n')}` },
      { role: 'user' as const, content: task.question },
    ];
  const promptTokens = task.documents.reduce((a, d) => a + (d.tokens ?? d.text.length / 3.6), 0);
  if (promptTokens + 2000 > cfg.root.profile.contextWindow) {
    return { output: null, steps: 0, terminated: 'context_overflow', error: `context ~${Math.round(promptTokens)} tokens exceeds ${cfg.root.profile.contextWindow}`, formatIssues: 0 };
  }
  try {
    const res = await cfg.root.complete({ messages, purpose: 'direct' });
    usage.record('direct', res.usage, res.latencyMs);
    return { output: res.text, steps: 1, terminated: 'answer', formatIssues: 0 };
  } catch (e) {
    usage.recordError('direct');
    return { output: null, steps: 0, terminated: 'error', error: (e as Error).message, formatIssues: 0 };
  }
}

/** Tool presets: vanilla AgentFold = grep/read/calculator only (no llm_query, branch, tally). */
export function toolPreset(cfg: Pick<RunConfig, 'method' | 'tools'>): Record<string, boolean> {
  const all = ['llm_query', 'branch', 'grep', 'tally', 'read', 'calculator'];
  const chosen = cfg.tools ?? (cfg.method === 'raf' ? all : ['grep', 'read', 'calculator']);
  return Object.fromEntries(all.map((t) => [t, chosen.includes(t)]));
}

export async function runTasks(tasks: BenchTask[], cfg: RunConfig): Promise<TaskResult[]> {
  const log = cfg.log ?? console.log;
  mkdirSync(join(cfg.outDir, 'traces'), { recursive: true });
  const resultsPath = join(cfg.outDir, 'results.jsonl');
  const previous: TaskResult[] = [];
  if (cfg.resume && existsSync(resultsPath)) {
    for (const line of readFileSync(resultsPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as TaskResult;
      // 'filtered' rows are provider refusals, not model failures: keep them and report separately.
      if (r.terminated !== 'error') previous.push(r);
    }
    const done = new Set(previous.map((r) => r.id));
    tasks = tasks.filter((t) => !done.has(t.id));
    log(`resume: ${previous.length} task(s) already done, ${tasks.length} to run`);
  }
  writeFileSync(resultsPath, previous.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const groups = new Map<string, BenchTask[]>();
  for (const t of tasks) groups.set(t.group, [...(groups.get(t.group) ?? []), t]);
  const limit = createLimiter(cfg.concurrency ?? 1);
  const results: TaskResult[] = [...previous];
  let done = 0;

  await Promise.all(
    [...groups.values()].map((group) => {
      const store = cfg.method === 'direct' ? undefined : buildStore(group[0]!.documents);
      // One llm_query engine per document group: memo + chunk cache shared across its questions.
      const queryEngine =
        toolPreset(cfg).llm_query && cfg.query && store && cfg.shareQueryMemo !== false
          ? new LLMQueryEngine(cfg.query, store, new UsageTracker(), cfg.llmQuery)
          : undefined;
      return Promise.all(
        group.map((task) =>
          limit(async () => {
          const usage = new UsageTracker();
          const tracePath = join(cfg.outDir, 'traces', `${task.id.replace(/[^\w.-]/g, '_')}.jsonl`);
          writeFileSync(tracePath, '');
          const folds = { granular: 0, deep: 0, corrected: 0 };
          let llmQueryCalls = 0;
          const onEvent = (e: AgentEvent) => {
            if (e.type === 'fold') {
              folds[e.outcome.kind]++;
              if (e.outcome.corrections.length) folds.corrected++;
            }
            if (e.type === 'llm_query') llmQueryCalls++;
            appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), ...e })}\n`);
            if (e.type === 'tool_call') log(`  [${task.id}] ${e.agent} step ${e.step}: ${e.action.name} ${JSON.stringify(e.action.arguments).slice(0, 160)}`);
            if (e.type === 'format_error') log(`  [${task.id}] ${e.agent} step ${e.step}: format error ${e.errors.join('; ')}`);
            if (e.type === 'error') log(`  [${task.id}] ${e.agent}: ERROR ${e.message}`);
          };
          const started = Date.now();
          let r: Pick<TaskResult, 'output' | 'steps' | 'terminated' | 'error' | 'formatIssues'>;
          if (cfg.method === 'direct') r = await runDirect(task, cfg, usage);
          else {
            const raf = new RecursiveAgentFold({
              rootLLM: cfg.root,
              queryLLM: toolPreset(cfg).llm_query ? cfg.query : undefined,
              queryEngine,
              store: store!,
              llmQuery: cfg.llmQuery,
              maxDepth: toolPreset(cfg).branch ? (cfg.maxDepth ?? 1) : 0,
              rootMaxSteps: cfg.rootMaxSteps ?? 30,
              branchMaxSteps: cfg.branchMaxSteps ?? 15,
              agent: { systemPromptExtra: cfg.systemPromptExtra, maxObservationTokens: cfg.maxObservationTokens },
              documentTools: cfg.documentTools,
              enable: toolPreset(cfg),
              usage,
              onEvent,
            });
            const res = await raf.run(task.question);
            r = { output: res.answer, steps: res.steps, terminated: res.terminated, error: res.error, formatIssues: res.formatIssues };
          }
          const s = r.output !== null ? task.score(r.output) : { score: 0 };
          const result: TaskResult = {
            id: task.id,
            group: task.group,
            method: cfg.method,
            meta: task.meta,
            ...r,
            parsed: s.parsed,
            score: s.score,
            extra: s.extra,
            wallMs: Date.now() - started,
            usage: usage.byRole(),
            total: usage.total(),
            folds,
            llmQueryCalls,
          };
          results.push(result);
          appendFileSync(resultsPath, `${JSON.stringify(result)}\n`);
          done++;
          log(
            `[${done}/${tasks.length}] ${task.id} score=${result.score.toFixed(3)} out=${JSON.stringify((r.output ?? '').slice(0, 80))} ` +
              `steps=${r.steps} ${r.terminated} tokens=${result.total.promptTokens}/${result.total.completionTokens} cache=${(result.total.cacheHitRate * 100).toFixed(1)}%` +
              (r.error ? ` error=${r.error.slice(0, 200)}` : ''),
          );
        }),
      ),
    );
  }),
);
  return results;
}

export interface SummaryPrices {
  root?: TokenPrice;
  query?: TokenPrice;
}

export function summarize(results: TaskResult[], extra: Record<string, unknown> = {}, prices: SummaryPrices = {}) {
  const n = results.length;
  const mean = (f: (r: TaskResult) => number, rs: TaskResult[] = results) =>
    rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : 0;
  const sum = (f: (r: TaskResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const byKey = (key: string) => {
    const m: Record<string, { n: number; score: number }> = {};
    for (const r of results) {
      const k = String(r.meta[key] ?? '?');
      m[k] ??= { n: 0, score: 0 };
      m[k].n++;
      m[k].score += r.score;
    }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { n: v.n, score: v.score / v.n }]));
  };
  const roles: Record<string, UsageBucket & { cacheHitRate: number }> = {};
  for (const r of results) {
    for (const [role, u] of Object.entries(r.usage)) {
      const b = (roles[role] ??= { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, reasoningTokens: 0, latencyMs: 0, errors: 0, cacheHitRate: 0 });
      b.calls += u.calls;
      b.promptTokens += u.promptTokens;
      b.completionTokens += u.completionTokens;
      b.cachedTokens += u.cachedTokens;
      b.reasoningTokens += u.reasoningTokens;
      b.latencyMs += u.latencyMs;
      b.errors += u.errors;
    }
  }
  for (const b of Object.values(roles)) b.cacheHitRate = b.promptTokens ? b.cachedTokens / b.promptTokens : 0;
  const usd = (x: number) => Math.round(x * 1e6) / 1e6;
  const byRoleUsd: Record<string, number> = {};
  let totalUsd = 0;
  let cacheSavedUsd = 0;
  for (const [role, b] of Object.entries(roles)) {
    const price = role === 'llm_query' ? prices.query : prices.root;
    if (!price) continue;
    byRoleUsd[role] = usd(costOf(price, b));
    totalUsd += costOf(price, b);
    cacheSavedUsd += cacheSaved(price, b);
  }
  const cost = Object.keys(byRoleUsd).length
    ? { totalUsd: usd(totalUsd), perTaskUsd: n ? usd(totalUsd / n) : 0, cacheSavedUsd: usd(cacheSavedUsd), byRoleUsd }
    : undefined;
  const promptTokens = sum((r) => r.total.promptTokens);
  const cachedTokens = sum((r) => r.total.cachedTokens);
  return {
    ...extra,
    n,
    meanScore: mean((r) => r.score),
    correct: results.filter((r) => r.score >= 1).length,
    meanOfficial: mean((r) => r.extra?.official ?? r.score),
    meanLenient: mean((r) => r.extra?.lenient ?? r.score),
    errors: results.filter((r) => r.terminated === 'error' || r.terminated === 'context_overflow').length,
    filtered: results.filter((r) => r.terminated === 'filtered').length,
    meanScoreAnswered: mean((r) => r.score, results.filter((r) => r.terminated !== 'error' && r.terminated !== 'filtered')),
    meanSteps: mean((r) => r.steps),
    meanWallSec: mean((r) => r.wallMs) / 1000,
    formatIssues: sum((r) => r.formatIssues),
    folds: { granular: sum((r) => r.folds.granular), deep: sum((r) => r.folds.deep), corrected: sum((r) => r.folds.corrected) },
    llmQueryCalls: sum((r) => r.llmQueryCalls),
    tokens: { prompt: promptTokens, cached: cachedTokens, completion: sum((r) => r.total.completionTokens), cacheHitRate: promptTokens ? cachedTokens / promptTokens : 0 },
    byRole: roles,
    byTask: byKey('task'),
    byAnswerType: byKey('answer_type'),
    cost,
  };
}

export function writeSummary(outDir: string, summary: ReturnType<typeof summarize>): string {
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const md = [
    `# Benchmark summary`,
    '',
    '| metric | value |',
    '|---|---|',
    `| tasks | ${summary.n} |`,
    `| mean score (primary) | **${summary.meanScore.toFixed(4)}** |`,
    `| correct (score = 1) | **${summary.correct}/${summary.n}** |`,
    `| mean score (official OOLONG) | ${summary.meanOfficial.toFixed(4)} |`,
    `| mean score (lenient) | ${summary.meanLenient.toFixed(4)} |`,
    `| errors / overflow | ${summary.errors} |`,
    `| content-filtered | ${summary.filtered} |`,
    `| mean score (excluding errors) | ${summary.meanScoreAnswered.toFixed(4)} |`,
    `| mean steps | ${summary.meanSteps.toFixed(1)} |`,
    `| mean wall time | ${summary.meanWallSec.toFixed(1)} s |`,
    `| format issues | ${summary.formatIssues} |`,
    `| folds granular / deep / corrected | ${summary.folds.granular} / ${summary.folds.deep} / ${summary.folds.corrected} |`,
    `| llm_query calls | ${summary.llmQueryCalls} |`,
    `| prompt / cached / completion tokens | ${summary.tokens.prompt} / ${summary.tokens.cached} / ${summary.tokens.completion} |`,
    `| cache hit rate | ${pct(summary.tokens.cacheHitRate)} |`,
    ...(summary.cost
      ? [
          `| cost (list price, USD) | **$${summary.cost.totalUsd.toFixed(4)}** |`,
          `| cost per task | $${summary.cost.perTaskUsd.toFixed(4)} |`,
          `| cache saved | $${summary.cost.cacheSavedUsd.toFixed(4)} |`,
        ]
      : []),
    '',
    '## By role',
    '',
    '| role | calls | prompt | cached | hit rate | completion | errors |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(summary.byRole).map(([k, b]) =>
      `| ${k} | ${b.calls} | ${b.promptTokens} | ${b.cachedTokens} | ${pct(b.cacheHitRate)} | ${b.completionTokens} | ${b.errors} |`,
    ),
    '',
    '## By task',
    '',
    '| task | n | score |',
    '|---|---|---|',
    ...Object.entries(summary.byTask).map(([k, v]) => `| ${k} | ${v.n} | ${v.score.toFixed(3)} |`),
    '',
  ].join('\n');
  writeFileSync(join(outDir, 'summary.md'), md);
  return md;
}
