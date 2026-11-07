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

Internal model calls use the Session provider and model through `ctx.llm` by default, with optional 3-tier environment overrides (`RAF_ROOT_PROVIDER`/`RAF_ROOT_MODEL`, `RAF_BRANCH_PROVIDER`/`RAF_BRANCH_MODEL`, `RAF_QUERY_PROVIDER`/`RAF_QUERY_MODEL`). Root and reader calls use temperature 0. Root calls use a 16,000-token output budget and reader calls 16,384 tokens, matching `RAF_ROOT_MAX_OUTPUT` / `RAF_QUERY_MAX_OUTPUT`. Internal calls are tagged with an `AsyncLocalStorage` guard and a `raf-*` `purpose` value, so the listener does not intercept them again.

DSH marks internal calls with `purpose` (`session-title`, `compaction`, `auto-review`, `onboarding_use_case`). The listener passes every such call through. RAF therefore never answers a title prompt or a compaction summary.

### Native RAF rows

RAF does not write display-only session events. The native DSH loop writes them:

- the plugin streams the RAF model's reasoning deltas into the native assistant **text** as they arrive; the current thinking is visible without opening a reasoning disclosure;
- when the step settles, the same assistant message carries the tool-call block; the native tool pipeline appends `tool/call` and `tool/result`;
- Chat renders the visible reasoning text and the native tool rows, including the running `Deep diving` status;
- the native tool pipeline and session log remain the source of truth for tool rows;
- Trajectory and Statistics read the same native log.

The separate Live Dock and its `conversation.input.dock` panel are gone, and the conversation no longer adds a RAF tab. The sidebar RAF page keeps its **Inspector** tab for the detailed per-agent trace.

The client sets the Chat `ui-chat` work-details mode to `verbose` on load, so completed Turns keep their tool rows open. A saved profile value remains the fallback if the Chat settings form is unavailable.

`branch` (and legacy `raf_branch`) has its own native tool row: it lists every branch task (scope + instruction). Each task expands to that branch agent's live steps, tool calls, and results from the RAF run registry; when the registry is unavailable, the matching subtask result from the tool output is shown instead. The sidebar Inspector keeps the full agent tree. Start a new RAF run after a Host reload to populate the in-memory run registry.

### Diagnostic trace

The Host feeds engine `onEvent` records into the RAF run registry. The sidebar **Inspector** reads that registry:

- settings, steps, folds, tool calls and results, `llm_query` scans, per-call tokens/cache/latency, and the final answer;
- Chat, Trajectory, and Statistics read the native session log instead; the inspector never writes session events;
- a later RAF turn replaces the registry entry for the Session.

Limits of this integration:

- RAF's context tools operate on the `ContextStore`; DSH tools operate on the workspace. Both appear as native tool rows.
- Internal `branch` child steps and `llm_query` reader calls stay inside their parent native tool row. They are visible in the RAF inspector, not as separate Chat rows.
- DSH's synthetic user messages are context, not the question. The latest human message is the question.
- An answer cut by the output limit or an unclosed `<answer>` is rejected and retried with a shorter complete answer.
- The reader calls use the same model as the root with its default reasoning effort. The benchmark harness uses a separate non-thinking reader model; set that route before judging benchmark accuracy.

## Settings

The settings page writes `{ depth, reserve, concurrency }` to `localStorage` and posts them to the Host.

| Setting | Effect |
|---|---|
| Fold depth | `maxDepth` for recursive `branch` calls. |
| Reserve | `llmQuery.reserveRatio`. |
| Readers | `llmQuery.concurrency`. |

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
