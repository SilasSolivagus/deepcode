---
title: Commands reference
---
# Commands reference

Every slash command the interactive TUI accepts. For day-to-day usage and keybindings see
[Commands & keys](/en/usage/commands); this page is the **full list**.

::: tip The menu isn't everything
Typing `/` pops a menu with 33 entries, but **50 commands actually work** — the other 17 aren't
registered in the menu and are only discoverable here. They're marked 🔍 below.
:::

## Model & thinking

| Command | What it does |
|---|---|
| `/model` | Toggle flash ↔ pro; `/model <name>` picks one directly |
| `/think` | Toggle thinking mode |
| `/setup` | Reconfigure API keys (model / search / image recognition) |
| 🔍 `/output-style` | Switch output style |
| 🔍 `/theme` | Switch color theme |

## Permission modes

| Command | What it does |
|---|---|
| `/accept` | Toggle `acceptEdits` |
| 🔍 `/plan` | Enter / leave plan mode (read-only). **Leaving restores the mode you were in**, not `default` |
| 🔍 `/dontask` | Toggle `dontAsk`: reads allowed, anything needing approval is auto-denied without a prompt |
| 🔍 `/cycle-mode` | Cycle permission modes — same as Shift+Tab |

::: warning None of these do anything under yolo
Started with `--yolo`, `/plan` and `/dontask` print "everything is already allowed" and change no
state.
:::

Full semantics: [Permissions](/en/usage/permissions).

## Session & history

| Command | What it does |
|---|---|
| `/clear` | Clear the conversation |
| `/compact` | Compact history manually |
| `/resume` | Resume a past session |
| `/fork` | Fork a new session from here |
| `/rename` | Name the current session |
| `/export` | Export the conversation to markdown |
| `/recap` | One-line recap of the current session |
| `/goal` | Set / show / clear a session-level stop goal |
| 🔍 `/rewind` | Rewind to a checkpoint |

## Cost & status

| Command | What it does |
|---|---|
| `/cost` | Spend breakdown for this session |
| `/context` | Context usage |
| `/stats` | Session statistics |
| `/status` | Session overview (version / model / mode / tool count) |
| `/diff` | Show uncommitted git changes |
| `/copy` | Copy a reply to the clipboard; `/copy N` for the Nth from the end, `/copy code` for the last code block |

## Memory

| Command | What it does |
|---|---|
| `/memory` | Show the memory files in effect |
| 🔍 `/pause-memory` | Pause memory extraction for this session. **`/memory-pause` and `/toggle-memory` are aliases of the same command** |
| `/init` | Generate `DEEPCODE.md` |

## Background & automation

| Command | What it does |
|---|---|
| 🔍 `/background`, `/bg` | Hand the current task to a background session |
| 🔍 `/stop` | With no argument: list running background sessions. `/stop <id>` stops one |
| 🔍 `/loop` | Create a recurring task; `/loop <cron> <task>` schedules it and runs the first round immediately |
| `/workflows` | Workflow run history |

## Ecosystem & extensions

| Command | What it does |
|---|---|
| `/skills` | List available skills |
| 🔍 `/reload-skills` | Reload skills and rebuild the system prompt (no restart needed after editing skill files) |
| `/mcp` | Show configured MCP servers |
| `/hooks` | Show configured hooks |
| `/permissions` | Manage permission rules |
| `/config` | Show merged config with per-key provenance |

## Environment & diagnostics

| Command | What it does |
|---|---|
| 🔍 `/cd` | Change working directory; with no argument it prints the current one plus usage |
| `/doctor` | Diagnose installation / config / connectivity |
| `/update` | Check for and install the latest version |
| `/keybindings` | Show keybindings |
| `/tui` | Switch renderer (inline / fullscreen) |
| `/focus` | Toggle focus view (collapse tool output, fullscreen only) |
| `/help` | Help |
| `/exit` | Quit |

## Non-slash input prefixes

| Prefix | What it does |
|---|---|
| `@<path>` | Reference a file, with completion |
| `!<command>` | Run a shell command directly, bypassing the model |
| `/` | Pop the command menu |

## Keyboard-only operations

| Action | Key |
|---|---|
| Cycle permission modes | `Shift+Tab` (or `/cycle-mode`) |
| Interrupt the current turn | `Esc` — you can steer mid-turn, no need to wait it out |
| Quit | `Ctrl+C` twice |

::: info auto mode has no command of its own
You reach auto mode only by cycling with `Shift+Tab` or `/cycle-mode`. **There is no `/auto`.**
:::

## Where these come from

The 33 menu entries live in `BUILTIN_COMMANDS` in `src/tui/suggest.ts`. The 🔍 ones are handled
directly in `src/tui/useChat.ts` and the two renderer components without being registered in the
menu. **This page follows what actually works.**
