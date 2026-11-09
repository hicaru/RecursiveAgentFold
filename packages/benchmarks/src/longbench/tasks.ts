import { defaultEstimator } from '@raf/engine';
import type { BenchDocument, BenchTask } from '../runner.js';
import type { LongBenchRow } from './dataset.js';

const HEADER_DELIMITER =
  /(?:^|\n)(?=(?:={3,}\s*[^\n]+?\s*={3,}|-{3,}\s*(?:File|Document|Passage)[^\n]*|###\s*(?:File|Document|Passage)\b[^\n]*|(?:Document|Passage)\s+\d+\s*[:\n]|[A-Z]\.\n[A-Z][^\n]{10,150}\n))/g;

export function splitContextIntoDocuments(context: string, maxDocs = 32): BenchDocument[] {
  const parts = context
    .split(HEADER_DELIMITER)
    .map((s) => s.trim())
    .filter((s) => s.length >= 200);
  if (parts.length <= 1) {
    return [
      {
        id: 'context',
        title: 'LongBench-v2 context',
        text: context,
        tokens: defaultEstimator.count(context),
      },
    ];
  }

  const capped =
    parts.length <= maxDocs
      ? parts
      : [
          ...parts.slice(0, maxDocs - 1),
          parts.slice(maxDocs - 1).join('\n\n'),
        ];

  return capped.map((segment, idx) => {
    const lines = segment.split('\n');
    const rawTitle =
      lines[0] && /^[A-Z]\.$/.test(lines[0].trim()) && lines[1]
        ? `${lines[0].trim()} ${lines[1].trim()}`
        : (lines[0] ?? `Document ${idx + 1}`);
    const firstLine = rawTitle.replace(/^[=#-\s]+|[=#-\s]+$/g, '').slice(0, 80);
    const id = `doc_${idx + 1}`;
    return {
      id,
      title: firstLine || `Document ${idx + 1}`,
      text: segment,
      tokens: defaultEstimator.count(segment),
    };
  });
}

export function parseChoiceLetter(output: string): string | undefined {
  const trimmed = output.trim();
  const explicit =
    /(?:answer|choice|option)\s*(?:is|:)?\s*\(?([ABCD])\)?(?:\b|$)/i.exec(trimmed) ??
    /^\(?([ABCD])\)?(?:[.\s:]|$)/i.exec(trimmed);
  if (explicit && explicit[1]) return explicit[1].toUpperCase();
  const allMatches = [...trimmed.matchAll(/\b([ABCD])\b/g)];
  const last = allMatches[allMatches.length - 1];
  return last?.[1]?.toUpperCase();
}

export function buildLongBenchTasks(rows: readonly LongBenchRow[]): BenchTask[] {
  return rows.map((row) => {
    const documents = splitContextIntoDocuments(row.context);
    const totalTokens = documents.reduce((acc, d) => acc + (d.tokens ?? 0), 0);
    const gold = row.answer.trim().toUpperCase();
    const formattedQuestion = [
      row.question.trim(),
      '',
      'Options:',
      `(A) ${row.choice_A.trim()}`,
      `(B) ${row.choice_B.trim()}`,
      `(C) ${row.choice_C.trim()}`,
      `(D) ${row.choice_D.trim()}`,
      '',
      "Select the single best option (A, B, C, or D) based strictly on the provided document(s). Give your final answer in the form 'Answer: <letter>' (where <letter> is A, B, C, or D).",
    ].join('\n');

    return {
      id: `longbench-${row._id}`,
      group: `longbench-${row._id}`,
      question: formattedQuestion,
      documents,
      meta: {
        task: row.domain,
        domain: row.domain,
        sub_domain: row.sub_domain,
        difficulty: row.difficulty,
        length: row.length,
        doc_count: documents.length,
        context_len: totalTokens,
        gold,
      },
      score: (out: string) => {
        const parsed = parseChoiceLetter(out);
        return {
          score: parsed === gold ? 1 : 0,
          ...(parsed ? { parsed } : {}),
        };
      },
    } satisfies BenchTask;
  });
}
