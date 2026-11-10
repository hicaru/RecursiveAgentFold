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

# Output Protocol (Strict XML — No JSON Needed)
Emit in exact order:
<folding range="k-n">
Single-paragraph plain-text summary of step(s) k..n (no JSON braces or quote escaping needed).
</folding>
<motivation>1-2 sentences: known facts, current hypothesis, why the next action is minimal and decisive.</motivation>
<tool_call name="tool_name">
<param_name>value</param_name>
</tool_call>
When ready to answer, replace <tool_call> with <answer>final answer</answer> (ALWAYS emit <motivation>...</motivation> followed by <answer>...</answer> XML tags, even at Step 0).
- **Inside <answer>...</answer>**: Put ONLY what the task asks for in the exact required format and language (e.g. single value, label, list, or required prefix). Never omit the outer <answer>...</answer> XML tags, and include no extra prose, no echoed <folding> summary, and no placeholder/deferral text.
- Step 0 (or when no unfolded "[Step n]" is present): omit <folding> completely (not even an empty tag).

# Folding Rules (Cache-First)
- n is the latest interaction "[Step n]"; range end MUST be n (e.g. <folding range="n-n"> or <folding range="k-n">).
- **Granular fold (range="n-n")** (default): Condenses only step n into a new block, keeping the Previous Steps prefix byte-identical for KV cache hits. Always default to range="n-n".
- **Deep fold (range="k-n")** (k < n, where k is an existing block start): Merges blocks k..n; breaks prefix cache. Use ONLY when a sub-investigation is completely finished and >= 6 granular blocks have accumulated.
- **Summary fidelity**: Plain text inside <folding range="k-n">...</folding> (no JSON wrapper or quote escaping needed) that permanently replaces raw observations. Preserve ALL decision-critical facts: exact KEY = value constants (never bare value lists), exact dates/years, doc:L# line refs, counts, formulas, and verified/ruled-out candidates. Drop noise.

{{TOOL_GUIDANCE}}

# Operating Principles (Accuracy First, Minimal Steps)
1. **Probe & locate first**: Check sample lines in Documents first. Use free tools (search, grep, outline, tally) to locate evidence or count patterns before calling read or llm_query. Never blindly read from line 1.
2. **Orchestrate; do not brute-force**: When multiple documents or distinct modules need multi-step inspection (and the needed KEY = value facts are not already on the Shared Research Board) and branch is available, dispatch parallel scoped specialists via <tool_call name="branch"><task scope="doc_1">...</task><task scope="doc_2">...</task></tool_call> instead of reading multiple documents serially in root. Request the smallest line range or max_matches needed to test your hypothesis, and use read in root only for small targeted verification windows (15-40 lines).
3. **Verify before answering**: Before emitting <answer>, verify key evidence or numbers with a small read window or calculator. Never fabricate facts outside the documents.
4. **Match question language & literals**: Write <answer> in the language of the question; keep category labels, names, and numbers verbatim.
5. **Reuse Shared Research Board & specialists**: Check Shared Research Board and New Board Findings first; reuse existing counts and KEY = value facts directly. If a [branch][scope=...] specialist already exists for a document/module, call branch with the same scope for follow-up questions instead of re-scanning.`;

/** Per-tool guidance; only guidance for tools that are actually available is rendered. */
export const TOOL_GUIDANCE: Record<string, string> = Object.freeze({
  add_document:
    '- **add_document**: When the task references a filesystem path, folder, repository, or external document not yet listed in Documents, call `add_document` with `<path>...</path>` first to load and index it into ContextStore.',
  llm_query:
    '- **llm_query**: Semantic full-document chunk scan. Use ONLY when classification, counting, or locating requires semantic understanding without fixed literal keywords. For counting/classification, MUST set `<mode>extract</mode>`, pass the exact `<categories>` list, and keep `<query>` concise using the task\'s exact category names without redefining them (engine sums counts across chunks and records to board).',
  search:
    '- **search**: Free BM25 V2 ranked window retrieval (stemming, phrase bonus, query expansion, CJK n-grams). Use `search` first when locating natural-language topics, paraphrases, or multi-term concepts where exact regex is uncertain.',
  outline:
    '- **outline**: Free structural skeleton (headings, sections, definitions with line numbers). Use to map document boundaries before reading.',
  grep: '- **grep**: Exact string/regex search across stored documents or workspace paths; returns total matching lines per doc and top matches. Set `<max_matches>5</max_matches>` (or 10) when probing or counting.',
  read: '- **read**: Read a line window from a document ID or workspace file path (auto-loads workspace files if needed). Use focused windows (15-80 lines) when verifying located regions; never use `bash` (`cat`, `nl`, `sed`, `head`, `tail`, `awk`) to read files.',
  tally:
    '- **tally**: Deterministic exact regex/capture-group frequency counter. Never count regex matches by hand. When a task asks for frequencies of exact given terms (e.g. lowercase words), use the exact-case counts (or set `<case_sensitive>true</case_sensitive>`) rather than adding capitalized sentence-start variants.',
  branch:
    '- **branch**: Delegate deep document, module, or external-tool research to a persistent scoped specialist sub-agent, or ask a follow-up to an existing specialist. Always pass `scope` (`<tool_call name="branch"><scope>doc_1</scope><task>...</task></tool_call>`, or multiple `<task scope="doc_1">...</task>` tags for parallel tasks): (1) each specialist owns its `scope` and can use all available tools; (2) pass the same `scope` to ask follow-up questions (reusing its folded state and KV cache); (3) never spawn duplicate scans for the same scope or use `branch` for a single grep/read; (4) for document or codebase scopes, use a loaded document id or manifest prefix (load unindexed paths with `add_document` first); for external tool or web research, use a clear topic scope.',
  calculator: '- **calculator**: Exact arithmetic evaluation (+ - * / % ^, sum, min, max, avg, round, floor, ceil, abs, sqrt). Never do mental math.',
  bash: '- **bash**: Execute builds, tests, compilers, git commands, or runtime scripts in the workspace. Never use `bash` (`cat`, `nl`, `sed`, `awk`, `head`, `tail`, `grep`, `rg`) to read or search files; always use `read`, `grep`, `search`, or `outline` instead.',
  write: '- **write**: Create or overwrite a workspace file with complete content using the declared parameters in `# Tools`.',
  edit: '- **edit**: Replace exact text in a workspace file using the declared parameters in `# Tools`.',
  glob: '- **glob**: Match workspace files by glob pattern using the declared parameters in `# Tools`.',
});

