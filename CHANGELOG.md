# Changelog

## 2026-11-14 — Session bug fixes (B1–B36, PI-*, P-B*)

Fixes for failures observed in production RAF sessions (`docs/RAF_SESSION_BUGS.md`, Pi sessions
`01a1d561`, `01a1d10c`). Verified with `pnpm typecheck && pnpm test && pnpm build` (183 tests) and
live Z.ai runs (`prompt-check` PASS; `needle --method dsh` 2/2; `codegraph --method raf` 1/1).

### Engine (`@raf/engine`)

- **Strict XML protocol parsing (B1, B2, B5, B6, PI-2)**: reject unclosed `<parameter>` /
  multiline-preserve tags with `FORMAT_REPAIR` errors instead of concatenating values; bound
  unclosed scalar parameters at the next parameter or `</tool_call>` boundary; reject unescaped
  protocol markup (require `<![CDATA[...]]>` or `&lt;/tag&gt;`), duplicate scalar parameters, and
  `<param_name>` placeholders; preserve single-tag external tool arguments (`TaskGet`, `google_search`)
  and custom key-value keys; restrict bare scalar shorthand to single-line values without trailing
  line ranges.
- **Pre-execution schema validation (B13)**: new `validateToolArguments` checks required keys,
  declared property types, and unknown keys before leaving `AgentFoldAgent.next()`; alias resolution
  maps snake_case ↔ camelCase keys onto the tool schema; rendered step history escapes XML.
- **Nested `<branch>`/`<tasks>` dispatch (P-B2, PI-1)**: depth-counting XML tag matching unpacks
  `<task><tasks><task .../></tasks></task>` and JSON/XML strings inside `task`; `cwd` per subtask
  (`CWD_KEYS`) with directory-scope fallback; canonical fallback scopes capped at 64 chars (P-B3).
- **Step budget ceiling (P-B5, BUG-PI-01)**: caller `max_steps` honored up to
  `DEFAULT_BRANCH_MAX_STEPS_CAP = 100` instead of clamping to the default 30.
- **Subagent `cwd` (P-B4, BUG-PI-02)**: `ToolContext.cwd`, `BranchRunnerOptions.cwd`, and
  `AgentFoldConfig.cwd` thread working directories through specialists.
- **Canonical `ContextStore` dedup (B4, B9, B17, B26, BUG-PI-07)**: dedup by canonical `realpath`
  `absPath`, prefer the shorter workspace-relative ID, drop `file_*`/`tool_*` ids; workspace-root
  and subdirectory ingestion reuse existing ids; `resolveIds('.', cwd)` resolves to manifest docs.
- **Unicode-safe ingestion & PDF fallback (BUG-PI-05, BUG-PI-03)**: Unicode-aware prompt path
  extraction (full Cyrillic paths), excluded home/system directories, `HostFileSystem` seam, and
  `convertPdfFallback` (`pdftotext`, macOS PDFKit via osascript, python3 `pypdf`/`fitz`).
- **Document tool hygiene (B7, B10–B12, B14, B18)**: `grep` supports `literal`, `glob`, and
  `context`; zero-count documents filtered and matches printed before the per-doc breakdown; line
  counts match `wc -l` (no trailing empty line, no long-line splitting); bounded `Unknown document`
  errors with closest-ID hints and `[+N chars]` truncation markers; Cyrillic token estimation at
  1.8 chars/token.
- **Cache stability & folding (B3, BUG-PI-01/02)**: `ChatAttachment` carrier on `ChatMessage`;
  4-zone prompt keeps `zone1`/`zone2` append-only, moves mutable deltas to `zone3b`, keeps
  `zone3a` for the static follow-up question only; bounded Zone 1 manifest (`maxManifestTokens`),
  epoch folding (`maxGranularBlocks`), live `tokenScale` calibration from provider usage, dropped
  batched-call notice in observations, `systemPromptAddendum` and `initialAttachments` in
  `RootBeginOptions`; `renderSince` no longer leaks stale in-progress board entries; failed
  specialists retain partial folded state.

