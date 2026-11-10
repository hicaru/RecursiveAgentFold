import type { Theme, ToolRenderResultOptions } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import type { RafToolDetails } from '../turn.js';
import { type AgentSnapshot, type CallSnapshot, oneLine } from '../tracker.js';
import { badge, clip, duration, percent, plural, roleGlyph, SEP, spinnerFrame, tokens } from './format.js';

/**
 * RAF tool rows.
 *
 * Two registers, nothing else:
 *   call   — one dense line: `BR branch · 3 tasks`
 *   result — agent tree while running, a receipt line when done
 *
 * Every glyph here is width 1, so rows stay aligned in any terminal and in
 * any font. No boxes, no padding art: the data is the decoration.
 */

const MAX_AGENTS = 8;
const MAX_QUERIES = 3;
const TAIL = 60;

/** `BR branch · 3 tasks` — what this call is about, in one line. */
export function rafRenderCall(name: string, label: string) {
  return (args: unknown, theme: Theme): Text => {
    const record = (args ?? {}) as Record<string, unknown>;
    const parts: string[] = [];
    if (Array.isArray(record.tasks)) {
      parts.push(plural(record.tasks.length, 'task'));
    } else if (typeof record.scope === 'string' && record.scope !== '') {
      parts.push(clip(oneLine(record.scope, 48), 40));
    }
    for (const key of ['query', 'pattern', 'expression', 'document', 'file_path', 'path', 'template']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim() !== '') {
        parts.push(clip(oneLine(value, 80), 52));
        break;
      }
    }
    if (typeof record.mode === 'string' && record.mode !== '') parts.push(record.mode);
    if (typeof record.max_matches === 'number') parts.push(`≤${record.max_matches}`);
    if (typeof record.depth === 'number') parts.push(`d${record.depth}`);

    const tag = `${theme.fg('toolTitle', theme.bold(badge(name)))} ${theme.fg('muted', name)}`;
    const detail = parts.length === 0 ? '' : ` ${theme.fg('dim', parts.join(SEP))}`;
    const suffix = label === '' ? '' : ` ${theme.fg('dim', `[${label}]`)}`;
    return new Text(`${tag}${detail}${suffix}`, 0, 0);
  };
}

function statusIcon(theme: Theme, agent: AgentSnapshot, now: number): string {
  if (agent.status === 'running') return theme.fg('accent', spinnerFrame(now));
  if (agent.status === 'done') return theme.fg('success', '✔');
  return theme.fg('error', '✖');
}

/** `s3 · 4b · f2+1 · cache 62% · 305Ktok` — the per-agent telemetry spine. */
function agentMeta(agent: AgentSnapshot): string {
  const meta: string[] = [`s${agent.step}`];
  if (agent.steps > 0 && agent.steps !== agent.step) meta.push(`/${agent.steps}`);
  if (agent.blocks > 0) meta.push(`${agent.blocks}b`);
  if (agent.folds > 0) meta.push(agent.deepFolds > 0 ? `f${agent.folds}+${agent.deepFolds}` : `f${agent.folds}`);
  if (agent.promptTokens > 0) {
    const rate = agent.cachedTokens / agent.promptTokens;
    meta.push(`cache ${percent(rate)}`);
  }
  const used = agent.promptTokens + agent.completionTokens;
  if (used > 0) meta.push(`${tokens(used)}tok`);
  return meta.join(SEP);
}

function agentTail(theme: Theme, agent: AgentSnapshot): string {
  if (agent.status === 'running') {
    const action = agent.action;
    if (action === undefined || action === '' || action === 'thinking') return theme.fg('dim', 'thinking…');
    return clip(oneLine(action, 90), TAIL);
  }
  const settled = agent.terminated ?? agent.answer ?? agent.status;
  return theme.fg(agent.status === 'done' ? 'dim' : 'error', clip(oneLine(settled, 120), TAIL));
}

function agentRow(theme: Theme, agent: AgentSnapshot, prefix: string, now: number): string {
  const name = agent.depth === 0 ? 'root' : (agent.scope ?? agent.name);
  return `${prefix}${statusIcon(theme, agent, now)} ${theme.bold(name)} ${theme.fg('muted', agentMeta(agent))} ${agentTail(theme, agent)}`;
}

