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

Piping stdin without `-p` also triggers headless automatically (the whole stdin is treated as the task description) — handy for `echo "..." | deepcode` — but only the `-p` form supports `--json` below.

## Structured output: `--json`

For scripting or CI, add `--json` to get a structured result instead of plain text:

```bash
deepcode -p "add unit tests for utils and make them pass" --json
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
