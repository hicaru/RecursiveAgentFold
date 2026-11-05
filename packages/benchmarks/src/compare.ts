import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { costOf, priceFor, type TokenPrice } from './pricing.js';
import type { TaskResult } from './runner.js';

interface RunData {
  readonly dir: string;
  readonly rows: readonly TaskResult[];
  readonly prices: { readonly root?: TokenPrice; readonly query?: TokenPrice };
}

interface Aggregate {
  readonly n: number;
  readonly meanScore: number;
  readonly correct: number;
  readonly filtered: number;
  readonly meanSteps: number;
  readonly formatIssues: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly completionTokens: number;
  readonly cacheHitRate: number;
  readonly cost?: number;
}

function readRun(dir: string): RunData {
  const abs = resolve(dir);
  const resultsPath = join(abs, 'results.jsonl');
  if (!existsSync(resultsPath)) throw new Error(`missing ${resultsPath}`);
  const rows = readFileSync(resultsPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as TaskResult);
  let rootPrice: TokenPrice | undefined;
  let queryPrice: TokenPrice | undefined;
  const configPath = join(abs, 'config.json');
  if (existsSync(configPath)) {
    const cfg = JSON.parse(readFileSync(configPath, 'utf8')) as {
      models?: { root?: { model?: string }; query?: { model?: string } };
    };
    const rootModel = cfg.models?.root?.model;
    if (rootModel) rootPrice = priceFor(rootModel);
    const queryModel = cfg.models?.query?.model;
    if (queryModel) queryPrice = priceFor(queryModel);
  }
  return {
    dir: abs,
    rows,
    prices: {
      ...(rootPrice ? { root: rootPrice } : {}),
      ...(queryPrice ? { query: queryPrice } : {}),
    },
  };
}

function summarize(rows: readonly TaskResult[], prices: RunData['prices']): Aggregate {
  const n = rows.length;
  let score = 0;
  let correct = 0;
  let filtered = 0;
  let steps = 0;
  let formatIssues = 0;
  let promptTokens = 0;
  let cachedTokens = 0;
  let completionTokens = 0;
  for (const r of rows) {
    score += r.score;
    if (r.score >= 1) correct++;
    if (r.terminated === 'filtered') filtered++;
    steps += r.steps;
    formatIssues += r.formatIssues;
    promptTokens += r.total.promptTokens;
    cachedTokens += r.total.cachedTokens;
    completionTokens += r.total.completionTokens;
  }
  const cacheHitRate = promptTokens > 0 ? cachedTokens / promptTokens : 0;
  let cost: number | undefined;
  if (prices.root || prices.query) {
    let totalCost = 0;
    for (const r of rows) {
      if (r.usage) {
        for (const [role, bucket] of Object.entries(r.usage)) {
          const rolePrice = role === 'llm_query' ? (prices.query ?? prices.root) : prices.root;
          if (rolePrice) totalCost += costOf(rolePrice, bucket);
        }
      } else {
        const rolePrice = prices.root ?? prices.query;
        if (rolePrice) totalCost += costOf(rolePrice, r.total);
      }
    }
    cost = totalCost;
  }
  return {
    n,
    meanScore: n > 0 ? score / n : 0,
    correct,
    filtered,
    meanSteps: n > 0 ? steps / n : 0,
    formatIssues,
    promptTokens,
    cachedTokens,
    completionTokens,
    cacheHitRate,
    ...(cost !== undefined ? { cost } : {}),
  };
}

function pick(byId: ReadonlyMap<string, TaskResult>, ids: readonly string[]): TaskResult[] {
  const out: TaskResult[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) out.push(row);
  }
  return out;
}

function shortId(id: string): string {
  const oolong = /-(\d{8})$/.exec(id);
  if (oolong?.[1] !== undefined) return oolong[1];
  return id.length > 32 ? `…${id.slice(-31)}` : id;
}

