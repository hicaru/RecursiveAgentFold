# @raf/dsh-plugin

DeepSeek Harness bundle for the Recursive AgentFold engine. It adds two surfaces and one runtime switch:

- A **RAF** entry in the left sidebar. It opens a compact settings page for fold depth, reserve, and reader concurrency.
- An **engine switch** in the composer tool row, after the permission control. It selects `Standard` or `RAF (Recursive AgentFold)` for the current Session.
- The Host half intercepts `llm/stream`. When a Session is on RAF, it runs `@raf/engine` instead of the standard model call and returns the RAF answer as one normal assistant message.

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

- the latest user message is the question;
- earlier user, assistant, and tool-result messages are the document;
- `llm_query`, `grep`, `read`, `tally`, `branch`, and `calculator` operate on that transcript;
- the final `<answer>` becomes one assistant message in DSH;
- RAF token usage is reported in the same message's usage chunk.

RAF runs inside one outer model request. Its internal model calls use the Session provider and model through `ctx.llm`. Internal calls are tagged with an `AsyncLocalStorage` guard so the listener does not intercept them again.

Limits of this first integration:

- RAF does not see DSH tools (`bash`, `edit`, `read` paths, and so on). Use `Standard` for coding tool work.
- RAF steps are not in the session log. Fork and replay keep only the final answer.
- A context document should be in earlier messages; the latest user message is the question.
- The reader calls use the same model as the root with its default reasoning effort.

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

## Install

```
plugin_manager install_bundle packages/dsh-plugin
```

After a Host-half edit, disable and re-enable the `include:raf-engine` row (or restart the Harness) to load the new module. Client-half edits reload through HMR.
