# @raf/pi-extension

Recursive AgentFold (RAF) as a [pi](https://github.com/earendil-works/pi) extension. When enabled, every root agent step is one native pi request: the AgentFold context replaces the transcript, the model answers it, and the engine folds the answer into a native tool call or the final answer. Branch specialists and the `llm_query` reader run inside the RAF tool call.

## Install

```
pi install ./packages/pi-extension
```

or add the local path to `~/.pi/agent/settings.json`:

```json
{ "packages": ["./packages/pi-extension"] }
```

The package imports `@raf/engine` from this workspace. Build it first: `pnpm --filter @raf/engine build`.

## Enable

- `ctrl+shift+r` — toggle RAF for the session
- `ctrl+shift+s` or `/raf` — settings
- `/raf on`, `/raf off`, `/raf status`
- `enabledByDefault: true` in `~/.pi/agent/raf.json` starts new sessions on RAF

The root model is the native pi selection (`/model`, `ctrl+p`). RAF never changes it. Only the subagent and reader tiers are configured here.

## How one RAF step maps to pi

| pi mechanism | RAF role |
|---|---|
| `before_agent_start` | build the turn: index the workspace, restore carried-over state, `engine.begin()` |
| `context_with_system` | replace the request with `C_t = (Q, T, S, I)` from `engine.prepareRootMessages()`; submit the previous native tool result and steering text into the fold state |
| native model request | the root AgentFold call on the `/model` selection, with its thinking level |
| `message_end` | `engine.next()` parses and folds; the message is replaced by a native `toolCall` (one RAF step) or the final answer |
| native tool pipeline | executes its tools (search, grep, read, tally, llm_query, branch, …) and bridged native tools (`bash`, `edit`, MCP tools) with normal approvals |
| custom entries | `raf-state` (fold state, board, documents) and `raf-run` (run totals) persist per branch point |

Because pi sends the request natively, token usage, cost, cache-read tokens, retries, aborts, and session recording stay native. The engine adds two things only: the folded context and the tools.

## Models

| Tier | Used by | Set where |
|---|---|---|
| root | root AgentFold steps | pi `/model` (native) |
| subagent | `branch` specialists | `/raf` → subagent model + thinking |
| llm | `llm_query` chunk reader | `/raf` → llm_query model (no thinking) |

An empty subagent or reader setting inherits the root model. Reader and branch calls go through pi's provider registry, so auth, base URLs, and custom providers all apply.

## UI

- **Header card** (startup, while enabled):
  ```
  RAF ctr+sh+S
  ◉ glm-5.3-flash:max /model
  ⑂ glm-5.3-flash:max /raf
  ⟂ glm-5.3
  ```
- **Live agent tree** (above the editor, while a run is active): spinner per agent, depth-first tree, current action, step, folds, per-agent cache hit, tokens; rate-limit countdown when the provider throttles.
- **Tool rows**: `branch` shows its specialist tree and reader scans; other RAF tools show a compact call header and expandable result.
- **Run entry** in the transcript: final status, steps, folds, cache rates, cost, duration; expand for the answer preview.

## Settings file

`~/.pi/agent/raf.json`:

```json
{
  "enabledByDefault": false,
  "depth": 2,
  "reserve": 0.3,
  "concurrency": 4,
  "branchModel": "zai-coding-cn/glm-5.3-flash",
  "branchThinking": "inherit",
  "readerModel": "zai-coding-cn/glm-5.3-flash",
  "deepStudy": false,
  "indexWorkspace": true
}
```

| Key | Effect |
|---|---|
| `depth` | max `branch` recursion (1–3) |
| `reserve` | reader window fraction kept free (0.10–0.50) |
| `concurrency` | parallel `llm_query` chunk calls (1–8) |
| `branchModel` / `branchThinking` | specialist tier |
| `readerModel` | `llm_query` tier |
| `deepStudy` | delegate repository-wide studies to scoped specialists |
| `indexWorkspace` | index workspace files into the context store at run start |

## Notes

- Turn state carries across runs: the fold state, research board, llm_query memo, and stored documents survive; a completed turn keeps external documents and drops branch reports.
- A native tool result over ~6k characters is indexed as a context-store document; `write`/`edit` results re-index the changed file.
- pi compaction is cancelled while a RAF turn is active; the engine keeps its own prompt under 60% of the root context window.
- When the root ends without an answer, saved specialist reports become the final report instead of an error.
