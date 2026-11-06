import type { BenchTask } from '../runner.js';
import { splitContextIntoDocuments } from '../longbench/tasks.js';
import type { LongBenchProRow } from './dataset.js';

/**
 * Lenient normalization for open-ended LongBench-Pro answers: lowercase,
 * strip punctuation/articles, collapse whitespace.
 */
export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(a|an|the)\s+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the payload after the last 'Answer:' marker, else the whole text. */
export function extractAnswerPayload(out: string): string {
  const m = /answer\s*[:：]\s*(.+)$/is.exec(out);
  return (m?.[1] ?? out).trim();
}

export function buildLongBenchProTasks(rows: readonly LongBenchProRow[]): BenchTask[] {
  return rows.map((row) => {
    const documents = splitContextIntoDocuments(row.context);
    const totalTokens = documents.reduce((acc, d) => acc + (d.tokens ?? 0), 0);
    const goldNorm = normalizeAnswer(row.answer);
    const formattedQuestion = [
      row.question.trim(),
      '',
      "Answer the question based strictly on the provided document(s). Keep the answer short and factual. Give your final answer in the form 'Answer: <short answer>'.",
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
      score: (out: string) => {
        const payload = normalizeAnswer(extractAnswerPayload(out));
        if (!payload) return { score: 0 };
        // lenient containment: the gold answer must appear verbatim in the payload
        const hit = payload === goldNorm || payload.includes(goldNorm);
        return { score: hit ? 1 : 0, ...(hit ? { parsed: row.answer } : {}) };
      },
    } satisfies BenchTask;
  });
}
