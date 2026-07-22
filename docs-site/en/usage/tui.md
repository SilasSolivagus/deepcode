---
title: Interactive TUI
---

# Interactive TUI

By default deepcode launches into an interactive terminal UI (TUI). This page covers how to pick a renderer and view mode, what each part of the status bar means, the core key bindings, and what one full interaction turn looks like.

## Two renderers: inline / fullscreen

The `tui` field in `settings.json` accepts only two values: `"inline"` or `"fullscreen"`. If it's unset, a decision chain runs, and the default outcome is **fullscreen**:

1. Background session (`/background`) → always `fullscreen`.
2. Non-interactive terminal (no TTY, e.g. a pipe/CI) → `headless`, never enters the TUI.
3. `--inline` passed on the command line → `inline`.
4. `settings.tui` is set → use that value directly.
5. Legacy field `settings.inline === true` (backward compat) → `inline`.
6. None of the above → default `fullscreen`.

To pin one renderer permanently, set `tui` directly:

```jsonc
// ~/.deepcode/settings.json
{ "tui": "inline" }
```

Or pass `--inline` for a single run without touching the config file. Both renderers share the same main loop, tools, and permission system — the only difference is terminal presentation: fullscreen is an alt-screen full view with scrollable history, inline is plain sequential terminal output.

## View mode: default / focus

The `viewMode` field accepts `"default"` or `"focus"`. Set to `"focus"`, the focus view opens on startup and is **locked** — detailed tool-call output is collapsed, leaving only the conclusions for a cleaner screen; while locked, it cannot be toggled off with a command.

```jsonc
// ~/.deepcode/settings.json
{ "viewMode": "focus" }
```

Two related commands:

- **`/tui <inline|fullscreen>`** — switches the renderer. Writes the new value to `settings.tui` and restarts the child process once; the current session history is restored as-is, only the presentation changes.
- **`/focus`** — toggles the focus view on/off. Only available under the fullscreen renderer; if locked by `viewMode: "focus"`, `/focus` has no effect and tells you to remove that field from `settings.json` and restart.

::: tip
`/focus` won't open under the inline renderer — run `/tui fullscreen` first (which restarts and restores the session), then use `/focus`.
:::

## Reading the status bar

A multi-line status bar sits below the input box. From top to bottom, in clusters:

**Row 1 — model / mode / directory**

```
[deepseek-v4-pro | acceptEdits | think:medium] | my-project git:(main)
```

Inside the brackets: current model, permission mode (`default`/`acceptEdits`/`plan`/`auto`/`dontAsk`/`yolo`, see [permission modes](/en/usage/permissions)), and the thinking effort level appended when thinking is on. Outside the brackets: the current directory name and git branch (if any). When the focus view is on, a `· focus` badge is appended at the end of the line.

**Row 2 — context / cache / cost**

```
Context 12k / 971k [██░░░░░░░░] · cache 62% (−¥0.0180) · ¥0.0320
```

- `Context used/window` plus a 10-cell mini progress bar: it turns red at ≥95% usage, yellow at ≥80%, and the theme accent color otherwise.
- `cache N% (−¥x)` only appears when this turn hit the prefix cache (hitRate > 0), showing hit rate and money saved.
- A `budget used/target` segment is inserted when a token budget is configured.
- The trailing `¥cost` is the cumulative session spend, and changes color once it reaches the `costWarnCNY` threshold.
- If a custom `statusLineCommand` is configured, its stdout is appended as a separate line under this cluster.

**Row 3 cluster — memory / tool counts / hint**

```
3 DEEPCODE.md
✓ Bash ×8 | ✓ Read ×4 | ✓ Edit ×2
/ commands · @ reference a file · ! run shell
```

The number of `DEEPCODE.md` instruction files in effect (shown only if > 0), a per-name count of tools successfully run this session (shown only if any), and a hint line that's always present.

## Core key bindings

The bindings below come from the built-in `/keybindings` command — run `/keybindings` in the TUI anytime to see them:

| Group | Key | Behavior |
| --- | --- | --- |
| Input | `Esc` | While generating: interrupt the current turn. While idle: clear the input box |
| Input | `Enter` | Submit (the completion menu takes over `Enter` when open) |
| Input | trailing `\` + `Enter` | Continue the line, accumulating multi-line input |
| Input | `↑` / `↓` | Browse input history (the completion menu takes over arrow keys when open) |
| Input | `Backspace` / `Delete` | Delete a character |
| Input | `Tab` | Navigate/confirm in the completion menu |
| Scroll (fullscreen only) | `PageUp` / `PageDown` | Scroll history up/down a page |
| Scroll (fullscreen only) | `Ctrl+G` | Jump to bottom and resume auto-follow |
| Scroll | Mouse / trackpad wheel | Scroll up/down |
| Exit | `Ctrl+C` ×2 (within 2s) | Exit (waits for memory to flush first) |
| Trigger | `/` | Open the slash command menu |
| Trigger | `@` | Open the file reference menu |
| Trigger | `!` | Run a shell command directly |
| Selection | `Shift` + drag | Native terminal text selection (the wheel is captured by the app, so `Shift` is needed to reach the system selection) |

Two more bindings aren't in `/keybindings`, but are confirmed in source:

- **`Shift+Tab`** — cycles the permission mode (`default → auto → acceptEdits → plan → dontAsk → default`), see [permission modes](/en/usage/permissions). If your terminal doesn't recognize `Shift+Tab`, fall back to the `/plan`, `/accept`, `/dontask` commands.
- **Double-tap `Esc`** (within 600ms, only while idle and the input box is empty) — opens the `/rewind` selection screen.

## What one interaction turn looks like

Once you're in the TUI, just describe the task — deepcode plans, calls tools, and runs the tests itself, then settles with one cost line at the end:

```
› add unit tests for utils and make them pass

  Grep  search for utils-related files
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  Added unit tests for the 4 functions in utils.ts, npm test passes (12 passed).

  ¥0.03 · 3 turns · 8.2k tokens
```

Press `Esc` anytime during generation to interrupt, or just type and hit `Enter` — it queues as the next steering input; if a tool call is in flight at that moment, it also attaches a soft interrupt automatically.

---

Next: [Commands and shortcuts](/en/usage/commands), [Permission modes](/en/usage/permissions).