/** Depth-first tree with box-drawing rails; root stays unindented. */
function snapshotLines(theme: Theme, call: CallSnapshot, now: number): string[] {
  const lines: string[] = [];
  const agents = call.agents.filter((agent) => agent.depth > 0 || agent.steps > 0).slice(0, MAX_AGENTS);
  agents.forEach((agent, index) => {
    if (agent.depth === 0) {
      lines.push(agentRow(theme, agent, '', now));
      return;
    }
    const next = agents[index + 1];
    const rail = next === undefined || next.depth <= agent.depth ? '└─' : '├─';
    lines.push(agentRow(theme, agent, `${theme.fg('dim', `${'│ '.repeat(Math.max(0, agent.depth - 1))}${rail}`)} `, now));
  });
  const hidden = call.agents.length - agents.length;
  if (hidden > 0) lines.push(theme.fg('dim', `   … ${plural(hidden, 'agent')} omitted`));

  for (const query of call.queries.slice(0, MAX_QUERIES)) {
    const hitRate = query.chunks > 0 ? query.relevant / query.chunks : undefined;
    const parts = [
      `${query.relevant}/${query.chunks}`,
      hitRate === undefined ? '–' : percent(hitRate),
      `${query.memoHits} memo`,
      `${tokens(query.chunkTokens)}/ch`,
    ];
    lines.push(
      `${theme.fg('dim', `   ${roleGlyph('llm_query')}`)} ${theme.fg('muted', query.mode)} ${clip(oneLine(query.query, 80), 44)} ${theme.fg('dim', parts.join(SEP))}`,
    );
  }
  if (call.queries.length > MAX_QUERIES) lines.push(theme.fg('dim', `   … +${call.queries.length - MAX_QUERIES} queries`));

  const chunks = call.readerDone + call.readerActive;
  if (chunks > 0) {
    const read = call.readerDone / chunks;
    lines.push(theme.fg('dim', `   reader ${percent(read)} ${call.readerDone}/${chunks}`));
  }
  return lines;
}

function firstText(result: { content: Array<{ type: string; text?: string }> }): string {
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text;
  }
  return '';
}

/** `✔ BR · 3 lines · 412 chars · 1.8s` */
function receipt(theme: Theme, details: RafToolDetails | undefined, options: ToolRenderResultOptions): string {
  if (details === undefined) return '';
  const parts = [plural(details.lines, 'line'), `${details.chars} chars`];
  const call = details.call;
  if (call?.endedAt !== undefined && call.startedAt !== undefined) parts.push(duration(call.endedAt - call.startedAt));
  const mark = options.isPartial ? theme.fg('accent', spinnerFrame(Date.now())) : theme.fg('success', '✔');
  return `${mark} ${theme.fg('toolTitle', theme.bold(badge(details.tool)))} ${theme.fg('dim', parts.join(SEP))}`;
}

/** Result renderer for RAF tools: live tree while running, receipt + body when done. */
export function rafRenderResult(result: { content: Array<{ type: string; text?: string }>; details: unknown }, options: ToolRenderResultOptions, theme: Theme): Text {
  const details = result.details as RafToolDetails | undefined;
  const text = firstText(result);
  const now = Date.now();

  if (options.isPartial) {
    const call = details?.call;
    if (call === undefined) {
      return new Text(`${theme.fg('accent', spinnerFrame(now))} ${theme.fg('dim', 'working…')}`, 0, 0);
    }
    const running = call.agents.filter((agent) => agent.status === 'running').length;
    const done = call.agents.filter((agent) => agent.status === 'done').length;
    const parts = [`${running} running`, `${done}/${call.agents.length}`, `${call.readerDone} chunks`];
    const head = `${theme.fg('accent', spinnerFrame(now))} ${theme.fg('muted', details?.tool ?? 'raf')} ${theme.fg('dim', parts.join(SEP))}`;
    return new Text([head, ...snapshotLines(theme, call, now).slice(0, MAX_AGENTS)].join('\n'), 0, 0);
  }

  const lines: string[] = [];
  if (details?.call !== undefined) lines.push(...snapshotLines(theme, details.call, now));

  const head = clip(oneLine(text.split('\n', 1)[0] ?? '', 200), options.expanded ? 200 : 120);
  if (head !== '') lines.push(`${theme.fg('dim', '│')} ${options.expanded ? theme.fg('muted', head) : head}`);

  if (options.expanded) {
    const body = text.split('\n').slice(1, 41);
    for (const line of body) lines.push(`${theme.fg('dim', '│')} ${theme.fg('dim', line)}`);
    if (text.split('\n').length > 41) lines.push(theme.fg('dim', '│ …'));
  }

  const foot = receipt(theme, details, options);
  if (foot !== '') lines.push(foot);
  return new Text(lines.join('\n'), 0, 0);
}