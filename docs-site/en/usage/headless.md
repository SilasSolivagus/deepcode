---
title: Headless
---

# Headless

Headless mode runs one task and exits — no interactive TUI. It's built for scripts, CI, and batch jobs.

## One-shot run: `-p`

```bash
deepcode -p "add unit tests for utils and make them pass"
```

Same main loop, same tools as the interactive TUI — the only difference is there's no UI: the final result goes to stdout, and tool-call progress (things like `⏺ Read(...)`) goes to stderr, so a pipeline can capture just the result.

Piping stdin without `-p` also triggers headless automatically (the whole stdin is treated as the task description) — handy for `echo "..." | deepcode` — but only the `-p` form supports `--output-format` below.

## Output format: `--output-format`

Pick the output shape with `--output-format <text|json|stream-json>` (defaults to `text`):

| Format | Output |
| --- | --- |
| `text` (default) | stdout gets the final reply text; tool-call progress goes to stderr |
| `json` | stdout gets a single final-result JSON object (fields below) — what most scripts want |
| `stream-json` | stdout gets a line-delimited JSONL event stream in real time (with complete tool arguments and results), for machine-parsing the whole run; the `⏺` stderr summary stays silent in this mode so stdout is pure JSONL |

`--json` is a backward-compatible alias for `--output-format json`; when both are present, `--output-format` wins.

### `json`: a single final result

```bash
deepcode -p "add unit tests for utils and make them pass" --output-format json   # or --json
```

Output fields (matching the `HeadlessResult` type in source):

| Field | Type | Description |
| --- | --- | --- |
| `text` | `string` | The last assistant message's text |
| `status` | `'done' \| 'aborted' \| 'max_turns'` | Why the run ended — see exit codes below |
| `turns` | `number` | How many turns actually ran |
| `usage` | `{ prompt_tokens, completion_tokens, prompt_cache_hit_tokens }` | Cumulative token usage |
| `costCNY` | `number` | Cost of this call, in CNY |

Example:

```jsonc
{
  "text": "Added unit tests for the 4 functions in utils.ts, npm test passes (12 passed).",
  "status": "done",
  "turns": 3,
  "usage": { "prompt_tokens": 8123, "completion_tokens": 512, "prompt_cache_hit_tokens": 4096 },
  "costCNY": 0.03
}
```

### `stream-json`: a live event stream

One JSON event per line to stdout, with tool arguments and results **untruncated** (bounded only by `maxToolResultChars`) — so a pipeline can watch, in real time, which files deepcode read and edited and which commands it ran:

```bash
deepcode -p "add unit tests for utils and make them pass" --output-format stream-json | jq -c 'select(.type == "tool_start") | {name, input}'
```

Event types:

| `type` | Description |
| --- | --- |
| `init` | Once, first line: `session_id` / `cwd` / `model` / `yolo` |
| `text` | Assistant text delta (`delta`; `reasoning:true` marks a reasoning delta) |
| `tool_start` | Tool started: `id` / `name` / `input` (the complete argument object) |
| `tool_result` | Tool finished: `id` / `ok` / `content` (the complete result) / `ms` |
| `turn_end` | A turn ended: cumulative `usage` |
| `result` | Once, last line: same fields as the `json` final result above |

Every line is independently valid JSON, so `jq -c` can parse it line by line.

## Exit codes

`process.exitCode` only ever takes two values:

- `status === 'done'` → **0** (completed successfully).
- `status === 'aborted'` or `'max_turns'` → **1** (blocked by a hook, interrupted mid-run, or hit the turn limit).
- Argument errors or thrown exceptions (for example `-p` with no task text after it) also land on **1**.

`aborted` and `max_turns` aren't distinguishable by exit code alone — read the `status` field from `--json` if a script needs to tell them apart.

## Permissions in non-interactive mode

There's nobody watching the screen to click "allow" in headless mode, so the internal ask-confirmation stub always returns a denial: anything that hits the "needs confirmation" bucket without already being cleared by an allow rule is auto-denied — it never actually pops a prompt and hangs the process waiting for input.

There are two ways to let destructive operations through:

1. **`--yolo`**: run the whole session in `yolo` permission mode, skipping the confirmation bucket.

   ```bash
   deepcode -p "run tests and push a fix branch" --yolo
   ```

2. **Preset allow rules**: match the exact command patterns you want to allow in `settings.json`'s `permissions.allow`, so the check passes at the "allow" stage and never reaches the confirmation bucket:

   ```jsonc
   {
     "permissions": {
       "allow": ["Bash(npm test)", "Bash(git push*)"]
     }
   }
   ```

Note that `--yolo` isn't a master key — `permissions.deny` rules, and the hard-coded "critical path" guard (the forced block on destructive commands like `rm`), aren't affected by `yolo` and still apply in every mode.

## CI / script integration

Assert on the `--json` result with `jq`, and fail CI on a bad outcome:

```bash
#!/usr/bin/env bash
set -euo pipefail

result=$(deepcode -p "add unit tests for utils and make them pass" --json --yolo)

status=$(echo "$result" | jq -r '.status')
cost=$(echo "$result" | jq -r '.costCNY')

if [ "$status" != "done" ]; then
  echo "Task did not complete cleanly: status=$status" >&2
  exit 1
fi

echo "Done, cost ¥$cost"
```

You can also rely on deepcode's own exit code (see above) with something simpler like `deepcode -p "..." --yolo || exit 1` — you just won't get details like `costCNY`.

---

Next: [settings and environment variables](/en/config/settings), [permission modes](/en/usage/permissions).
