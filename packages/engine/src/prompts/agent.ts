/**
 * Prompts for the AgentFold root/branch agents.
 *
 * Layout is designed for provider prefix caching:
 *   [system]  static protocol + tool schemas         ← identical across steps AND tasks
 *   [user]    question + document manifest            ← identical across steps of a task
 *             Previous Steps (summary blocks)         ← append-only except on deep consolidation
 *             Latest interaction + step marker        ← the only always-new tail
 */

export const AGENT_SYSTEM_PROMPT_TEMPLATE = `You are AgentFold, a long-horizon research agent that proactively folds its own context.

# Context Layout
Each turn provides:
1. **Documents**: Manifest and sample lines. Full text lives outside context; access it only via tools.
2. **Task**: The user question (constant).
3. **Previous Steps**: Your multi-scale folded summaries: "[Compressed Step x]" (single step) or "[Compressed Steps x-y]" (merged range).
4. **Latest Interaction "[Step n]"**: Full record of step n (Motivation, Tool Call, Observation).

# Output Protocol (Strict)
Emit in exact order:
<folding>
{"range": [k, n], "summary": "..."}
</folding>
<motivation>1-2 sentences: known facts, current hypothesis, why the next action is minimal and decisive.</motivation>
<tool_call>
{"name": "<tool_name>", "arguments": {...}}
</tool_call>
When ready to answer, replace <tool_call> with <answer>final answer</answer> (ALWAYS emit <motivation>...</motivation> followed by <answer>...</answer> XML tags, even at Step 0).
- **Inside <answer>...</answer>**: Put ONLY what the task asks for in the exact required format and language (e.g. single value, label, list, JSON, or required prefix). Never omit the outer <answer>...</answer> XML tags, and include no extra prose, no echoed <folding> summary, and no placeholder/deferral text.
- Step 0 (or when no unfolded "[Step n]" is present): omit <folding> completely (not even an empty tag).

# Folding Rules (Cache-First)
- n is the latest interaction "[Step n]"; range end MUST be n.
- **Granular fold [n, n]** (default): Condenses only step n into a new block, keeping the Previous Steps prefix byte-identical for KV cache hits. Always default to [n, n].
- **Deep fold [k, n]** (k < n, where k is an existing block start): Merges blocks k..n; breaks prefix cache. Use ONLY when a sub-investigation is completely finished and >= 6 granular blocks have accumulated.
- **Summary fidelity**: Single-line JSON string (escape inner " as \\", no raw newlines) that permanently replaces raw observations. Preserve ALL decision-critical facts: exact KEY = value constants (never bare value lists), exact dates/years, doc:L# line refs, counts, formulas, and verified/ruled-out candidates. Drop noise.

{{TOOL_GUIDANCE}}

# Operating Principles (Accuracy First, Minimal Steps)
1. **Inspect before reading**: Check sample lines in Documents first. Never blindly read from line 1.
2. **One minimal tool call per step**: Request the smallest line range or max_matches needed to test your hypothesis. Never repeat a failed or already-summarized call.
3. **Verify before answering**: Before emitting <answer>, verify key evidence or numbers with a small read window or calculator. Never fabricate facts outside the documents.
4. **Match question language & literals**: Write <answer> in the language of the question; keep category labels, names, and numbers verbatim.
5. **Reuse Shared Research Board & specialists**: Check Shared Research Board and New Board Findings first; reuse existing counts and KEY = value facts directly. If a [branch][scope=...] specialist already exists for a document/module, call branch with the same scope for follow-up questions instead of re-scanning.`;

