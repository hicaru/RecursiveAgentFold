# @raf/dsh-plugin

DeepSeek Harness bundle for the Recursive AgentFold engine. It adds two surfaces and one runtime switch:

- A **RAF** entry in the left sidebar. It opens a compact settings page for fold depth, reserve, and reader concurrency.
- An **engine switch** in the composer tool row, after the permission control. It selects `Standard` or `RAF (Recursive AgentFold)` for the current Session.
- The Host half intercepts the main agent `llm/stream` call. When a Session is on RAF, it returns **one RAF step per call** (reasoning + one tool call, or the final answer). The native DSH loop owns turn/step framing, tool execution, approvals, and session events, so Chat and Trajectory render RAF work as native rows. Internal DSH calls such as session titles, compaction, and reviews set `purpose` and stay on the standard path.

## Layout

```
packages/dsh-plugin/
  package.json          bundle manifest (dsh.bundle + dsh.client)
  cordis.patch.yml      inserts the raf-engine host row
  index.js              host half: state route, RAF runner, DSH LLM adapter
  client.js             browser half: sidebar icon, settings page, composer switch
  locale/en.json        Plugin Manager metadata
  locale/ru.json        Plugin Manager metadata
  icon.svg              original artwork for Plugin Manager
```

The Host imports `../engine/dist/index.js`. Build the engine before installing or editing the plugin:

```
pnpm --filter @raf/engine build
```

A profile links this checkout, so the relative import resolves. A packed copy of `dsh-plugin` alone does not carry the engine dist.

## Engine switch

- The switch is **per Session**. The Host stores each Session's choice and a default in `~/.dsh/raf-engine/state.json`; a Session without an entry uses the default.
- The client calls the Host route `POST /plugins/@raf/dsh-plugin/engine` with `{ sessionId, engine, settings }`.
- The route is authenticated through the DSH connection service. The page's same-origin cookie admits it.
- The next model request in that Session runs RAF. The choice survives a restart. It is not written to the session log, so a fork with no entry starts on the default.

The switch also stores the last selection as the default for new Sessions:

- the Host persists `defaultEngine` next to the per-Session map in `~/.dsh/raf-engine/state.json`;
- a Session without an entry uses `defaultEngine`;
- selecting RAF makes the next new Session start on RAF; selecting Standard makes it start on Standard;
- an old state file without `defaultEngine` gets RAF when at least one Session is already on RAF.

## RAF execution

For a RAF Session, the plugin builds a `ContextStore` from the Session transcript and drives `@raf/engine` one step at a time:

- the latest **human** message (`source.kind === 'user'`) is the question;
- every other message — including DSH's synthetic instruction, runtime, skill, and time messages — is the document, along with pre-indexed workspace files;
- RAF's context tools are registered as native unprefixed DSH tools: `search`, `outline`, `grep`, `read`, `tally`, `llm_query`, `branch`, `calculator`, `add_document`, and `list_documents`;
- every DSH tool visible to the Session agent is bridged to RAF, including third-party plugin tools (for example a custom web-search API). In RAF mode, the native `read` and `grep` tools are overridden on the agent's tool scope by RAF's `read` and `grep` (which accept standard `file_path`, `path`, `offset`, `limit` parameters and auto-ingest workspace files into `ContextStore` on demand), while competing native sub-agent tools (`subagent`, `workflow`, `ralph`, etc.) are suppressed in favor of `branch`. Other DSH tools keep their native names and execute through the normal DSH pipeline, including approvals and plugin configuration;
- each `llm/stream` call returns one RAF step: live reasoning text followed by one `tool-call` block, or the final text;
- the native loop writes `step/start`, `assistant/message`, `tool/call`, `tool/result`, and `step/end` itself;
- RAF token usage is attached to each native assistant message.

The engine exposes `begin(question)`, `next()`, and `submit(observation)`. `next()` returns a tool action without executing it, so the native loop executes the tool and the next `next()` receives the observation. `AgentFoldAgent.run()` is the same loop with in-process tool execution, so CLI and benchmark behavior is unchanged.

Root calls always use the Session provider and model through `ctx.llm`; RAF does not override the native root model. Branch and reader routes come from the settings panel: branch has a provider, model, and optional reasoning effort; `llm_query` has a provider and model and never sends a reasoning effort. Deployment can still override `RAF_BRANCH_PROVIDER`/`RAF_BRANCH_MODEL` and `RAF_QUERY_PROVIDER`/`RAF_QUERY_MODEL`; root and reader calls use temperature 0. Root calls use a 16,000-token output budget and reader calls 16,384 tokens, matching `RAF_ROOT_MAX_OUTPUT` / `RAF_QUERY_MAX_OUTPUT`. The root has a 100-step cap, a 10-minute per-step budget, and a 3-invalid-response cap. A step reports only its last LLM attempt to the DSH token meter, so retries and branch sub-agents do not look like one huge prompt. Internal calls are tagged with an `AsyncLocalStorage` guard and a `raf-*` `purpose` value, so the listener does not intercept them again.

DSH marks internal calls with `purpose` (`session-title`, `compaction`, `auto-review`, `onboarding_use_case`). The listener passes every such call through. RAF therefore never answers a title prompt or a compaction summary.

### Deep-study protocol (opt-in)

When `Deep-study protocol` is enabled in the RAF settings, and the user asks to study, explore, or deeply investigate the project/repository, the Host appends a dynamic study brief to the RAF question. The brief is built from the loaded workspace scopes (`packages/*`, `docs`, `results`, `scripts`) and is only added when at least two scopes exist. The setting is off by default.

