import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { BenchTask } from '../runner.js';
import { scoreOolong, scoreOolongLenient } from './scoring.js';

/**
 * The rlm.pi OOLONG suite (../rlm.pi/bench): oolongbench/oolong-synth *test*
 * split, context_len ≤ maxCl, round-robin across length buckets, n tasks.
 * We read the exact cached task file rlm.pi uses (copied into
 * .cache/oolong-rlmpi/) so results are directly comparable with its journals
 * (e.g. bench/runs/glm-5.3/*.jsonl).
 */
export interface RlmPiRecord {
  id: string;
  context: string;
  question: string;
  answer: unknown;
  answerType: string;
  taskGroup: string;
  contextLen: number;
}

export function rlmPiCachePath(cacheDir: string, maxCl: number, n: number): string {
  return join(cacheDir, 'oolong-rlmpi', `oolong_synth_cl${maxCl}_n${n}.json`);
}

export function loadRlmPiRecords(cacheDir: string, maxCl = 65536, n = 24, sourceRepo = '../rlm.pi'): RlmPiRecord[] {
  const p = rlmPiCachePath(cacheDir, maxCl, n);
  const alt = join(sourceRepo, 'bench', 'data', `oolong_synth_cl${maxCl}_n${n}.json`);
  const file = existsSync(p) ? p : existsSync(alt) ? alt : undefined;
  if (!file) throw new Error(`rlm.pi task cache not found: ${p} (copy it from ${alt})`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RlmPiRecord[];
  if (!Array.isArray(parsed)) throw new Error(`corrupt rlm.pi task cache: ${file}`);
  return parsed;
}

// ---- rlm.pi scorer (bench/scorers.ts, port of the rlm_test lab `score_oolong_answer`) ----

function parsePyLiteral(s: string): unknown {
  const t = s.trim();
  try {
    return JSON.parse(t) as unknown;
  } catch {
    if (t.startsWith('[') && t.endsWith(']')) {
      const inner = t.slice(1, -1);
      if (inner.trim() === '') return [];
      return inner.split(',').map((part) => part.trim().replace(/^['"]|['"]$/g, ''));
    }
    return s;
  }
}

function normalizeLabel(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/^label:\s*/, '')
    .trim()
    .replace(/^['"[\]]+|['"[\]]+$/g, '');
}

/** Verbatim logic of rlm.pi `scoreOolong(pred, gold, answerType)`. */
export function scoreRlmLab(pred: string, gold: unknown, answerType: string): number {
  if (!pred) return 0;
  const p = pred.trim();
  const goldV = typeof gold === 'string' ? parsePyLiteral(gold) : gold;
  const at = (answerType || '').toUpperCase();
  const goldLooksFreq = Array.isArray(goldV) && goldV.length > 0 && String(goldV[0]).toUpperCase().includes('MOST_FREQ');
  if (at.includes('LABEL') || String(goldV).toUpperCase().includes('MOST_FREQ') || goldLooksFreq) {
    const raw = Array.isArray(goldV) && goldV.length > 0 ? String(goldV[0]) : String(goldV);
    const g = normalizeLabel(raw);
    const pl = normalizeLabel(p);
    if (g && (pl.includes(g) || pl === g)) return 1.0;
    const words = pl.match(/[a-z0-9_]+/g) ?? [];
    if (words.length > 0 && words[words.length - 1] === g) return 1.0;
    return 0.0;
  }
  let goldNum: number | null = null;
  if (Array.isArray(goldV) && goldV.length === 1 && typeof goldV[0] === 'number') goldNum = goldV[0];
  else if (typeof goldV === 'number') goldNum = goldV;
  else if (Array.isArray(goldV) && goldV.length === 1) {
    const parsed = Number(String(goldV[0]).replace(/,/g, ''));
    goldNum = Number.isFinite(parsed) ? parsed : null;
  }
  if (goldNum !== null || at.includes('NUM')) {
    const nums = p.replace(/,/g, '').match(/-?\d+\.?\d*/g) ?? [];
    if (nums.length === 0 || goldNum === null) return 0.0;
    for (const n of nums) if (Math.abs(Number.parseFloat(n) - goldNum) < 1e-6) return 1.0;
    return 0.0;
  }
  if (Array.isArray(goldV)) {
    const parts = goldV.map((x) => String(x).trim().toLowerCase()).filter((x) => x.length > 0);
    if (parts.length === 0) return 0.0;
    const pl = p.toLowerCase();
    return parts.every((part) => pl.includes(part)) ? 1.0 : 0.0;
  }
  const g = String(goldV).trim().toLowerCase();
  return g && p.toLowerCase().includes(g) ? 1.0 : 0.0;
}

function goldAsPythonList(answer: unknown): string {
  // official scorer expects the HF literal string, e.g. "['incorrect']" / "[7]"
  if (typeof answer === 'string') return answer;
  return JSON.stringify(answer).replace(/"/g, "'");
}

export function buildRlmPiTasks(records: RlmPiRecord[]): BenchTask[] {
  return records.map((r) => {
    const goldStr = goldAsPythonList(r.answer);
    return {
      id: r.id,
      group: `rlmpi-${createHash('sha1').update(r.context).digest('hex').slice(0, 12)}`,
      // Same question text as rlm.pi minus its Python/REPL recipe (vanilla AgentFold has no REPL).
      question: `${r.question}\n\n(The data is stored as document \`context\`; the first lines describe the dataset and its labels.)`,
      documents: [{ id: 'context', title: `OOLONG-synth context (${r.contextLen} tokens bucket)`, text: r.context, tokens: r.contextLen }],
      meta: { task: r.taskGroup, answer_type: r.answerType, context_len: r.contextLen, gold: goldStr },
      score: (out: string) => {
        const lab = scoreRlmLab(out, r.answer, r.answerType);
        const official = scoreOolong({ answer: goldStr, answer_type: r.answerType }, out).score;
        return { score: lab, parsed: out.trim().slice(0, 120), extra: { official, lenient: scoreOolongLenient({ answer: goldStr, answer_type: r.answerType }, out) } };
      },
      directMessages: () => [
        { role: 'system', content: `You are a helpful assistant.\n\n${r.context}` },
        { role: 'user', content: r.question },
      ],
    } satisfies BenchTask;
  });
}
