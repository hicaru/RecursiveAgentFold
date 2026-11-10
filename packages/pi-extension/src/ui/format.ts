/**
 * Shared formatting: numbers, glyphs, text shaping.
 *
 * Every measurable value is a plain number with a short unit (`72%`, `253k`,
 * `$0.03`, `1.8s`). No progress bars, no sparklines, no box art.
 */
const SPINNER = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const);

const SPINNER_MS = 90;

/** Braille spinner frame for `now`. */
export function spinnerFrame(now: number): string {
  return SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length] ?? '⠋';
}

/** `1234` → `1.2k`, `1234567` → `1.2M`. */
export function tokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** `0.72` → `72%`; `undefined` → `—`. */
export function percent(rate: number | undefined): string {
  if (rate === undefined || !Number.isFinite(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** `0.031` → `$0.03`. */
export function usd(value: number): string {
  if (!Number.isFinite(value)) return '$—';
  return `$${value.toFixed(value >= 10 ? 1 : 2)}`;
}

/** `840` → `840ms`, `3200` → `3.2s`, `95000` → `1m35s`. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Short badge per tool name. */
const BADGES: Readonly<Record<string, string>> = Object.freeze({
  add_document: 'AD',
  list_documents: 'LD',
  llm_query: 'LQ',
  search: 'SR',
  outline: 'OL',
  grep: 'GR',
  read: 'RD',
  tally: 'TL',
  branch: 'BR',
  calculator: '±',
});

/** `branch` → `BR`, unknown names get their first two letters uppercased. */
export function badge(name: string): string {
  if (name.startsWith('mcp__')) return 'MC';
  return BADGES[name] ?? name.slice(0, 2).toUpperCase();
}

/** Strip the provider prefix: `openai/gpt-5` → `gpt-5`. */
export function shortModel(spec: string): string {
  const slash = spec.indexOf('/');
  return slash === -1 ? spec : spec.slice(slash + 1);
}

/** Role glyphs: root ◉, branch ⑂, llm_query ⟂. */
export const ROLE_GLYPH = Object.freeze({ root: '◉', branch: '⑂', llm_query: '⟂' } as const);

/** Glyph for a role. */
export function roleGlyph(role: keyof typeof ROLE_GLYPH): string {
  return ROLE_GLYPH[role];
}

/** Separator between inline fields. */
export const SEP = ' · ';

/** Join non-empty parts with the inline separator. */
export function joinParts(parts: readonly (string | undefined | false)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(SEP);
}

/** `1 task` / `3 tasks`. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** Clip plain text to `width` glyphs, adding `…` when truncated. */
export function clip(text: string, width: number): string {
  if (text.length <= width) return text;
  if (width <= 1) return '…';
  return `${text.slice(0, width - 1)}…`;
}