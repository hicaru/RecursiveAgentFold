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

export const LLM_QUERY_SYSTEM = `You are a fast, exact chunk reader for another agent.
Keep internal thinking minimal: when classifying or counting lines, NEVER quote, paraphrase, or explain lines in thinking—write ONLY compact "line#:code" tokens (e.g. "5N 6E 7H 8D") and tally each code.
Use ONLY this chunk. Line numbers are the integers before "|" at the start of each line.
Output ONLY a single JSON object:
{"relevant": true|false, "counts": {"<category>": <int>, ...}, "answer": "<concise findings>", "evidence": [{"line": <int>, "quote": "<short verbatim quote>"}]}
Rules:
- Set "relevant": true if this chunk contains ANY information matching any part of the query. Never guess beyond the text.
- For category/item counting (EXTRACT): scan every applicable line, fill "counts" for all requested categories (include 0s; the engine sums across chunks), keep "answer" brief, and omit "evidence".
- Otherwise (LOCATE): omit "counts", keep "answer" <= 120 words, and include up to 5 exact "evidence" items with integer "line" and verbatim "quote".`;

export function renderChunkMessage(args: {
  docId: string;
  title: string;
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  body: string;
}): string {
  return `<document id="${args.docId}" title="${escapeAttr(args.title)}" chunk="${args.index + 1}" lines="${args.startLine}-${args.endLine}">\n${args.body}\n</document>`;
}

export type LLMQueryMode = 'locate' | 'extract';

export function renderQueryMessage(query: string, mode: LLMQueryMode, categories?: readonly string[]): string {
  const modeLine =
    mode === 'locate'
      ? 'Mode: LOCATE — Check if this chunk matches any part of the query; if so, set "relevant": true and list exact line numbers and verbatim quotes in "evidence". Keep thinking brief.'
      : 'Mode: EXTRACT — Classify/count every applicable item in this chunk, fill "counts" by category (include 0s, set "relevant": true), and summarize in "answer". In thinking, use ONLY "line#:code" shorthand without quoting lines.';
  const catLine =
    categories && categories.length > 0
      ? `\nCategories (use ONLY these exact keys in "counts", include 0s): ${categories.map((c) => JSON.stringify(c)).join(', ')}`
      : '';
  return `${modeLine}${catLine}\nQuery: ${query}\nOutput ONLY the JSON object.`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
