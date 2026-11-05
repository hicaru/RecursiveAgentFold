import {
  AgentFoldAgent,
  ContextStore,
  FoldState,
  LLMQueryEngine,
  RecursiveAgentFold,
  ScriptedLLM,
  UsageTracker,
  parseAgentResponse,
  type Tool,
} from '@raf/engine';
import type { BenchModels } from './config.js';
import { buildNeedleTasks } from './needle/needle.js';
import { runTasks, summarize } from './runner.js';
import { join } from 'node:path';

type ToolArgs = Record<string, unknown>;

interface ProbeDoc {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

interface ToolProbe {
  readonly tool: string;
  readonly question: string;
  readonly docs: readonly ProbeDoc[];
  readonly checkArgs?: (args: ToolArgs) => string | undefined;
  readonly checkObservation?: (observation: string) => string | undefined;
}

const isText = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;
const isNumberish = (v: unknown): boolean =>
  typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

function numbered(n: number, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i)).join('\n');
}

function corpusText(): string {
  const out = Array.from({ length: 240 }, (_, i) => `项目记录 ${i + 1}：例行维护与巡检，未发现异常。`);
  const notes = [
    'Personnel note: Alva Lindqvist transferred to the Lisbon office; badge number 4812.',
    'Personnel note: Chen Wei transferred to the Osaka office; badge number 7350.',
    'Personnel note: Priya Nair transferred to the Nairobi office; badge number 2641.',
  ];
  for (let i = 0; i < notes.length; i++) out[40 + i * 70] = notes[i] ?? '';
  return out.join('\n');
}

