# @raf/dsh-plugin

Web UI plugin for the DeepSeek Harness. It adds two surfaces:

- A **RAF** entry in the left sidebar panel list. The entry opens a compact settings page: fold depth, reserve, readers, and cache layout. The page does not switch engines.
- An **engine switch** in the composer tool row, right after the permission control. It selects `Standard` (DSH contextFold) or `RAF (Recursive AgentFold)`.

## Layout

```
packages/dsh-plugin/
  package.json          bundle manifest (dsh.bundle + dsh.client)
  cordis.patch.yml      inserts the raf-engine host row
  index.js              host half (no host-side behavior yet)
  client.js             browser half: sidebar icon, panel, composer switch, popover menu
  locale/en.json        Plugin Manager metadata
  locale/ru.json        Plugin Manager metadata
  icon.svg              original artwork for Plugin Manager
```

## Slots

| Slot | Id | Purpose |
|---|---|---|
| `main` | `raf` | Full settings page. |
| `sidebar.panellist` | `raf` | Sidebar entry and icon. |
| `conversation.input.left` | `raf-engine` | Composer engine switch. |
| `shell.overlay` | `raf-engine-menu` | Fixed engine menu above the composer. |

## State

The browser half stores `{ engine, depth, reserve, concurrency, cacheLayout }` in `localStorage` under `raf.dsh.settings.v1`. Components share one store, so the panel and the composer switch stay in sync. The engine choice is currently a UI preference; routing it into the RAF runtime is the next step.

## Install

Install this directory as a profile bundle:

```
plugin_manager install_bundle packages/dsh-plugin
```

Then refresh the Harness page if the plugin does not appear through HMR.
