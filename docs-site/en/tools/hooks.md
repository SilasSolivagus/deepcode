---
title: Hooks
---

# Hooks

## What hooks are

Hooks are external commands (shell commands by default) attached to specific points in deepcode's lifecycle. When an event fires, deepcode finds the mount points whose matcher matches and invokes them — useful for audit logging, blocking dangerous operations, injecting extra context at a given point, or wiring up external systems (CI, chat notifications, custom scripts) without touching deepcode's own code.

## Event types

deepcode defines the following events (the full `HOOK_EVENTS` enumeration in `src/hooks.ts`):

| Event | Fires when |
| --- | --- |
| `PreToolUse` | Before a tool call executes |
| `PostToolUse` | After a tool call completes successfully |
| `PostToolUseFailure` | After a tool call errors/fails |
| `PostToolBatch` | After a batch of parallel tool calls all finish |
| `PermissionRequest` | Before showing a permission confirmation prompt |
| `PermissionDenied` | After a permission request is denied |
| `SessionStart` | On session startup |
| `SessionEnd` | On session end |
| `Setup` | On first-run/maintenance initialization (e.g. writing default config) |
| `UserPromptSubmit` | When the user submits a prompt |
| `UserPromptExpansion` | After a custom command/prompt expansion |
| `Stop` | When an agent turn ends normally |
| `StopFailure` | When an agent turn ends abnormally |
| `SubagentStart` | When a subagent starts |
| `SubagentStop` | When a subagent finishes |
| `PreCompact` | Before context compaction runs |
| `PostCompact` | After context compaction runs |
| `TaskCreated` | When a task (background command/subagent/todo) is created |
| `TaskCompleted` | When a task completes/finishes |
| `MessageDisplay` | Right before a message is shown to the user |
| `Notification` | When a system notification fires |
| `ConfigChange` | When config changes mid-session |
| `CwdChanged` | When the working directory changes (e.g. `cd` inside the Bash tool) |
| `InstructionsLoaded` | When project instructions like DEEPCODE.md are loaded |
| `WorktreeCreate` | When a git worktree is created/entered |
| `WorktreeRemove` | When a git worktree is removed/exited |
| `Elicitation` / `ElicitationResult` | Reserved for a future interactive-elicitation subsystem, not dispatched yet |
| `TeammateIdle` | Reserved for a future multi-agent collaboration subsystem, not dispatched yet |
| `FileChanged` | Reserved for a future file-watching subsystem, not dispatched yet |

## Matcher matching

Each event can have multiple `{ matcher, hooks }` groups; the matcher decides whether that group's hooks run for a given firing, checked in this priority order:

1. **Always true**: `matcher` unset, empty string, or `"*"` — always matches.
2. **Pipe-or**: if it contains `|`, split on `|` into candidates; matching any one of them counts as a match (e.g. `"Bash|Read"` matches a call whose tool name is `Bash` or `Read`).
3. **Exact identifier**: if it's a bare `[A-Za-z0-9_]+`, matched by exact string equality.
4. **Regex**: otherwise treated as a regular expression; as a ReDoS guard, any matcher longer than 200 characters is rejected outright (a matcher that fails to compile as a regex is likewise rejected) — it's never actually run.

Which field the matcher is checked against depends on the event:

| Matched field | Applies to |
| --- | --- |
| `tool_name` | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` |
| `source` | `SessionStart`, `ConfigChange` |
| `trigger` | `Setup`, `PreCompact`, `PostCompact` |
| `agent_type` | `SubagentStart`, `SubagentStop` |
| `notification_type` | `Notification` |
| `reason` | `SessionEnd` |
| `error` | `StopFailure` |
| `command_name` | `UserPromptExpansion` |
| `load_reason` | `InstructionsLoaded` |
| `file_basename` | `FileChanged` |
| (none) | All other events ignore the matcher and always run every configured hook |

## Configuration

Hooks live under the `hooks` field in settings.json, grouped by event name; each group is an array of `{ matcher, hooks }`:

```jsonc
// ~/.deepcode/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          { "type": "command", "command": "echo \"about to run: $TOOL_NAME\" >> /tmp/audit.log", "timeout": 5 }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "say done", "async": true }
        ]
      }
    ]
  }
}
```

Besides the most common `type: "command"` (runs a shell command, with fields `command`/`timeout` (in seconds, default 60)/`async`), three other types exist: `type: "prompt"` (a single LLM judgment call, fields `prompt`/`model`), `type: "agent"` (a read-only subagent doing a multi-turn check, same fields as prompt), and `type: "http"` (fires an HTTP request, fields `url`/`headers`/`allowedEnvVars`). A command hook's exit code drives the outcome: `2` blocks the current operation, with the block reason taken from stderr/stdout text; any other non-zero exit is treated as an error, also from stderr/stdout text; only when the exit code is 0 does a JSON stdout payload get parsed, whose conventional fields (e.g. `decision`, `hookSpecificOutput.permissionDecision`) further shape the permission decision and injected context. `async: true` hands the command off to the background without blocking the current flow.

## Security

- **SSRF protection for http hooks**: requests made by a `type: "http"` hook first pass an `allowedHttpHookUrls` allowlist (unset = unrestricted, `[]` = fully blocked, non-empty = must match a glob pattern), then a network-layer IP guard (`ssrfGuardedLookup`, blocking private/internal addresses and DNS rebinding), with redirects disallowed (`redirect: 'error'`).
- **Project-layer stripping**: `hooks` itself, along with its companion fields `allowedHttpHookUrls` and `httpHookAllowedEnvVars`, are in the dangerous-field stripping list — a project-repo `.deepcode/settings.json` (or a git-tracked `settings.local.json`) that sets `hooks` has it stripped and ignored; only hooks configured in `~/.deepcode/settings.json` (or your own untracked local override) actually run. That way cloning a malicious repo can't silently smuggle in arbitrary command execution.

---

Layering and stripping rules for `hooks`/`allowedHttpHookUrls`/`httpHookAllowedEnvVars` are covered in [settings](/en/config/settings); the full built-in tool list is in [Tools overview](/en/tools/overview).
