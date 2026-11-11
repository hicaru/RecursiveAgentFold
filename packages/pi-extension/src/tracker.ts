import type { AgentEvent } from '@raf/engine/source';

/** Usage roles that RAF reports separately. */
export const ROLES = Object.freeze(['root', 'branch', 'llm_query'] as const);
export type Role = (typeof ROLES)[number];

export interface RoleStats {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
}

export type AgentStatus = 'running' | 'done' | 'failed';

/** One line in an agent's step log. */
export interface LogLine {
  readonly step: number;
  readonly kind: 'tool' | 'result' | 'fold' | 'answer' | 'error' | 'query' | 'report' | 'format';
  readonly text: string;
}

/** JSON view of one agent for renderers and tool details. */
export interface AgentSnapshot {
  readonly name: string;
  readonly depth: number;
  readonly parent?: string;
  readonly scope?: string;
  readonly task: string;
  readonly status: AgentStatus;
  readonly step: number;
  readonly steps: number;
  readonly contextTokens: number;
  readonly blocks: number;
  readonly action?: string;
  readonly folds: number;
  readonly deepFolds: number;
  readonly promptTokens: number;
  readonly cachedTokens: number;
  readonly completionTokens: number;
  readonly calls: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly terminated?: string;
  readonly answer?: string;
  readonly log: readonly LogLine[];
}

/** JSON view of one llm_query scan. */
export interface QuerySnapshot {
  readonly agent: string;
  readonly query: string;
  readonly mode: string;
  readonly chunks: number;
  readonly relevant: number;
  readonly errors: number;
  readonly memoHits: number;
  readonly chunkTokens: number;
  readonly calls: number;
}

/** Live state of one root tool call: the sub-agents and scans it started. */
export interface CallSnapshot {
  readonly tool: string;
  readonly agents: readonly AgentSnapshot[];
  readonly queries: readonly QuerySnapshot[];
  readonly readerDone: number;
  readonly readerActive: number;
  readonly startedAt: number;
  readonly endedAt?: number;
}

/** Aggregated counters for one run or for the whole session. */
export interface RunTotals {
  steps: number;
  folds: number;
  deepFolds: number;
  formatErrors: number;
  budgetCondensations: number;
  reports: number;
  queries: number;
  queryChunks: number;
  agents: number;
  errors: number;
  roles: Record<Role, RoleStats>;
}

const MAX_LOG = 60;
const MAX_TEXT = 240;

function emptyRole(): RoleStats {
  return { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 };
}

/** Empty totals. */
export function emptyTotals(): RunTotals {
  return {
    steps: 0,
    folds: 0,
    deepFolds: 0,
    formatErrors: 0,
    budgetCondensations: 0,
    reports: 0,
    queries: 0,
    queryChunks: 0,
    agents: 0,
    errors: 0,
    roles: { root: emptyRole(), branch: emptyRole(), llm_query: emptyRole() },
  };
}

/** Add totals b into totals a. */
export function mergeTotals(a: RunTotals, b: RunTotals): void {
  a.steps += b.steps;
  a.folds += b.folds;
  a.deepFolds += b.deepFolds;
  a.formatErrors += b.formatErrors;
  a.budgetCondensations += b.budgetCondensations;
  a.reports += b.reports;
  a.queries += b.queries;
  a.queryChunks += b.queryChunks;
  a.agents += b.agents;
  a.errors += b.errors;
  for (const role of ROLES) {
    const x = a.roles[role];
    const y = b.roles[role];
    x.calls += y.calls;
    x.promptTokens += y.promptTokens;
    x.cachedTokens += y.cachedTokens;
    x.completionTokens += y.completionTokens;
    x.costUsd += y.costUsd;
  }
}

/** Cache hit rate of a role set, 0..1. Undefined when no prompt tokens were seen. */
export function cacheRate(stats: readonly RoleStats[]): number | undefined {
  let prompt = 0;
  let cached = 0;
  for (const s of stats) {
    prompt += s.promptTokens;
    cached += s.cachedTokens;
  }
  return prompt > 0 ? cached / prompt : undefined;
}

/** Collapse whitespace and cut a string for one display line. */
export function oneLine(text: string, max = MAX_TEXT): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Short preview of tool arguments: the first string-valued argument. */
export function argPreview(args: Readonly<Record<string, unknown>>): string {
  for (const key of ['pattern', 'query', 'document', 'file_path', 'path', 'command', 'expression', 'scope', 'task']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, 60);
  }
  if (Array.isArray(args.tasks)) return `${args.tasks.length} tasks`;
  return '';
}

