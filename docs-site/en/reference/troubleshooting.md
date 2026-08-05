---
title: Troubleshooting
---
# Troubleshooting

Look up **the message you actually saw**. Every entry here corresponds to a real message in the
source, not a hypothetical scenario.

::: info This page is incomplete
What's here is the error-message table, written from the messages in the source. **The other half —
"what people actually get stuck on" — is missing**, because that needs real usage feedback;
ranking problems by guesswork would be fiction. If you hit something that isn't here,
[open an issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose) and we'll add it.
:::

Note that runtime messages are in Chinese; the translations below are for orientation.

## Startup & configuration

**"缺少 &lt;provider&gt; API key…" (missing API key for the current provider)**
Set the environment variable (higher precedence) or put it in settings. Running `deepcode`
interactively takes you through the first-run wizard; `/setup` reconfigures later.

**"stdin 为空…" (stdin is empty)**
You started it in a non-TTY context (a pipe, CI) without giving it a task. Either use
`-p "<task>"` or actually feed something on stdin.

## Command-line arguments

These are all hard errors, never silent fallbacks — an argument that's silently ignored is
indistinguishable after the fact from one that worked.

| Message | Fix |
|---|---|
| `--max-turns` needs a positive integer / only accepts positive integers | `0` and negatives are rejected |
| `--model` needs a model name | The value is missing, or starts with `-` and was read as the next flag |
| `--permission-mode` needs a value | Same |
| `--permission-mode` only supports `default\|acceptEdits\|yolo\|plan\|auto\|dontAsk` | Typo. **This check matters**: a typo would match no permission branch and silently degrade to `default` |
| `--output-format` only supports `text\|json\|stream-json` | Pick one of the three |
| `--trace` needs a directory path | The path is missing |
| `--yolo` conflicts with `--permission-mode X` | Both given and inconsistent. `--yolo` *is* `--permission-mode yolo`; pass one |

## Context overflow

| Message | Meaning |
|---|---|
| "context too long, dropped ~N tokens of old tool output and retried" | **Normal self-healing.** Ignore |
| "context too long and no reclaimable old tool output; stopped" | Nothing left to reclaim. Read large files in chunks or narrow the task |
| "still too long after compaction; stopped" | Same, and compaction couldn't save it either |

The root cause is usually **one very large file read in one go**. Use `offset`/`limit` on `Read`,
or have it `Grep` first and read only the relevant span. `DEEPCODE_MAX_CONTEXT_TOKENS` can override
the inferred window, but that treats the symptom.

## Turn limit

**"reached the step limit, entering a wrap-up turn"**
You hit the headless turn budget. Raise it with `--max-turns <n>` or split the task.

::: tip Hitting the limit doesn't mean nothing got done
In practice, runs that hit the cap still produce decent results — they were cut off while wanting
to double-check. Look at the output before re-running.
:::

## worktree

| Message | Fix |
|---|---|
| "not a git repository, cannot create a worktree" | worktree isolation requires a git repo |
| `isolation:"worktree"` requires a git repo (or a `WorktreeCreate` hook) | Same, or configure a hook to take over |
| "already in a worktree session (ExitWorktree first)" | No nesting; exit first |
| "failed to create worktree: `<git error>`" | The trailing part is git's raw output — debug from that |
| "sparse-checkout failed: `<git error>`" | Check `worktree.sparsePaths` in settings |

## Subagents

**"subagent nesting reached the limit of N; cannot dispatch further"**
Subagents can't recurse indefinitely. This is a hard runaway guard — **finish the work at the
current level** rather than trying to split further.

**A return value prefixed with "⚠️ the subagent hit its turn budget before finishing"**
It was truncated, and **what follows is an intermediate state, not a conclusion**. Don't treat the
task as complete or verified. Either narrow the scope and dispatch again, or tell it to batch
independent checks into a single turn — in practice, repeatedly hitting the cap usually means one
command per turn burning the budget on round-trips, not a budget that's genuinely too small.

## Document parsing

| Message | Meaning |
|---|---|
| "document parsing timed out" | Over 180s. Large document or slow network |
| "document parsing failed: HTTP `<code>`" | Non-2xx from the server; debug by status code |
| "document parsing failed: no md_results in response" | Unexpected response shape, usually an endpoint misconfiguration |

Parsing goes through GLM-OCR and needs a GLM key — **but does not require switching your active
provider to GLM**.

## MCP

**`Server "X" not found. Available servers: …`**
Wrong server name, or that server didn't connect. `/mcp` lists what's connected.

## Traces & flags

| Message | Meaning |
|---|---|
| "`--trace`/`DEEPCODE_TRACE_DIR` has no effect in the interactive TUI" | Request traces only work on the `-p` and piped headless paths. **It tells you rather than silently ignoring you** |
| "trace directory permissions too wide (NNN), tightened to 0700" | Safety net, already handled. Traces hold the full context (possibly secrets) and shouldn't be world-readable |
| "`DEEPCODE_FLAGS` failed to parse, ignored entirely" | Malformed JSON. **Ignored wholesale rather than partially applied** — a half-on experiment arm is harder to debug than an off one |

## Self-diagnosis

`/doctor` checks installation, configuration and connectivity. `/config` shows the merged
configuration and which layer each key came from — **start there when a setting isn't taking
effect**; usually it's been overridden by a later layer, or the project layer had a
[dangerous key stripped](/en/reference/settings#layers-and-dangerous-key-stripping).

---

Related: [CLI reference](/en/reference/cli) · [Settings reference](/en/reference/settings) ·
[Commands reference](/en/reference/commands)