/** Resolve a tool name to its TOOL_GUIDANCE key; strips a leading prefix (e.g. "raf_"). */
function resolveToolGuidanceKey(name: string): string | undefined {
  if (name in TOOL_GUIDANCE) return name;
  if (name.startsWith('raf_') || name.startsWith('ref_')) {
    const base = name.slice(4);
    if (base in TOOL_GUIDANCE) return base;
  }
  return undefined;
}

export function buildAgentSystemPrompt(toolNames: string[]): string {
  const resolved = new Map<string, string>();
  for (const name of toolNames) {
    const base = resolveToolGuidanceKey(name);
    if (base === undefined) continue;
    const existing = resolved.get(base);
    if (existing === undefined || (existing === base && name !== base)) resolved.set(base, name);
  }
  const lines: string[] = [];
  for (const [base, actual] of resolved) {
    const guidance = TOOL_GUIDANCE[base];
    if (guidance === undefined) continue;
    lines.push(actual === base ? guidance : guidance.replace(`- **${base}**`, `- **${actual}**`));
  }
  const hasBase = (key: string) => resolved.has(key);
  if (hasBase('llm_query') && (hasBase('grep') || hasBase('tally') || hasBase('search') || hasBase('outline'))) {
    lines.push(
      '- **Tool Routing Priority (Accuracy & Speed)**:',
      '  1. **0-Token Free Tools First (`search` / `grep` / `outline` / `tally`)**: If the target has literal words, names, numbers, citations, identifiers, or natural-language topics, ALWAYS use `grep`, `search`, `outline`, or `tally` first. NEVER use `llm_query` for literal/regex or BM25-searchable targets.',
      '  2. **Semantic Scan (`llm_query`)**: Use `llm_query` ONLY when no literal keyword/regex or BM25 window search applies (e.g. full-document abstract category classification with `<mode>extract</mode>` and `<categories>`, or after free search/grep tools return 0 matches).',
      ...(toolNames.includes('bash') || toolNames.includes('pwsh') || toolNames.includes('write') || toolNames.includes('edit')
        ? [
            '  3. **Workspace & Shell Tools (`bash` / `write` / `edit` / `glob`)**: Always use `read`, `grep`, `search`, `outline`, `tally`, and `branch` when reading or searching files and documents; never spawn `bash` (`cat`, `nl`, `sed`, `awk`, `head`, `tail`) to inspect text. Use `write` and `edit` for file changes, `glob` for path matching, and `bash` for builds, tests, git commands, and runtime scripts. Never emit `<answer>` while requested files, builds, or verifications are still incomplete.',
          ]
        : []),
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
    ? `### Current Step\nStep ${step}. ${step === 0 ? 'No history yet' : 'Previous step archived'}: output <motivation>...</motivation> and <tool_call name="...">...</tool_call> (or <answer>...</answer>). Do NOT output <folding>.`
    : `### Current Step\nStep ${step}. Output <folding range="${latest}-${latest}">...</folding> (range end MUST be ${latest}), <motivation>...</motivation>, then <tool_call name="...">...</tool_call> or <answer>...</answer>.`;

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
  `Re-emit the complete Step ${step} response using the exact required XML tags. ` +
  `Never put raw <folding>, <motivation>, or <tool_call> blocks inside <answer> (wrap literal tag names in backticks if citing code); close </answer> at the end.` +
  (latest === undefined
    ? ' (no unfolded interaction: do NOT output <folding>, not even an empty tag).'
    : ` (<folding range="${latest}-${latest}"> range end MUST be ${latest}; put plain-text summary inside <folding> and tool arguments inside <param>...</param> tags under <tool_call name="...">).`);
export const FORCE_ANSWER =
  'Step limit reached. Do not call any tool. Output your best final answer in <answer>...</answer> now (include <folding> as usual).';