function formatIds(ids: readonly string[]): string {
  if (ids.length === 0) return '(none)';
  const head = ids.slice(0, 10).join(', ');
  return ids.length > 10 ? `${ids.length} task(s): ${head}, …` : head;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function formatAggregate(label: string, a: Aggregate): string {
  const cost = a.cost !== undefined ? ` cost=$${a.cost.toFixed(4)}` : '';
  return (
    `${label.padEnd(10)} n=${String(a.n).padEnd(3)} mean=${a.meanScore.toFixed(4)} correct=${a.correct}/${a.n} ` +
    `filtered=${a.filtered} steps=${a.meanSteps.toFixed(2)} fmt=${a.formatIssues} cache=${pct(a.cacheHitRate)} ` +
    `tokens=${a.promptTokens}/${a.cachedTokens}/${a.completionTokens}${cost}`
  );
}

/** Compare two benchmark result directories by task id. Pure: reads files, returns a report. */
export function compareRuns(oldDir: string, newDir: string): string {
  const a = readRun(oldDir);
  const b = readRun(newDir);
  const aById = new Map(a.rows.map((r) => [r.id, r] as const));
  const bById = new Map(b.rows.map((r) => [r.id, r] as const));
  const sharedIds = b.rows.map((r) => r.id).filter((id) => aById.has(id));
  const aShared = pick(aById, sharedIds);
  const bShared = pick(bById, sharedIds);
  const commonIds = sharedIds.filter(
    (id) => aById.get(id)?.terminated !== 'filtered' && bById.get(id)?.terminated !== 'filtered',
  );
  const aCommon = pick(aById, commonIds);
  const bCommon = pick(bById, commonIds);
  const onlyA = a.rows.filter((r) => !bById.has(r.id)).map((r) => shortId(r.id));
  const onlyB = b.rows.filter((r) => !aById.has(r.id)).map((r) => shortId(r.id));
  const filteredA = a.rows.filter((r) => r.terminated === 'filtered').map((r) => shortId(r.id));
  const filteredB = b.rows.filter((r) => r.terminated === 'filtered').map((r) => shortId(r.id));

  const lines: string[] = [];
  lines.push(`old: ${a.dir}`);
  lines.push(`new: ${b.dir}`);
  lines.push('');
  lines.push('## overall');
  lines.push(formatAggregate('old', summarize(a.rows, a.prices)));
  lines.push(formatAggregate('new', summarize(b.rows, b.prices)));
  lines.push('');
  lines.push(`## same task ids (${sharedIds.length})`);
  lines.push(formatAggregate('old', summarize(aShared, a.prices)));
  lines.push(formatAggregate('new', summarize(bShared, b.prices)));
  lines.push('');
  lines.push(`## common non-filtered (${commonIds.length})`);
  lines.push(formatAggregate('old', summarize(aCommon, a.prices)));
  lines.push(formatAggregate('new', summarize(bCommon, b.prices)));
  lines.push('');
  lines.push('## filtered');
  lines.push(`old: ${filteredA.join(', ') || '(none)'}`);
  lines.push(`new: ${filteredB.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('## only in one run');
  lines.push(`old: ${formatIds(onlyA)}`);
  lines.push(`new: ${formatIds(onlyB)}`);
  lines.push('');
  lines.push('## per task (same ids)');
  lines.push('task      old score/steps/term            new score/steps/term            delta   fmt');
  for (const id of sharedIds) {
    const ra = aById.get(id);
    const rb = bById.get(id);
    if (!ra || !rb) continue;
    const delta = rb.score - ra.score;
    const sign = delta > 0 ? '+' : '';
    lines.push(
      `${shortId(id).padEnd(9)} ${`${ra.score.toFixed(3)}/${ra.steps}/${ra.terminated}`.padEnd(30)} ` +
        `${`${rb.score.toFixed(3)}/${rb.steps}/${rb.terminated}`.padEnd(30)} ${sign}${delta.toFixed(3)}  ` +
        `${ra.formatIssues}->${rb.formatIssues}`,
    );
  }
  return lines.join('\n');
}