The brief mirrors the task prompts that drive the benchmarks:

- the codegraph tasks explicitly say to delegate module research to scoped specialists; the best run (`verify-codegraph-d2`) scored 6/6 with 71 `branch` calls;
- the oolong aggregate tasks force `llm_query` scanning; the best run (`verify-oolong-d2`) scored 5/5 with 18 reader calls;
- the prompt-check probes name the required tool for every probe; the best run scored 10/10.

The brief therefore says: this is a repository-wide study, not a docs-only summary; cover implementation, tests, benchmarks/results, docs, and risks; if `branch` is available, delegate each scope with `branch(tasks=[{scope, task}, ...])` and synthesize the reports; use `outline`/`search`/`grep`/`tally` for exact code and facts, `llm_query` for long documents that need semantic scanning, and `read` only for targeted verification windows; do not read every file serially in root. Scopes are discovered from the manifest at run start, so the protocol stays model- and benchmark-agnostic.

### Native RAF rows

RAF does not write display-only session events. The native DSH loop writes them:

- the plugin streams the RAF model's reasoning deltas as a native **reasoning block**; protocol tags and placeholders are removed, so reasoning never looks like a tool call or an answer; the actual tool-call blocks stay separate;
- when the step settles, the same assistant message carries the tool-call block; the native tool pipeline appends `tool/call` and `tool/result`;
- Chat renders the visible reasoning text and the native tool rows, including the running `Deep diving` status;
- the native tool pipeline and session log remain the source of truth for tool rows;
- Trajectory and Statistics read the same native log.

The separate Live Dock and its `conversation.input.dock` panel are gone, and the conversation no longer adds a RAF tab. The sidebar RAF page is settings-only; the Inspector tab and its agent tree were removed.

The client sets the Chat `ui-chat` work-details mode to `verbose` on load, so completed Turns keep their tool rows open. A saved profile value remains the fallback if the Chat settings form is unavailable.

`branch` (and legacy `raf_branch`) has its own native tool row: it lists every branch task (scope + instruction). Each task expands to that branch agent's live steps, reasoning, tool calls, queries, and results from the RAF run registry. A nested `branch` call renders a nested task tree, and an `llm_query` call renders its reader details in the same task. Start a new RAF run after a Host reload to populate the in-memory run registry; without it the card falls back to the matching subtask results.

### Run registry

The Host feeds engine `onEvent` records into the RAF run registry. The branch card reads that registry to render child and nested specialist steps:

- steps, folds, tool calls and results, `llm_query` scans, per-call tokens/cache/latency, and the final answer;
- Chat, Trajectory, and Statistics read the native session log; the registry never writes session events;
- a later RAF turn replaces the registry entry for the Session.

### Branch reports and state

`branch(tasks=[...])` stores every full subtask report in `ContextStore` under a `branch_report_*` document. The root receives a compact index with every subtask header and a short excerpt, so it can `read` or `outline` the full report later. These report documents are hidden from the model manifest; they do not change the cached prompt prefix. The Host persists the root fold state, the initial question/manifest/doc IDs, and these branch reports under `~/.dsh/raf-engine/sessions/<sessionId>.json`. A turn that is aborted or a Host that restarts can resume from that state. If no state file exists, the Host adds the latest DSH compaction checkpoint to the next task.

Limits of this integration:

- RAF's context tools operate on the `ContextStore`; DSH tools operate on the workspace. Both appear as native tool rows.
- Internal `branch` child steps and `llm_query` reader calls stay inside their parent native tool row; the recursive branch card expands them instead of adding separate Chat rows.
- DSH's synthetic user messages are context, not the question. The latest human message is the question.
- An answer cut by the output limit or an unclosed `<answer>` is rejected and retried with a shorter complete answer.
- `llm_query` uses the configured reader model with no reasoning effort. The benchmark harness may use a separate non-thinking reader model; select it in Reader model before judging benchmark accuracy.

## Settings

The settings page writes `{ depth, reserve, concurrency, branchProvider, branchModel, branchReasoningEffort, queryProvider, queryModel, deepStudy }` to `localStorage` and posts them to the Host. The model lists come from `GET /plugins/@raf/dsh-plugin/models`, which reads the DSH provider catalog and each model's advertised reasoning efforts.

| Setting | Effect |
|---|---|
| Fold depth | `maxDepth` for recursive `branch` calls. |
| Reserve | `llmQuery.reserveRatio`. |
| Readers | `llmQuery.concurrency`. |
| Branch model | Provider and model for scoped specialist sub-agents. |
| Reasoning effort | Optional branch-only effort. Model default uses the provider default. |
| Reader model | Provider and model for `llm_query`. No reasoning effort is sent. |
| Deep-study protocol | Opt-in branch plan for repository-study requests. Off by default. |

The root model is not configurable here. Root calls use the native DSH Session provider and model.

## Slots

| Slot | Id | Purpose |
|---|---|---|
| `main` | `raf` | Settings page. |
| `sidebar.panellist` | `raf` | Sidebar entry and icon. |
| `conversation.input.left` | `raf-engine` | Composer engine switch. |
| `shell.overlay` | `raf-engine-menu` | Fixed engine menu above the composer. |
| `tool.call.toolview` | `branch` (`raf_branch`) | Native `branch` tool row. |

## Install

```
plugin_manager install_bundle packages/dsh-plugin
```

After a Host-half edit, disable and re-enable the `include:raf-engine` row (or restart the Harness) to load the new module. Client-half edits reload through HMR.
