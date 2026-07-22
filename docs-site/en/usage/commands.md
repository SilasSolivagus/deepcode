---
title: Commands & keys
---
# Commands & keys

In the interactive TUI, slash commands, file references, and keybindings are the main way you drive things. This page covers the high-frequency ones; for the complete list see [Reference / Commands](/en/reference/commands).

## How commands work

Type `/` in the input box and a command menu pops up, fuzzy-matched and ranked live against name and description. `↑` / `↓` move the selection, `Tab` or `Enter` confirms. Three trigger prefixes are supported:

- `/` — the slash command menu (built-in commands + custom commands + invocable skills)
- `@` — a file-reference menu that completes paths under the current directory
- `!` — runs a shell command directly, without entering it into the conversation history

Custom commands live in `~/.deepcode/commands/*.md` (global) or `<project>/.deepcode/commands/*.md` (project-level). `$ARGUMENTS` inside the command body is replaced with whatever follows the command name, and custom commands show up in the `/` menu alongside built-ins.

## High-frequency commands

### Model & thinking

- `/model` — with no argument, opens the model picker; `/model <name>` switches directly. Switching within the same provider applies instantly; switching providers restarts the process automatically and restores the current session.
- `/think` — toggles thinking mode on/off.
- `/effort low|medium|high|off` — adjusts the thinking effort level.

### Permission mode

- `/plan` — read-only exploration plus a written plan; writes go through `ExitPlanMode` for user approval.
- `/accept` — toggles acceptEdits mode: Edit/Write run without confirmation, Bash still confirms.
- `/dontask` — dontAsk mode: reads are allowed, writes are auto-denied, no confirmation prompt either way.

`/plan`, `/accept`, and `/dontask` can all be typed directly; auto mode (a classifier decides run/ask/block per action, read-only calls skip confirmation) has no typed command — it's reachable only by cycling with `Shift+Tab`. `Shift+Tab` covers all five states (default → auto → acceptEdits → plan → dontAsk → default) without typing a command. See [Permission modes](/en/usage/permissions).

### Session & history

- `/compact` — manually compacts the conversation history.
- `/clear` — clears the conversation and starts a new session file (accumulated cost is kept).
- `/resume` — lists and restores past sessions in the current directory.
- `/rewind` — rewinds to before a given turn — conversation only, code only, or both.
- `/fork` — forks the current session into a new one to keep going; the original session is frozen.
- `/rename <name>` — names the current session so it's recognizable in the `/resume` list.

### Cost & status

- `/cost` — a breakdown of this session's spend.
- `/stats` — session stats: turns, tool calls, tokens, cache, cost.
- `/recap` — a one-line recap of session progress and next steps.
- `/goal <condition>` — sets a session-level self-check goal to satisfy before stopping; with no argument, reports the goal in progress.
- `/context` — context usage percentage and last usage figures.

### Memory

- `/memory` — shows the instruction files and global memory drawer currently in effect.
- `/pause-memory` — pauses/resumes memory read-write for this session (aliases `/memory-pause`, `/toggle-memory`).

### Output & collaboration

- `/copy` — copies the last reply to the clipboard.
- `/export` — exports the whole conversation to a markdown file.
- `/commit` — checks git status and generates a commit following the repo's style.
- `/commit-push-pr` — does what `/commit` does, then pushes and creates or updates a PR (requires the `gh` CLI).

### Environment & diagnostics

- `/doctor` — diagnoses install, config, and connectivity.
- `/config` — shows the merged config with per-field provenance.
- `/mcp` — lists configured MCP servers.
- `/skills` — lists skills currently available.
- `/init` — analyzes the project and generates `DEEPCODE.md`.

## Keybindings

| Key | Effect |
| --- | --- |
| `/` | Open the slash command menu |
| `@` | Open the file-reference menu |
| `!` | Run a shell command directly |
| `↑` / `↓` | Move selection in the completion menu; browse input history when idle |
| `Tab` / `Enter` | Confirm the selected completion; `Enter` alone submits when no menu is open |
| `Shift+Tab` | Cycle permission mode (default → auto → acceptEdits → plan → dontAsk → default) |
| `\` + `Enter` at end of line | Continue on a new line for multi-line input |
| `Esc` | Interrupts the current turn while generating; clears the input box when idle; double-press opens the rewind picker |
| `PageUp` / `PageDown` | Scroll history up/down a page |
| `Ctrl+G` | Jump to the bottom and resume auto-follow |
| `Ctrl+C` (twice within 2s) | Exit |
| `Shift` + drag | Native terminal selection (the mouse wheel is otherwise captured for scrolling) |

## Full list

The above is just the high-frequency subset — see [Reference / Commands](/en/reference/commands) for the complete list.

---

Related: [Permission modes](/en/usage/permissions) · [Steering / rewind / compact](/en/usage/steering)
