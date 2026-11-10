import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Thinking levels that pi accepts for a request. */
export const THINKING_LEVELS = Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const);
export type ThinkingSetting = (typeof THINKING_LEVELS)[number] | 'inherit';

/** Global RAF settings. The root model is always the native pi `/model` selection. */
export interface RafConfig {
  readonly enabledByDefault: boolean;
  readonly depth: number;
  readonly reserve: number;
  readonly concurrency: number;
  /** `provider/id` of the branch (subagent) model. Empty means the root model. */
  readonly branchModel: string;
  readonly branchThinking: ThinkingSetting;
  /** `provider/id` of the llm_query reader model. Empty means the root model. */
  readonly readerModel: string;
  readonly deepStudy: boolean;
  readonly indexWorkspace: boolean;
}

export const DEPTH_RANGE = Object.freeze({ min: 1, max: 3 });
export const RESERVE_RANGE = Object.freeze({ min: 0.1, max: 0.5, step: 0.05 });
export const CONCURRENCY_RANGE = Object.freeze({ min: 1, max: 8 });

export const DEFAULT_CONFIG: RafConfig = Object.freeze({
  enabledByDefault: false,
  depth: 2,
  reserve: 0.3,
  concurrency: 4,
  branchModel: '',
  branchThinking: 'inherit',
  readerModel: '',
  deepStudy: false,
  indexWorkspace: true,
});

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function toReserve(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_CONFIG.reserve;
  const clamped = Math.min(RESERVE_RANGE.max, Math.max(RESERVE_RANGE.min, n));
  return Number((Math.round(clamped / RESERVE_RANGE.step) * RESERVE_RANGE.step).toFixed(2));
}

function toModelSpec(value: unknown): string {
  if (typeof value !== 'string') return '';
  const spec = value.trim().slice(0, 200);
  return /^[^/\s]+\/\S+$/.test(spec) ? spec : '';
}

function toThinking(value: unknown): ThinkingSetting {
  if (value === 'inherit') return 'inherit';
  return THINKING_LEVELS.find((level) => level === value) ?? DEFAULT_CONFIG.branchThinking;
}

/** Normalize untrusted settings (file content or UI input) into a frozen config. */
export function sanitizeConfig(value: unknown): RafConfig {
  const src = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.freeze({
    enabledByDefault: src.enabledByDefault === true,
    depth: clampInt(src.depth, DEFAULT_CONFIG.depth, DEPTH_RANGE.min, DEPTH_RANGE.max),
    reserve: toReserve(src.reserve),
    concurrency: clampInt(src.concurrency, DEFAULT_CONFIG.concurrency, CONCURRENCY_RANGE.min, CONCURRENCY_RANGE.max),
    branchModel: toModelSpec(src.branchModel),
    branchThinking: toThinking(src.branchThinking),
    readerModel: toModelSpec(src.readerModel),
    deepStudy: src.deepStudy === true,
    indexWorkspace: src.indexWorkspace !== false,
  });
}

/** Compare two configs field by field. */
export function configEquals(a: RafConfig, b: RafConfig): boolean {
  return (
    a.enabledByDefault === b.enabledByDefault &&
    a.depth === b.depth &&
    a.reserve === b.reserve &&
    a.concurrency === b.concurrency &&
    a.branchModel === b.branchModel &&
    a.branchThinking === b.branchThinking &&
    a.readerModel === b.readerModel &&
    a.deepStudy === b.deepStudy &&
    a.indexWorkspace === b.indexWorkspace
  );
}

/** Read the config file. A missing or corrupt file gives the defaults. */
export function loadConfig(path: string): RafConfig {
  try {
    return sanitizeConfig(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export type SaveResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** Write the config file atomically with owner-only permissions. */
export function saveConfig(path: string, config: RafConfig): SaveResult {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