### Pi extension (`@raf/pi-extension`)

- **Cache-block detection**: wire-capability check (`compat.cacheControlFormat === 'anthropic'`)
  replaces hardcoded model-name matching; 1-segment user messages keep block-array content;
  `ttl: '1h'` cache markers are preserved.
- **Retry usage (BUG-PI-02)**: `acceptResponse` reports the final attempt's token footprint while
  summing cost across retries, stopping false cache-miss and compaction triggers.
- **Idle `CacheWarmer`**: `SessionState.decorateCachedPayload` replays the 4-zone breakpoints after
  the turn settles.
- **Compact inline state (< 64 KB)**: frozen Zone 1 state (`initialManifest`, `initialDocIds`,
  `initialDocRevs`, `initialBoardSnapshot`, `initialBoardRev`, `sources`) persists in `raf-state`;
  disk-backed workspace/prompt files and `tool_*` outputs stay out of `.jsonl` (`persist: false`,
  caps 24 docs / 48,000 chars); deleted sources are skipped on resume.
- **RAF-native compaction**: `buildCompactionSummary` returns a 0-LLM-call summary for `threshold`,
  `overflow`, and `manual` compactions instead of canceling them.
- **Host pass-through**: `event.images` and `systemPromptOptions` sections (`project_context`,
  `skills`, `addendum`) flow into the root agent; shadowed `read` refreshes the `ContextStore` so
  follow-up tools find the file; snake_case ↔ camelCase argument fitting; subagent `cwd` rebasing
  for `write`/`edit`/`read`/`ls`/`find`/`glob`/`bash`.

### DSH plugin (`@raf/dsh-plugin`)

- **Parallel batches (B3)**: all `<tool_call>` blocks in one step are emitted and executed;
  `pendingCallIds`/`pendingActions` collect per-call observations.
- **Tool-result indexing (B8, B9, B15, B19, B26, B27)**: `read` results are no longer snapshotted as
  `file_read_*` documents; write/edit re-read via `ctx.get('fs')` and reuse the canonical absPath id;
  web results are transient and non-manifest; doc ids keep 96 leading chars plus a sha256 suffix;
  fold summaries appear in visible reasoning and `agent.session.appendCustom`; batch results include
  `additionalContexts`, `concluded`, and `meta`.
- **Host contract (B20–B25, B28–B36)**: `isAgentLoopRequest` probe from `@deepseek-ai/dsh-llm` gates
  `llm/stream` (heuristic fallback for mock hosts); `image`/`file` blocks reach the model via
  `ChatAttachment`; DSH system prompt plus `agent-instructions`/`skill-catalog` messages are passed
  as `systemPromptAddendum`; `ResolvedToolSet` is resolved per batch and disposed; private
  `selectExecutor`/`pipeline.constructor` patching removed (PTC lockout recovers via
  `PTC_LOCKOUT_RE` fallback); compaction wrapper restores the original descriptor from a `WeakMap`;
  `isSeeded` forks clone the parent session state; context window prefers `llm.resolveModelInfo`;
  aborts yield `{ kind: 'aborted' }`; retries honor `llm.retryPolicy.maxAttempts` and are logged;
  `admissionRejection` fails closed with 403; session state persistence is async and atomic with
  `persist: false` for disk files; `"engines": { "dsh": ">=0.2.2-rc.0" }` declared.

### Benchmarks (`@raf/benchmarks`)

- Mock host marks `_isRafMockHost`, executes multi-tool batches per step, and lets the plugin's PTC
  fallback recover lockout results; new `packages/benchmarks/test/dsh-plugin.test.ts` covers batched
  reads, `file_read_*` absence, image/instruction/cacheControl pass-through, toolSet dispose,
  `isSeeded` clone, abort stream, and 403 admission.
