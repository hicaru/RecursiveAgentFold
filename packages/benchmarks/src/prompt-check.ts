import { ContextStore, LLMQueryEngine, UsageTracker, type LLMClient } from '@raf/engine';
import type { BenchModels } from './config.js';
import { buildNeedleTasks } from './needle/needle.js';
import { runTasks, summarize } from './runner.js';
import { join } from 'node:path';

async function ping(llm: LLMClient, label: string, log: (s: string) => void): Promise<boolean> {
  try {
    const r = await llm.complete({ messages: [{ role: 'user', content: 'Reply with exactly: OK' }], maxTokens: 512 });
    log(`  ✓ ${label} (${llm.profile.name}) → ${JSON.stringify(r.text.trim().slice(0, 40))} reasoning=${r.reasoning ? `${r.reasoning.length} chars` : 'none'} usage=${JSON.stringify(r.usage)} ${r.latencyMs}ms`);
    return true;
  } catch (e) {
    log(`  ✗ ${label} (${llm.profile.name}) → ${(e as Error).message}`);
    return false;
  }
}

/**
 * Live checks of the prompts against the configured models:
 *  1. reachability of root + query models
 *  2. llm_query JSON contract on a small numbered document
 *  3. a tiny end-to-end Recursive AgentFold run (format compliance, folding, cache)
 */
export async function promptCheck(models: BenchModels, outDir: string, log: (s: string) => void = console.log): Promise<boolean> {
  log('1) model reachability');
  const okRoot = await ping(models.root, 'root', log);
  const okQuery = await ping(models.query, 'query', log);
  if (!okRoot || !okQuery) {
    log('Aborting: fix model access first (see errors above).');
    return false;
  }

  log('2) llm_query contract');
  const store = new ContextStore();
  const [task] = buildNeedleTasks({ tokens: 6000, tasks: 1, seed: 7, facts: 3 });
  store.add(task!.documents[0]!.text, { id: 'haystack', title: 'probe' });
  const usage = new UsageTracker();
  const engine = new LLMQueryEngine(models.query, store, usage, { ...models.llmQuery, maxChunkTokens: 2048, minChunkTokens: 1024 });
  const q = await engine.query({ query: 'Find every personnel note (transfer + badge number). Report the names and badge numbers.', mode: 'locate' });
  const parsedOk = q.findings.filter((f) => !f.error && (f.relevant ? f.answer.length > 0 : true)).length;
  log(q.report);
  log(`  → ${parsedOk}/${q.findings.length} chunk responses usable; usage ${JSON.stringify(usage.byRole().llm_query)}`);
  const q2 = await engine.query({ query: 'Does this chunk mention a lighthouse? Answer yes/no in "answer".', mode: 'extract' });
  const u = usage.byRole().llm_query!;
  log(`  → second query over same chunks: ${q2.findings.length} calls; cumulative cache hit rate ${(u.cacheHitRate * 100).toFixed(1)}%`);

  log('3) end-to-end Recursive AgentFold (needle 30K tokens, lookup + count)');
  const tasks = buildNeedleTasks({ tokens: 30_000, tasks: 2, seed: 11, facts: 10 });
  const results = await runTasks(tasks, {
    method: 'raf',
    root: models.root,
    query: models.query,
    llmQuery: { ...models.llmQuery, maxChunkTokens: 8192 },
    rootMaxSteps: 12,
    outDir: join(outDir, 'e2e'),
    log,
  });
  const s = summarize(results);
  log(`  → mean score ${s.meanScore.toFixed(3)}, format issues ${s.formatIssues}, folds ${JSON.stringify(s.folds)}, cache hit ${(s.tokens.cacheHitRate * 100).toFixed(1)}%`);
  return true;
}
