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
Keep internal thinking minimal: when classifying or counting lines, NEVER quote full lines or write sentences in thinking—write ONLY compact "line#:cue->code" tokens (1-2 word answer/subject cue + category code, e.g. "5:year->N 6:city->L 7:poet->H") and tally each code.
Use ONLY this chunk. Line numbers are the integers before "|" at the start of each line.
Output ONLY these XML tags (no JSON braces or quote escaping needed):
<relevant>true|false</relevant>
<counts>
category_name: <int>
</counts>
<answer>concise findings</answer>
<evidence>
L<line>: <short verbatim quote>
</evidence>
Rules:
- Set <relevant>true</relevant> if this chunk contains ANY information matching any part of the query; otherwise <relevant>false</relevant>. Never guess beyond the text.
- For category/item counting (EXTRACT): classify each item by its true target referent (e.g. for questions, classify by the expected answer's type—such as person/group vs concept/entity—rather than surface words like "What/Which"), scan every applicable line, list all requested categories as "category: <int>" lines inside <counts>...</counts> (include 0s; the engine sums across chunks), keep <answer> brief, and omit <evidence>.
- Otherwise (LOCATE): omit <counts>, keep <answer> <= 120 words, and list up to 5 exact evidence lines inside <evidence>...</evidence> formatted as "L<line>: <verbatim quote>".`;

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
      ? 'Mode: LOCATE — Check if this chunk matches any part of the query; if so, output <relevant>true</relevant>, <answer>...</answer>, and exact "L<line>: <verbatim quote>" lines inside <evidence>...</evidence>. Keep thinking brief.'
      : 'Mode: EXTRACT — Classify/count every applicable item in this chunk, list every category as "category: <int>" inside <counts>...</counts> (include 0s, set <relevant>true</relevant>), and summarize in <answer>...</answer>. In thinking, use ONLY "line#:cue->code" shorthand (1-2 word cue) without quoting full lines.';
  const catLine =
    categories && categories.length > 0
      ? `\nCategories (use ONLY these exact keys in <counts>, include 0s): ${categories.join(', ')}`
      : '';
  return `${modeLine}${catLine}\nQuery: ${query}\nOutput ONLY the XML tags (<relevant>, <counts>, <answer>, <evidence>).`;
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/\n/g, ' ');
}
