import type { BenchTask } from '../runner.js';
import { splitContextIntoDocuments } from '../longbench/tasks.js';
import type { LongBenchProRow } from './dataset.js';

/**
 * LongBench-Pro v1.0 answers are item lists behind an
 * [Answer]/Answer: marker, newline- or comma-separated. Scoring:
 * ordered exact match = 1, unordered set match = 0.5, else 0.
 */

/** Unicode-aware item normalization: lowercase, keep letters/numbers only. */
export function normalizeItem(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\d+[.)、]\s*/, '')
    .replace(/^[-*•]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Payload after the LAST answer marker ([Answer]/Answer:), else the text. */
export function extractAnswerPayload(out: string): string {
  const bracketed = [...out.matchAll(/\[(?:answer|答案)\]\s*[:：]?/gi)];
  const lastBracket = bracketed[bracketed.length - 1];
  if (lastBracket) {
    const tail = out.slice((lastBracket.index ?? 0) + lastBracket[0].length).trim();
    return tail.replace(/\n\s*(?:Answer|答案)\s*[:：][\s\S]*$/i, '').trim();
  }
  const markers = [...out.matchAll(/(?:answer|答案)\s*[:：]?/gi)];
  const last = markers[markers.length - 1];
  if (!last) return out.trim();
  return out.slice((last.index ?? 0) + last[0].length).trim();
}

export function parseAnswerItems(out: string): string[] {
  return extractAnswerPayload(out)
    .split(/[\n,，;；|]+/)
    .map(normalizeItem)
    .filter(Boolean);
}

export function buildLongBenchProTasks(rows: readonly LongBenchProRow[]): BenchTask[] {
  return rows.map((row) => {
    const documents = splitContextIntoDocuments(row.context);
    const totalTokens = documents.reduce((acc, d) => acc + (d.tokens ?? 0), 0);
    const gold = row.answer
      .split(/[\n,，;；|]+/)
      .map(normalizeItem)
      .filter(Boolean);
    const goldJoined = gold.join('|');
    const goldSet = new Set(gold);
    const hasNativeFormat = /\[answer\]/i.test(row.question);
    const formattedQuestion = [
      row.question.trim(),
      '',
      hasNativeFormat
        ? 'Answer based strictly on the provided document(s).'
        : "Answer based strictly on the provided document(s). Give your final answer in the form 'Answer: <items>' (comma-separated if several).",
    ].join('\n');
    return {
      id: `longbench-pro-${row._id}`,
      group: `longbench-pro-${row._id}`,
      question: formattedQuestion,
      documents,
      meta: {
        task: row.domain || 'longbench_pro',
        domain: row.domain,
        difficulty: row.difficulty,
        length: row.length,
        token_length: row.token_length,
        doc_count: documents.length,
        context_len: totalTokens,
        gold: row.answer,
      },
      score: (out: string): { score: number; parsed?: string; extra?: Record<string, number> } => {
        const got = parseAnswerItems(out);
        if (got.length === 0 || gold.length === 0) return { score: 0 };
        if (got.join('|') === goldJoined) return { score: 1, parsed: got.join(', ') };
        const uniq = [...new Set(got)];
        const hits = uniq.filter((g) => goldSet.has(g)).length;
        if (hits === goldSet.size && uniq.length === goldSet.size) {
          return { score: 0.5, parsed: got.join(', '), extra: { unordered: 1, hits, gold: goldSet.size } };
        }
        return { score: 0, parsed: got.join(', '), extra: { hits, gold: goldSet.size } };
      },
    } satisfies BenchTask;
  });
}