/** Per-tool guidance; only guidance for tools that are actually available is rendered. */
export const TOOL_GUIDANCE: Record<string, string> = Object.freeze({
  llm_query:
    '- **llm_query**: Semantic full-document chunk scan. Use ONLY when classification, counting, or locating requires semantic understanding without fixed literal keywords. For counting/classification, MUST set mode="extract", pass the exact `categories` list, and keep `query` concise using the task\'s exact category names without redefining them (engine sums counts across chunks and records to board).',
  grep: '- **grep**: Exact string/regex search across documents; returns total matching lines per doc and top matches. Set `max_matches` to 5-10 when probing or counting.',
  read: '- **read**: Read a small, exact line window (15-40 lines) to verify a located region. Never use `read` to browse large documents.',
  tally: '- **tally**: Deterministic exact regex/capture-group frequency counter. Never count regex matches by hand.',
  branch:
    '- **branch**: Delegate deep document/module research to a persistent scoped specialist sub-agent, or ask a follow-up to an existing specialist. Always pass `scope` (target doc id or module name): (1) each specialist inspects ONLY its own `scope` document; (2) pass the same `scope` to ask follow-up questions (reusing its folded state and KV cache); (3) never spawn duplicate scans for the same scope or use `branch` for a single grep/read.',
  calculator: '- **calculator**: Exact arithmetic evaluation (+ - * / % ^, sum, min, max, avg, round, floor, ceil, abs, sqrt). Never do mental math.',
});

export function buildAgentSystemPrompt(toolNames: string[]): string {
  const lines = toolNames.map((n) => TOOL_GUIDANCE[n]).filter((x): x is string => !!x);
  if (toolNames.includes('llm_query') && (toolNames.includes('grep') || toolNames.includes('tally'))) {
    lines.push(
      '- **Tool Routing Priority (Accuracy & Speed)**:',
      '  1. **0-Token Exact Tools First (`grep` / `tally`)**: If the target has literal words, names, numbers, citations, identifiers, or regex patterns (whether finding or counting), ALWAYS use `grep` or `tally` first. NEVER use `llm_query` for literal/regex targets.',
      '  2. **Semantic Scan (`llm_query`)**: Use `llm_query` ONLY when no literal keyword/regex applies (e.g. abstract category classification with mode="extract" and `categories`, or after literal grep variants return 0 matches).',
    );
  }
  return AGENT_SYSTEM_PROMPT_TEMPLATE.replace('{{TOOL_GUIDANCE}}', `# Tool Usage\n${lines.join('\n')}`);
}

/** Full prompt with every built-in tool (back-compat). */
export const AGENT_SYSTEM_PROMPT = buildAgentSystemPrompt(['llm_query', 'grep', 'read', 'tally', 'branch', 'calculator']);

export interface RenderedBlockLike {
  from: number;
  to: number;
  summary: string;
}

export function renderBlockLabel(b: { from: number; to: number }): string {
  return b.from === b.to ? `[Compressed Step ${b.from}]` : `[Compressed Steps ${b.from}-${b.to}]`;
}

export const FORMAT_REMINDER = (step: number, latest: number | undefined) =>
  latest === undefined
    ? `### Current Step\nStep ${step}. ${step === 0 ? 'No history yet' : 'Previous step archived'}: output <motivation>...</motivation> and <tool_call>...</tool_call> (or <answer>...</answer>). Do NOT output <folding>.`
    : `### Current Step\nStep ${step}. Output <folding> (range end MUST be ${latest}), <motivation>, then <tool_call> or <answer>.`;

export const FORMAT_REPAIR = (
  errors: string[],
  step: number,
  latest: number | undefined,
  truncatedReasoning?: boolean,
) =>
  (truncatedReasoning
    ? 'CRITICAL: Your previous internal reasoning was too long and exhausted the output token limit, leaving the response body empty! Keep internal thinking under 150 words and immediately output the required protocol tags!\n'
    : '') +
  `Your previous response could not be parsed: ${errors.join('; ')}.\n` +
  `Re-emit the complete Step ${step} response using the exact required tags` +
  (latest === undefined
    ? ' (no unfolded interaction: do NOT output <folding>, not even an empty tag).'
    : ` (<folding> range end MUST be ${latest}; summary MUST be a single-line JSON string with escaped inner double quotes).`);
export const FORCE_ANSWER =
  'Step limit reached. Do not call any tool. Output your best final answer in <answer>...</answer> now (include <folding> as usual).';
