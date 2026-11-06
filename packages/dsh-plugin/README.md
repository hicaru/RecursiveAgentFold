# @raf/dsh-plugin

DeepSeek Harness bundle for the Recursive AgentFold engine. It adds two surfaces and one runtime switch:

- A **RAF** entry in the left sidebar. It opens a compact settings page for fold depth, reserve, and reader concurrency.
- An **engine switch** in the composer tool row, after the permission control. It selects `Standard` or `RAF (Recursive AgentFold)` for the current Session.
- The Host half intercepts the main agent `llm/stream` call. When a Session is on RAF, it runs `@raf/engine` instead of the standard model call and returns the RAF answer as one normal assistant message. Internal DSH calls such as session titles, compaction, and reviews set `purpose` and stay on the standard path.

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

- The switch is **per Session**. The Host stores `{ [sessionId]: 'raf' }` in `~/.dsh/raf-engine/state.json`; absence means `standard`.
- The client calls the Host route `POST /plugins/@raf/dsh-plugin/engine` with `{ sessionId, engine, settings }`.
- The route is authenticated through the DSH connection service. The page's same-origin cookie admits it.
- The next model request in that Session runs RAF. The choice survives a restart. It is not written to the session log, so a fork starts on `Standard`.

## RAF execution

For a RAF Session, `llm/stream` builds a `ContextStore` from the Session transcript and runs `RecursiveAgentFold`:

- the latest **human** message (`source.kind === 'user'`) is the question;
- every other message — including DSH's synthetic instruction, runtime, skill, and time messages — is the document;
- RAF's `llm_query`, `grep`, `read`, `tally`, `branch`, and `calculator` operate on that transcript;
- DSH coding tools are exposed to RAF as `dsh_read`, `dsh_glob`, `dsh_grep`, `dsh_bash`, `dsh_write`, `dsh_edit`, `dsh_apply_patch`, `dsh_lsp`, `dsh_web_search`, and `dsh_web_fetch`;
- the final `<answer>` becomes one assistant message in DSH;
- RAF token usage is reported in the same message's usage chunk.

RAF runs inside one outer model request. Its internal model calls use the Session provider and model through `ctx.llm`. Root and reader calls use temperature 0. Root calls use a 16,000-token output budget and reader calls 4,096 tokens, matching `RAF_ROOT_MAX_OUTPUT` / `RAF_QUERY_MAX_OUTPUT`. Internal calls are tagged with an `AsyncLocalStorage` guard and a `raf-*` `purpose` value, so the listener does not intercept them again.

DSH marks internal calls with `purpose` (`session-title`, `compaction`, `auto-review`, `onboarding_use_case`). The listener passes every such call through. RAF therefore never answers a title prompt or a compaction summary.

### Inline RAF tool calls

RAF writes native Session events while it runs, so Chat and Trajectory show its work inline:

- each RAF tool call appends an assistant message with the agent label (`root`, `branch#1@1`) and the model's motivation, then a `tool-call` block;
- the matching result appends a native `tool/result` event, so the tool card expands normally;
- internal RAF tools (`read`, `grep`, `llm_query`, `branch`, `calculator`) and DSH tools (`dsh_read`, `dsh_bash`, and so on) use the same inline rows;
- subagent calls carry their `branch` label, so the root and every subagent show their own tools in order.

The events are synthetic: RAF already executed the tool, and the Host appends only the display records. The tool is not executed again. The separate live dock was removed; the **RAF** tab remains the detailed per-agent inspector.

### RAF runs view

The plugin registers a dedicated **RAF** tab in the conversation view ring, between Trajectory and Statistics. It reads the Host run registry and polls while a run is active.

- Left column: every agent in the run. RAF `branch` subagents appear as nested agents; click one to inspect only its steps and tools.
- Main column: the selected agent's steps. Each step shows context size, blocks, the model response/reasoning, folds, tool calls and results, `llm_query` scans, per-call LLM tokens/cache/latency, errors, and the final answer.
- Tool rows expand to show arguments and result text. A `branch` tool links to its subagent.
- Header: run selector, live status, model, settings, steps, agents, tokens, cache hit rate, and duration.
- New runs appear automatically; completed runs remain selectable. The Host keeps the latest 30 runs in memory, so a Host restart clears the list.

The view shows both RAF's context tools (`llm_query`, `grep`, `read`, `tally`, `branch`, `calculator`) and the `dsh_*` DSH tools. RAF branch agents are engine subagents; the DSH `subagent` tool is not exposed.

The Host exposes the run data at `GET /plugins/@raf/dsh-plugin/runs?sessionId=...` and `GET /plugins/@raf/dsh-plugin/runs/<id>`.

### Trajectory trace

The runner also writes a compact diagnostic trace into the assistant message's **reasoning** block:

- Open **Trajectory**, select the assistant record, and read **Thinking**.
- The trace lists settings, steps, folds, tool calls and results, `llm_query` scans, per-call tokens/cache/latency, and the final answer.
- **Statistics** shows the run as one outer step with aggregate usage.

The trace is capped at 12,000 characters and is skipped when a later RAF run rebuilds its transcript.

Limits of this first integration:

- RAF's own `read`/`grep` tools scan the transcript. The `dsh_*` tools run the real DSH tools, with the normal approval policy.
- DSH tool calls from RAF are shown in the RAF view. They are not native session `tool/call` events, so Chat and Trajectory do not render them as tool rows; a custom Agent driver is required for that.
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
| `conversation.view` | `raf-runs` | RAF run inspector tab. |

## Install

```
plugin_manager install_bundle packages/dsh-plugin
```

After a Host-half edit, disable and re-enable the `include:raf-engine` row (or restart the Harness) to load the new module. Client-half edits reload through HMR.
