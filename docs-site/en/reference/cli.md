---
title: CLI reference
---
# CLI reference

Every command-line flag and environment variable `deepcode` understands. Run `deepcode --help`
for the short version of whatever build you have installed.

## Three ways to start it

```bash
deepcode                        # interactive TUI (first run walks you through an API key)
deepcode -p "<task>"            # one-shot headless output
echo "<task>" | deepcode        # piped stdin, also headless
```

With no `-p` and a non-TTY stdin (in CI, for instance), deepcode reads all of stdin and treats it
as the task.

## Headless flags

Effective only on the `-p` and piped paths.

| Flag | What it does |
|---|---|
| `--output-format <fmt>` | `text` (default) \| `json` \| `stream-json` |
| `--json` | Alias for `--output-format json` |
| `--max-turns <n>` | Turn budget for this run. Positive integer; overrides `headlessMaxTurns` in settings |
| `--trace <dir>` | Dump every request sent to the model, verbatim, to `<dir>/req-NNNNN.json` |
| `--yolo` | Skip all permission prompts |

### The three output formats

- **`text`** — final answer on stdout; tool-call progress on stderr. For humans.
- **`json`** — one JSON line with `text` / `status` / `turns` / `usage` / `costCNY`.
- **`stream-json`** — one JSON line per event on stdout, tool arguments and results untruncated,
  ready for `jq`. In this mode the human-readable stderr trace goes silent.

```bash
deepcode -p "how many test files are in this repo?" --json | jq -r .text
deepcode -p "fix this bug" --output-format stream-json | jq -c 'select(.type=="tool_start")'
```

### `--max-turns`

Invalid values are a hard error, never a silent fallback. **Why**: a mistyped budget that silently
runs to the default is indistinguishable after the fact from one that was set correctly — so
refusing to start is the safer failure.

### `--trace`: request-side traces

`stream-json` shows you **what the model said**. A request trace shows you **what we said** — the
system prompt, injected reminders, post-compaction history, hook output. None of that appears in
the output stream.

```bash
deepcode -p "task" --trace ./trace --yolo
diff ./trace/req-00007.json ./trace/req-00008.json   # what did this turn add?
```

Each record carries a `label`: `turn` / `compact` / `recap` / `goal` / `hook` / `classify`
(auto-mode permission classifier) / `memorySignal` / `memoryIndex` / `subagent:<type>#<id>`.

::: danger Traces contain the full context
That includes the verbatim contents of every file the agent read — **possibly secrets and private
code**. The directory is created `0700`, but this is a local diagnostic tool, not a log. Don't
leave it on in a shared environment, and delete traces when you're done.
:::

Coverage: every outbound request with diagnostic value — not literally every request the process
makes. Two are deliberately skipped: image description (what's sent is an image, not something
deepcode "said") and API-key liveness checks (zero diagnostic value, and writing them down would
only widen the sensitive surface).

## Interactive flags

Effective only without `-p` and with a TTY stdin.

| Flag | What it does |
|---|---|
| `-c`, `--continue` | Resume the previous session |
| `--resume <file>` | Resume from a specific session file |
| `--inline` | Inline renderer instead of fullscreen (same as `DEEPCODE_INLINE=1`) |

## General flags

| Flag | What it does |
|---|---|
| `--model <name>` | Model for this run; takes precedence over `settings.model` |
| `--permission-mode <mode>` | `default` \| `acceptEdits` \| `plan` \| `auto` \| `dontAsk` \| `yolo` |
| `--settings <path>` | Use a specific `settings.json` |
| `-h`, `--help` | Print help |
| `-v`, `--version` | Print version |

### `--model`

Still clamped by the `settings.availableModels` allowlist — **the command line gets no back door**.
When a request is overridden you get a warning on stderr that names the source (`--model=…` rather
than `settings.model=…`, so you don't go hunting through a config file you never wrote). A model
belonging to a different provider is also rejected, so it can't be misrouted to the current
provider's endpoint.

### `--permission-mode`

| Value | Behavior |
|---|---|
| `default` | Allow by rule; prompt when approval is needed |
| `acceptEdits` | `Edit`/`Write` auto-approved, everything else unchanged |
| `plan` | Read-only; any non-read-only tool is refused |
| `auto` | When no rule matches, a classifier decides run/ask/block |
| `dontAsk` | Never prompt; anything not pre-approved is auto-denied |
| `yolo` | Allow everything |

The value must be one of those six or the command fails immediately. **That check matters**: a
typo would match none of the permission branches and silently degrade to `default` — so
`--permission-mode yolo` with one letter missing becomes "deny everything", and the user just
thinks the tool is broken.

Passing `--yolo` together with a non-`yolo` `--permission-mode` is an error; `--yolo` does not
silently win.

::: warning auto mode is not free
`auto` adds one classifier model call per tool invocation (~3s plus a little cost). This applies in
headless and background runs too.
:::

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Completed normally (headless `status === 'done'`) |
| `1` | Did not complete — hit the turn limit, aborted, context overflow, or a startup/argument error |

## Environment variables

### Model keys

| | |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek |
| `ZHIPUAI_API_KEY` | GLM (Zhipu) |
| `MOONSHOT_API_KEY` | Kimi (Moonshot) |
| `DEEPCODE_API_KEY` | Default key variable for a custom provider (override with `apiKeyEnv`) |

Environment variables take precedence over `settings.json`.

### Behavior switches

| | |
|---|---|
| `DEEPCODE_TRACE_DIR` | Same as `--trace <dir>` |
| `DEEPCODE_INLINE=1` | Same as `--inline` |
| `DEEPCODE_DISABLE_UPDATES=1` | **Everything off**: no check, no prompt, `/update` refuses |
| `DEEPCODE_DISABLE_AUTOUPDATER=1` | Disables auto-upgrade only; **still checks and notifies** |
| `DEEPCODE_MAX_CONTEXT_TOKENS=<n>` | Override the context window resolved from the model (moves the compaction threshold with it) |
| `DEEPCODE_FLAGS='{"<flag>":true}'` | Experimental mechanisms, **all off by default**. Malformed JSON is ignored wholesale, with a single warning |

Both disable switches parse values the same way: `0` and `false` mean off; any other non-empty
value means on.

### Network

`http_proxy` / `https_proxy` / `no_proxy` (either case). deepcode routes through them automatically.

### Search providers (for the `WebSearch` tool)

`BOCHA_API_KEY` / `TAVILY_API_KEY` / `ANYSEARCH_API_KEY`, used according to the provider configured
in settings.

## Internal flags, not for you

`--background-run` and `--job <short>` exist for the subprocess the TUI's `/background` spawns.
You never type them, so they aren't in `--help`.