interface AgentNode {
  name: string;
  depth: number;
  parent: string | undefined;
  scope: string | undefined;
  task: string;
  status: AgentStatus;
  step: number;
  steps: number;
  contextTokens: number;
  blocks: number;
  action: string | undefined;
  folds: number;
  deepFolds: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  calls: number;
  startedAt: number;
  endedAt: number | undefined;
  terminated: string | undefined;
  answer: string | undefined;
  callId: string | undefined;
  log: LogLine[];
}

interface CallState {
  readonly tool: string;
  readonly startedAt: number;
  endedAt: number | undefined;
  readerDone: number;
  readerActive: number;
  readonly queries: QuerySnapshot[];
}

/**
 * Folds the engine event stream into a live agent tree and run totals.
 * Root tool calls run one at a time, so every sub-agent that starts during a
 * call belongs to that call.
 */
export class RunTracker {
  private agents = new Map<string, AgentNode>();
  private calls = new Map<string, CallState>();
  private currentCall: string | undefined;
  private run: RunTotals = emptyTotals();
  private readonly session: RunTotals = emptyTotals();
  private runStartedAt = 0;
  private runEndedAt: number | undefined;
  private runActive = false;
  private readonly listeners = new Set<() => void>();
  private rateLimitedUntil = 0;

  /** Subscribe to changes. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /** Start a new run. The agent tree of the previous run is dropped. */
  startRun(now = Date.now()): void {
    this.agents = new Map();
    this.calls = new Map();
    this.currentCall = undefined;
    this.run = emptyTotals();
    this.runStartedAt = now;
    this.runEndedAt = undefined;
    this.runActive = true;
    this.changed();
  }

  /** End the run and add its totals to the session totals. */
  endRun(now = Date.now()): void {
    if (!this.runActive) return;
    this.runActive = false;
    this.runEndedAt = now;
    mergeTotals(this.session, this.run);
    this.changed();
  }

  /** Mark the root as waiting for a native model response. */
  rootRequest(): void {
    const root = this.agents.get('root');
    if (root !== undefined) root.action = 'thinking';
    this.changed();
  }

  /** Record native cost in USD for a role. */
  addCost(role: Role, usd: number): void {
    this.run.roles[role].costUsd += usd;
    this.changed();
  }

  /** Record a provider rate limit until the given time. */
  setRateLimit(until: number): void {
    this.rateLimitedUntil = until;
    this.changed();
  }

  /** Time in ms until the rate limit lifts, or 0. */
  rateLimitRemaining(now = Date.now()): number {
    return Math.max(0, this.rateLimitedUntil - now);
  }

  beginCall(callId: string, tool: string, now = Date.now()): void {
    this.currentCall = callId;
    this.calls.set(callId, { tool, startedAt: now, endedAt: undefined, readerDone: 0, readerActive: 0, queries: [] });
    this.changed();
  }

  endCall(callId: string, now = Date.now()): void {
    const call = this.calls.get(callId);
    if (call !== undefined) call.endedAt = now;
    if (this.currentCall === callId) this.currentCall = undefined;
    this.changed();
  }

  /** Count one reader (llm_query chunk) call that started. */
  readerStarted(): void {
    const call = this.currentCall === undefined ? undefined : this.calls.get(this.currentCall);
    if (call !== undefined) call.readerActive += 1;
    this.changed();
  }

  /** Count one reader call that ended. */
  readerEnded(): void {
    const call = this.currentCall === undefined ? undefined : this.calls.get(this.currentCall);
    if (call !== undefined) {
      call.readerActive = Math.max(0, call.readerActive - 1);
      call.readerDone += 1;
    }
    this.changed();
  }

