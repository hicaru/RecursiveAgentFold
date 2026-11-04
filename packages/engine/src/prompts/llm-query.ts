/**
 * Prompts for llm_query — the non-thinking chunk reader.
 *
 * Cache layout per chunk call:
 *   [system] LLM_QUERY_SYSTEM                       ← static
 *   [user]   <document …> chunk text </document>    ← byte-identical for the same chunk
 *   [user]   query + output contract                ← varies
 * Because the chunk precedes the query, every new query over an
 * already-scanned chunk reuses the cached prefix (system + chunk).
 */

export const LLM_QUERY_SYSTEM = `You are a fast document reader used as a tool by another agent. You do not deliberate; you read the given document chunk and answer the query about THIS CHUNK ONLY.
Output a single JSON object and nothing else:
{"relevant": true|false, "answer": "<concise finding for this chunk>", "evidence": [{"line": <line number>, "quote": "<short exact quote>"}]}
Rules:
- Use only the chunk text. Never guess beyond it.
- "relevant" is true only if the chunk contains information that answers or helps answer the query.
- Line numbers are the numbers before "|" at the start of each line.
- Keep "answer" under 120 words and at most 5 evidence items unless the query asks for a list or a count.
- If the query asks to count/classify/extract, do it exhaustively over the whole chunk and put the result in "answer".
- When the query asks for counts per category/value, ALSO add "counts": {"<category>": <integer>, ...} with one integer per category (include zeros for categories named in the query). These are summed across chunks automatically.`;

export function renderChunkMessage(args: {
  docId: string;
  title: string;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  body: string;
}): string {
  return `<document id="${args.docId}" title="${escapeAttr(args.title)}" chunk="${args.index + 1}/${args.total}" lines="${args.startLine}-${args.endLine}">\n${args.body}\n</document>`;
}

export type LLMQueryMode = 'locate' | 'extract';

export function renderQueryMessage(query: string, mode: LLMQueryMode): string {
  const modeLine =
    mode === 'locate'
      ? 'Mode: LOCATE — decide whether this chunk contains what the query looks for; if yes, point to the exact lines.'
      : 'Mode: EXTRACT — perform the requested extraction/classification/count over this whole chunk and report the result in "answer" (set "relevant": true whenever you report a result, even zero counts).';
  return `${modeLine}\nQuery: ${query}\nRespond with the JSON object only.`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