function logText(): string {
  const out = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 行：例行巡检记录，状态正常。`);
  out[2] = '第 3 行：灯塔的透镜需要更换';
  out[5] = '第 6 行：老灯塔的台阶出现裂缝';
  return out.join('\n');
}

function readText(): string {
  return numbered(8, (i) => `L${i + 1}-${['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'][i] ?? 'x'}`);
}

function usersText(): string {
  return ['User: 1 || alpha', 'User: 2 || beta', 'User: 1 || gamma', 'User: 1 || delta', 'User: 2 || epsilon', 'User: 3 || zeta'].join('\n');
}

function countText(): string {
  return numbered(100, (i) => `row ${i + 1} ${i % 2 === 0 ? 'cat' : 'dog'}`);
}

function ticketsText(): string {
  const kinds = ['客户投诉包裹延迟三天，要求赔偿。', '客户咨询如何修改账户密码。', '客户建议增加周末配送时段。'];
  return numbered(1200, (i) => `工单 ${i + 1}：${kinds[i % kinds.length] ?? ''}`);
}

const PROBES: readonly ToolProbe[] = Object.freeze([
  {
    tool: 'llm_query',
    question: '文档 tickets 有 1200 条工单，分布在全文。请用长文阅读器扫描全部分块，按语义把每条工单分为「配送」「账户」「建议」三类，并统计每类数量。不要用关键词计数。',
    docs: [{ id: 'tickets', title: '客服工单（约 1200 条）', text: ticketsText() }],
    checkArgs: (a) => {
      if (!isText(a.query)) return 'query must be a non-empty string';
      return a.mode === 'extract' ? undefined : 'mode must be "extract" for semantic counting';
    },
    checkObservation: (o) => {
      if (!o.includes('"counts" 已汇总')) return 'reader returned no summed counts';
      const tail = /"counts" 已汇总[^：]*：(.+)/.exec(o)?.[1] ?? '';
      const total = [...tail.matchAll(/=(\d+)/g)].reduce((a, m) => a + Number(m[1]), 0);
      return total === 1200 ? undefined : `summed counts total ${total}, expected 1200`;
    },
  },
  {
    tool: 'grep',
    question: '文档 log 有 60 行。用正则搜索「灯塔」，列出所有匹配行的行号和原文。',
    docs: [{ id: 'log', title: '巡检日志', text: logText() }],
    checkArgs: (a) => (isText(a.pattern) ? undefined : 'pattern must be a non-empty string'),
    checkObservation: (o) => (o.includes('行匹配') ? undefined : 'grep report missing match count'),
  },
  {
    tool: 'read',
    question: '读取文档 doc 的第 3 行到第 5 行。',
    docs: [{ id: 'doc', title: '行号样例', text: readText() }],
    checkArgs: (a) =>
      isText(a.document) ? (isNumberish(a.start_line) && isNumberish(a.end_line) ? undefined : 'start_line/end_line must be numbers') : 'document must be a string',
    checkObservation: (o) => (o.includes('L4-delta') ? undefined : 'read did not return lines 3-5'),
  },
  {
    tool: 'tally',
    question: '在文档 users 中精确统计每个 "User: <id>" 的出现次数，按次数从高到低。',
    docs: [{ id: 'users', title: '用户事件', text: usersText() }],
    checkArgs: (a) => (isText(a.pattern) ? undefined : 'pattern must be a non-empty string'),
    checkObservation: (o) => (o.includes('6 个匹配') && o.includes('3 个不同值') ? undefined : 'tally counts are wrong'),
  },
  {
    tool: 'calculator',
    question: '计算 (1234 * 56 + 78) / 2 的精确值。',
    docs: [],
    checkArgs: (a) => (isText(a.expression) ? undefined : 'expression must be a non-empty string'),
    checkObservation: (o) => (o.includes('34591') ? undefined : 'calculator result is wrong'),
  },
  {
    tool: 'branch',
    question: '把独立子任务「统计文档 count 中 cat 和 dog 各有多少行」交给一个全新上下文的子代理，只返回它的结果。',
    docs: [{ id: 'count', title: '类别行', text: countText() }],
    checkArgs: (a) => (isText(a.task) ? undefined : 'task must be a non-empty string'),
    checkObservation: (o) => (o.includes('branch 完成') && o.includes('子代理完成') ? undefined : 'branch result missing'),
  },
]);

function buildTools(store: ContextStore, models: BenchModels, usage: UsageTracker): Tool[] {
  const stub = new ScriptedLLM(() => '<answer>子代理完成：cat 50，dog 50</answer>', { name: 'branch-stub', contextWindow: 32_000, maxOutputTokens: 512 });
  const raf = new RecursiveAgentFold({
    rootLLM: models.root,
    branchLLM: stub,
    queryLLM: models.query,
    store,
    llmQuery: { ...models.llmQuery, maxChunkTokens: 8192 },
    maxDepth: 1,
    enable: { llm_query: true, branch: true, grep: true, tally: true, read: true, calculator: true },
    usage,
  });
  return raf.toolsFor(0);
}

function validateRequired(tool: Tool, args: ToolArgs): string | undefined {
  const required = tool.parameters.required;
  if (!Array.isArray(required)) return undefined;
  for (const key of required) {
    if (args[key] === undefined || args[key] === null || args[key] === '') return `missing required argument "${key}"`;
  }
  return undefined;
}

async function runToolProbe(probe: ToolProbe, models: BenchModels, log: (s: string) => void): Promise<boolean> {
  const store = new ContextStore();
  for (const d of probe.docs) store.add(d.text, { id: d.id, title: d.title });
  const usage = new UsageTracker();
  const tools = buildTools(store, models, usage);
  const tool = tools.find((t) => t.name === probe.tool);
  if (!tool) {
    log(`  ✗ ${probe.tool} — tool not available in the runtime`);
    return false;
  }
  const agent = new AgentFoldAgent({ llm: models.root, tools, store, maxSteps: 1 });
  const res = await models.root.complete({ messages: agent.buildMessages(probe.question, new FoldState()), temperature: 0 });
  const parsed = parseAgentResponse(res.text, { expectFolding: false, reasoning: res.reasoning });
  const issues: string[] = [];
  if (parsed.errors.length) issues.push(`format: ${parsed.errors.join('; ')}`);
  if (parsed.folding !== undefined) issues.push('emitted <folding> at step 0');
  const call = parsed.toolCall;
  let detail = '';
  if (!call) issues.push(`no tool call (chose <answer>)`);
  else {
    if (call.name !== probe.tool) issues.push(`chose "${call.name}", expected "${probe.tool}"`);
    const badArgs = validateRequired(tool, call.arguments) ?? probe.checkArgs?.(call.arguments);
    if (badArgs) issues.push(`arguments: ${badArgs}`);
  }
  if (call && call.name === probe.tool && issues.length === 0) {
    try {
      const observation = await tool.execute(call.arguments, {
        store,
        usage,
        depth: 0,
        agentName: 'probe',
        step: 0,
        emit: () => {},
      });
      const badObs = probe.checkObservation?.(observation);
      if (badObs) issues.push(`observation: ${badObs}`);
      else detail = observation.split('\n')[0]?.slice(0, 140) ?? '';
    } catch (e) {
      issues.push(`execution: ${(e as Error).message}`);
    }
  }
  if (issues.length) {
    const raw = parsed.errors.length ? ` | raw: ${res.text.slice(0, 300).replace(/\s+/g, ' ')}` : '';
    log(`  ✗ ${probe.tool} — ${issues.join('; ')}${raw}`);
    return false;
  }
  log(`  ✓ ${probe.tool} — args ${JSON.stringify(call?.arguments ?? {}).slice(0, 160)}; ${detail}; ${res.latencyMs} ms, prompt ${res.usage.promptTokens} tok`);
  return true;
}

async function foldingProbe(models: BenchModels, log: (s: string) => void): Promise<boolean> {
  const store = new ContextStore();
  store.add('alpha\nbeta\ngamma', { id: 'doc', title: '三行样例' });
  const usage = new UsageTracker();
  const tools = buildTools(store, models, usage);
  const agent = new AgentFoldAgent({ llm: models.root, tools, store, maxSteps: 1 });
  const state = new FoldState();
  state.setLatest({
    step: 0,
    motivation: 'grep 找到 beta。',
    action: { name: 'grep', arguments: { pattern: 'beta' } },
    observation: 'grep /beta/：1 行匹配 — doc: 1\ndoc:2| beta',
  });
  const res = await models.root.complete({ messages: agent.buildMessages('beta 在第几行？请再读取该行确认。', state), temperature: 0 });
  const parsed = parseAgentResponse(res.text, { expectFolding: true, reasoning: res.reasoning });
  const issues: string[] = [...parsed.errors];
  if (!parsed.folding) issues.push('missing <folding>');
  else if (parsed.folding.range[1] !== 0) issues.push(`range end ${parsed.folding.range[1]} != 0`);
  if (!parsed.motivation) issues.push('missing <motivation>');
  if (!parsed.toolCall && parsed.answer === undefined) issues.push('neither <tool_call> nor <answer>');
  if (issues.length) {
    log(`  ✗ folding — ${issues.join('; ')} | raw: ${res.text.slice(0, 300).replace(/\s+/g, ' ')}`);
    return false;
  }
  log(`  ✓ folding — range ${JSON.stringify(parsed.folding?.range)}, summary ${parsed.folding?.summary.length ?? 0} chars, ${parsed.toolCall ? `tool ${parsed.toolCall.name}` : 'answer'}`);
  return true;
}

async function readerProbe(models: BenchModels, log: (s: string) => void): Promise<boolean> {
  const store = new ContextStore();
  store.add(corpusText(), { id: 'corpus', title: '项目记录' });
  store.add(numbered(120, (i) => `row ${i + 1} ${i % 2 === 0 ? 'cat' : 'dog'}`), { id: 'rows', title: '类别行' });
  const usage = new UsageTracker();
  const engine = new LLMQueryEngine(models.query, store, usage, {
    ...models.llmQuery,
    maxChunkTokens: 2048,
    minChunkTokens: 1024,
    memoize: false,
  });
  const locate = await engine.query({
    query: '找出所有人事备注里的姓名和工牌号，返回姓名与工牌号。',
    mode: 'locate',
    documents: ['corpus'],
  });
  const locateErrors = locate.findings.filter((f) => f.error);
  const relevant = locate.findings.filter((f) => f.relevant && !f.error);
  const evidence = relevant.some((f) => f.evidence.some((e) => typeof e.line === 'number'));
  const locateOk = locate.findings.length > 0 && locateErrors.length === 0 && relevant.length > 0 && evidence;
  log(
    `  ${locateOk ? '✓' : '✗'} locate — ${locate.findings.length} chunk(s), relevant ${relevant.length}, errors ${locateErrors.length}, evidence lines ${evidence ? 'ok' : 'missing'}`,
  );
  const extract = await engine.query({
    query: '统计本块中 cat 和 dog 的行数，按类别放进 counts。',
    mode: 'extract',
    documents: ['rows'],
  });
  const totals: Record<string, number> = {};
  for (const f of extract.findings) for (const [k, v] of Object.entries(f.counts ?? {})) totals[k] = (totals[k] ?? 0) + v;
  const extractErrors = extract.findings.filter((f) => f.error).length;
  const catDog = (totals.cat ?? 0) + (totals.dog ?? 0);
  const extractOk = extractErrors === 0 && (totals.cat ?? 0) > 0 && (totals.dog ?? 0) > 0 && catDog === 120;
  log(
    `  ${extractOk ? '✓' : '✗'} extract — ${extract.findings.length} chunk(s), counts ${JSON.stringify(totals)} (expected 120 lines), errors ${extractErrors}`,
  );
  return locateOk && extractOk;
}

async function e2eProbe(models: BenchModels, outDir: string, log: (s: string) => void): Promise<boolean> {
  const tasks = buildNeedleTasks({ tokens: 8000, tasks: 1, seed: 11, facts: 6 });
  const results = await runTasks(tasks, {
    method: 'raf',
    root: models.root,
    query: models.query,
    llmQuery: { ...models.llmQuery, maxChunkTokens: 8192 },
    rootMaxSteps: 8,
    outDir: join(outDir, 'e2e'),
    log,
  });
  const s = summarize(results);
  const ok = s.n === 1 && s.errors === 0 && s.filtered === 0 && s.meanScore > 0;
  log(
    `  ${ok ? '✓' : '✗'} e2e — score ${s.meanScore.toFixed(3)}, steps ${s.meanSteps.toFixed(1)}, format issues ${s.formatIssues}, cache ${(s.tokens.cacheHitRate * 100).toFixed(1)}%`,
  );
  return ok;
}

/**
 * Live checks of the Chinese prompts against the configured models:
 *  1. reachability of root + query models
 *  2. one probe per tool: the root model must choose it and pass valid arguments
 *  3. folding format on a synthetic step-1 state
 *  4. llm_query reader JSON contract (locate + extract/counts)
 *  5. tiny end-to-end run (folding + answer in the real loop)
 */
export async function promptCheck(
  models: BenchModels,
  outDir: string,
  log: (s: string) => void = console.log,
  only?: string,
): Promise<boolean> {
  log('1) model reachability');
  const okRoot = await ping(models.root, 'root', log);
  const okQuery = await ping(models.query, 'query', log);
  if (!okRoot || !okQuery) {
    log('Aborting: fix model access first (see errors above).');
    return false;
  }

  const known = new Set<string>([...PROBES.map((p) => p.tool), 'folding', 'reader', 'e2e']);
  if (only !== undefined && !known.has(only)) {
    log(`  ✗ unknown --only "${only}"; use one of: ${[...known].join(', ')}`);
    return false;
  }
  let pass = true;
  const wanted = (name: string) => only === undefined || only === name;

  log('2) per-tool prompt probes');
  for (const probe of PROBES) {
    if (!wanted(probe.tool)) continue;
    try {
      pass = (await runToolProbe(probe, models, log)) && pass;
    } catch (e) {
      log(`  ✗ ${probe.tool} — ${(e as Error).message}`);
      pass = false;
    }
  }

  if (wanted('folding')) {
    log('3) folding format');
    try {
      pass = (await foldingProbe(models, log)) && pass;
    } catch (e) {
      log(`  ✗ folding — ${(e as Error).message}`);
      pass = false;
    }
  }

  if (wanted('reader')) {
    log('4) llm_query reader contract');
    try {
      pass = (await readerProbe(models, log)) && pass;
    } catch (e) {
      log(`  ✗ reader — ${(e as Error).message}`);
      pass = false;
    }
  }

  if (wanted('e2e')) {
    log('5) end-to-end');
    try {
      pass = (await e2eProbe(models, outDir, log)) && pass;
    } catch (e) {
      log(`  ✗ e2e — ${(e as Error).message}`);
      pass = false;
    }
  }

  log(
    pass
      ? only === undefined
        ? 'PASS: all prompt checks passed; every default tool is callable.'
        : `PASS: ${only} check passed.`
      : 'FAIL: see the checks above.',
  );
  return pass;
}

async function ping(llm: BenchModels['root'], label: string, log: (s: string) => void): Promise<boolean> {
  try {
    const r = await llm.complete({ messages: [{ role: 'user', content: '只回复两个字母：OK' }], maxTokens: 512 });
    log(`  ✓ ${label} (${llm.profile.name}) → ${JSON.stringify(r.text.trim().slice(0, 40))} usage=${JSON.stringify(r.usage)} ${r.latencyMs}ms`);
    return true;
  } catch (e) {
    log(`  ✗ ${label} (${llm.profile.name}) → ${(e as Error).message}`);
    return false;
  }
}