  /** Apply one engine event. */
  apply(event: AgentEvent, now = Date.now()): void {
    switch (event.type) {
      case 'run_start': {
        const existing = this.agents.get(event.agent);
        const node: AgentNode = existing ?? {
          name: event.agent,
          depth: event.depth,
          parent: event.parent,
          scope: event.scope,
          task: '',
          status: 'running',
          step: 0,
          steps: 0,
          contextTokens: 0,
          blocks: 0,
          action: undefined,
          folds: 0,
          deepFolds: 0,
          promptTokens: 0,
          cachedTokens: 0,
          completionTokens: 0,
          calls: 0,
          startedAt: now,
          endedAt: undefined,
          terminated: undefined,
          answer: undefined,
          callId: event.depth > 0 ? this.currentCall : undefined,
          log: [],
        };
        node.task = oneLine(event.question, 400);
        node.status = 'running';
        node.endedAt = undefined;
        node.terminated = undefined;
        if (existing === undefined) {
          this.agents.set(event.agent, node);
          this.run.agents += 1;
        }
        if (event.isFollowUp === true) this.log(node, { step: node.step, kind: 'tool', text: `follow-up: ${oneLine(event.question, 120)}` });
        break;
      }
      case 'step_start': {
        if (event.depth === 0) this.run.steps += 1;
        const node = this.agents.get(event.agent);
        if (node === undefined) break;
        node.step = event.step;
        node.steps += 1;
        node.contextTokens = event.contextTokens;
        node.blocks = event.blocks;
        node.action = 'thinking';
        break;
      }
      case 'llm_call': {
        const node = this.agents.get(event.agent);
        if (node !== undefined) {
          node.calls += 1;
          node.promptTokens += event.usage.promptTokens;
          node.cachedTokens += event.usage.cachedTokens;
          node.completionTokens += event.usage.completionTokens;
        }
        const role: Role = event.role === 'root' ? 'root' : 'branch';
        const stats = this.run.roles[role];
        stats.calls += 1;
        stats.promptTokens += event.usage.promptTokens;
        stats.cachedTokens += event.usage.cachedTokens;
        stats.completionTokens += event.usage.completionTokens;
        break;
      }
      case 'format_error': {
        const node = this.agents.get(event.agent);
        this.run.formatErrors += 1;
        if (node !== undefined) this.log(node, { step: event.step, kind: 'format', text: oneLine(event.errors.join('; '), 160) });
        break;
      }
      case 'fold': {
        const node = this.agents.get(event.agent);
        const deep = event.outcome.kind === 'deep';
        this.run.folds += 1;
        if (deep) this.run.deepFolds += 1;
        if (node === undefined) break;
        node.folds += 1;
        if (deep) node.deepFolds += 1;
        const [from, to] = event.outcome.directive.range;
        this.log(node, {
          step: event.step,
          kind: 'fold',
          text: `${deep ? 'deep' : 'fold'} [${from}${from === to ? '' : `-${to}`}] ${oneLine(event.outcome.directive.summary, 160)}`,
        });
        break;
      }
      case 'tool_call': {
        const node = this.agents.get(event.agent);
        if (node === undefined) break;
        const preview = argPreview(event.action.arguments);
        node.action = preview === '' ? event.action.name : `${event.action.name} ${preview}`;
        this.log(node, { step: event.step, kind: 'tool', text: node.action });
        break;
      }
      case 'tool_result': {
        const node = this.agents.get(event.agent);
        if (node === undefined) break;
        node.action = undefined;
        const head = oneLine(event.observation.split('\n', 1)[0] ?? '', 120);
        this.log(node, {
          step: event.step,
          kind: event.error === undefined ? 'result' : 'error',
          text: `${event.name} → ${event.error === undefined ? head : oneLine(event.error, 120)} (${event.tokens} tok)`,
        });
        break;
      }
      case 'answer': {
        const node = this.agents.get(event.agent);
        if (node === undefined) break;
        node.answer = oneLine(event.answer, 400);
        this.log(node, { step: event.step, kind: 'answer', text: oneLine(event.answer, 160) });
        break;
      }
      case 'run_end': {
        const node = this.agents.get(event.agent);
        if (node === undefined) break;
        node.status = event.terminated === 'answer' || event.terminated === 'forced_answer' ? 'done' : 'failed';
        node.terminated = event.terminated;
        node.endedAt = now;
        node.action = undefined;
        break;
      }
      case 'branch_report': {
        this.run.reports += 1;
        const node = this.agents.get(event.agent);
        if (node !== undefined) this.log(node, { step: event.step, kind: 'report', text: `${event.scope} → ${event.reportId} (${event.lines} lines)` });
        break;
      }
      case 'llm_query': {
        this.run.queries += 1;
        this.run.queryChunks += event.chunks;
        const stats = this.run.roles.llm_query;
        stats.calls += event.calls ?? event.chunks - event.memoHits;
        stats.promptTokens += event.usage?.promptTokens ?? 0;
        stats.cachedTokens += event.usage?.cachedTokens ?? 0;
        stats.completionTokens += event.usage?.completionTokens ?? 0;
        const snapshot: QuerySnapshot = {
          agent: event.agent,
          query: oneLine(event.query, 200),
          mode: event.mode,
          chunks: event.chunks,
          relevant: event.relevant,
          errors: event.errors,
          memoHits: event.memoHits,
          chunkTokens: event.chunkTokens,
          calls: event.calls ?? 0,
        };
        const call = this.currentCall === undefined ? undefined : this.calls.get(this.currentCall);
        call?.queries.push(snapshot);
        const node = this.agents.get(event.agent);
        if (node !== undefined) {
          this.log(node, {
            step: event.step ?? node.step,
            kind: 'query',
            text: `llm_query ${event.mode}: ${event.relevant}/${event.chunks} relevant, ${event.memoHits} memo`,
          });
        }
        break;
      }
      case 'context_budget':
        this.run.budgetCondensations += 1;
        break;
      case 'error': {
        this.run.errors += 1;
        const node = this.agents.get(event.agent);
        if (node !== undefined) this.log(node, { step: event.step ?? node.step, kind: 'error', text: oneLine(event.message, 160) });
        break;
      }
      case 'llm_response':
        break;
    }
    this.changed();
  }

