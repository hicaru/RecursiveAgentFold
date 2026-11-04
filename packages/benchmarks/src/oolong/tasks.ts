import type { BenchTask } from '../runner.js';
import type { OolongRow } from './dataset.js';
import { scoreOolong, scoreOolongLenient } from './scoring.js';

/** Dataset descriptions (from the RLM OOLONG environment) — optional hints, applied identically to all methods. */
export const DATASET_HINTS: Record<string, string> = {
  trec_coarse:
    "The context contains thousands of general-knowledge questions, one per line. Each line has a User ID and a question, and each question's answer falls into one of 6 categories: 'numeric value', 'entity', 'location', 'description and abstract concept', 'abbreviation', 'human being'.",
  spam: 'The context contains thousands of SMS messages, one per line, each of which is either spam or ham (not spam).',
};

export interface OolongTaskOptions {
  hint?: boolean;
}

export function buildOolongTasks(rows: OolongRow[], o: OolongTaskOptions = {}): BenchTask[] {
  return rows.map((row) => {
    const hint = o.hint !== false ? DATASET_HINTS[row.dataset] : undefined;
    const question = hint ? `${hint} Answer the following aggregate question.\n\nQuestion: ${row.question}` : row.question;
    const doc = { id: 'context', title: `OOLONG ${row.dataset} context window ${row.context_window_id}`, text: row.context_window_text, tokens: row.context_len };
    return {
      id: `oolong-${row.dataset}-${row.context_len}-${row.id}`,
      group: `oolong-${row.context_window_id}`,
      question: `${question}\n\n(The full context window is stored as document \`context\`.)`,
      documents: [doc],
      meta: {
        dataset: row.dataset,
        task: row.task,
        task_group: row.task_group,
        answer_type: row.answer_type,
        context_len: row.context_len,
        context_window_id: row.context_window_id,
        gold: row.answer,
      },
      score: (out: string) => {
        const s = scoreOolong(row, out);
        return { score: s.score, parsed: s.parsed, extra: { lenient: scoreOolongLenient(row, out) } };
      },
      // Official OOLONG layout: context in the system prompt (cache-friendly), question as user turn.
      directMessages: () => [
        { role: 'system', content: `You are a helpful assistant.\n\n${row.context_window_text}` },
        { role: 'user', content: question },
      ],
    } satisfies BenchTask;
  });
}