  private log(node: AgentNode, line: LogLine): void {
    node.log.push(line);
    if (node.log.length > MAX_LOG) node.log.splice(0, node.log.length - MAX_LOG);
  }

  get active(): boolean {
    return this.runActive;
  }

  get runStart(): number {
    return this.runStartedAt;
  }

  get runEnd(): number | undefined {
    return this.runEndedAt;
  }

  /** Totals of the current (or last) run. */
  runTotals(): RunTotals {
    return this.run;
  }

  /** Session totals including the active run. */
  sessionTotals(): RunTotals {
    const out = emptyTotals();
    mergeTotals(out, this.session);
    if (this.runActive) mergeTotals(out, this.run);
    return out;
  }

  /** Every agent of the run in depth-first order (root first). */
  agentTree(): AgentSnapshot[] {
    return this.ordered([...this.agents.values()]);
  }

  /** Snapshot of the sub-agents and scans of one root tool call. */
  callSnapshot(callId: string): CallSnapshot | undefined {
    const call = this.calls.get(callId);
    if (call === undefined) return undefined;
    const members = [...this.agents.values()].filter((node) => node.callId === callId);
    return {
      tool: call.tool,
      agents: this.ordered(members),
      queries: [...call.queries],
      readerDone: call.readerDone,
      readerActive: call.readerActive,
      startedAt: call.startedAt,
      ...(call.endedAt !== undefined ? { endedAt: call.endedAt } : {}),
    };
  }

  private ordered(nodes: readonly AgentNode[]): AgentSnapshot[] {
    const names = new Set(nodes.map((node) => node.name));
    const children = new Map<string, AgentNode[]>();
    const tops: AgentNode[] = [];
    for (const node of nodes) {
      if (node.parent !== undefined && names.has(node.parent)) {
        const list = children.get(node.parent) ?? [];
        list.push(node);
        children.set(node.parent, list);
      } else {
        tops.push(node);
      }
    }
    const out: AgentSnapshot[] = [];
    const visit = (node: AgentNode) => {
      out.push(snapshotOf(node));
      for (const child of children.get(node.name) ?? []) visit(child);
    };
    for (const top of tops) visit(top);
    return out;
  }
}

function snapshotOf(node: AgentNode): AgentSnapshot {
  return {
    name: node.name,
    depth: node.depth,
    ...(node.parent !== undefined ? { parent: node.parent } : {}),
    ...(node.scope !== undefined ? { scope: node.scope } : {}),
    task: node.task,
    status: node.status,
    step: node.step,
    steps: node.steps,
    contextTokens: node.contextTokens,
    blocks: node.blocks,
    ...(node.action !== undefined ? { action: node.action } : {}),
    folds: node.folds,
    deepFolds: node.deepFolds,
    promptTokens: node.promptTokens,
    cachedTokens: node.cachedTokens,
    completionTokens: node.completionTokens,
    calls: node.calls,
    startedAt: node.startedAt,
    ...(node.endedAt !== undefined ? { endedAt: node.endedAt } : {}),
    ...(node.terminated !== undefined ? { terminated: node.terminated } : {}),
    ...(node.answer !== undefined ? { answer: node.answer } : {}),
    log: [...node.log],
  };
}
