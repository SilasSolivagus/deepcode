---
title: Tools overview
---

# Tools overview

## What tools are

deepcode's main loop gets work done through a set of built-in tools: reading and writing files, searching code, running commands, spawning subagents/skills, reaching the web and long-term memory, and managing background and scheduled tasks. Every tool call is shown live in the TUI, and whether it needs your confirmation is decided by the current [permission mode](/en/usage/permissions).

## Grouped by category

The tables below group the built-in tools by purpose (names taken straight from source, matching what's actually registered). The "read-only" column reflects the tool's `isReadOnly` property, which determines whether the permission system auto-approves it — see the next section for the full decision rule.

### Files & notebook

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Read` | Reads file content with line numbers; must be called before editing any file | ✓ |
| `Write` | Writes a whole file (create or overwrite); overwriting an existing file requires a prior `Read` | |
| `Edit` | Exact string replacement in a file | |
| `NotebookEdit` | Edits a single Jupyter notebook (.ipynb) cell: replace/insert/delete, without executing it | |

### Search

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Glob` | Finds file paths by glob pattern (auto-ignores `node_modules`/`.git`) | ✓ |
| `Grep` | Searches file content by regex, returns file:line:content | ✓ |

### Execution

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Bash` | Runs a shell command in a persistent working directory, foreground or backgrounded | |

### Agent orchestration

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Agent` | Spawns a one-shot subagent to complete a subtask; the subagent doesn't see the current conversation | ✓ |
| `Workflow` | Orchestrates multiple subagents with deterministic JavaScript (loops/conditionals/fan-out) | ✓ |
| `Skill` | Invokes a skill; the skill's instructions are delivered as a separate message and executed | ✓ |
| `TaskCreate` | Creates a task in the task list | |
| `TaskGet` | Gets all fields of a task by id | ✓ |
| `TaskUpdate` | Updates a task's status/fields (including dependency-blocking checks) | |
| `TaskList` | Lists the current task list | ✓ |
| `BgTaskList` | Lists all background process tasks | ✓ |
| `TaskOutput` | Reads background task output (incremental, or from a given offset) | ✓ |
| `TaskStop` | Stops a running background task by id | ✓ |

### Memory

| Tool | What it does | Read-only |
| --- | --- | --- |
| `SearchMemory` | Full-text searches long-term memory (this project + the cross-project global drawer) for relevant snippets | ✓ |

### Network

| Tool | What it does | Read-only |
| --- | --- | --- |
| `WebFetch` | Fetches an http(s) URL and extracts/summarizes its content per a prompt | |
| `WebSearch` | Searches the web for current information, returns title/link/snippet | |

### Scheduling & notifications

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Sleep` | Waits a given number of seconds; the user can interrupt at any time | ✓ |
| `ScheduleWakeup` | Schedules the next resume in `/loop` dynamic mode | ✓ |
| `CronCreate` | Schedules a future task, recurring on a cron schedule or one-off | ✓ |
| `CronList` | Lists the cron tasks scheduled in this session | ✓ |
| `CronDelete` | Cancels a scheduled cron task | ✓ |
| `Monitor` | Starts background monitoring, streaming events from a long-running script | ✓ |
| `PushNotification` | Sends a desktop notification to the user's terminal | ✓ |

### Interaction & flow control

| Tool | What it does | Read-only |
| --- | --- | --- |
| `AskUserQuestion` | Pops a structured multiple-choice question to the user (interactive mode only) | ✓ |
| `ExitPlanMode` | In plan mode, asks the user to approve a plan; once approved, lifts the read-only restriction | ✓ |

### Worktree isolation

| Tool | What it does | Read-only |
| --- | --- | --- |
| `EnterWorktree` | Creates an isolated git worktree and switches the current session into it | |
| `ExitWorktree` | Exits the current worktree session, restoring the original working directory | |

### Config

| Tool | What it does | Read-only |
| --- | --- | --- |
| `Config` | Reads/writes user-level config (sensitive fields like apiKey/hooks/mcpServers can't be changed through this tool) | |

### External tools (MCP)

Connected MCP servers hot-plug their own tools into this tool set dynamically — they're not in the fixed list above, and their names are defined by the server itself. See [MCP](/en/tools/mcp).

### How a tool shows up in the TUI

A call sequence lists "tool name + a one-line summary" live, then a cost line at the end:

```
› add unit tests for utils and make them pass

  Grep  search for utils-related files
  Read  src/utils.ts
  Edit  src/utils.test.ts
  Bash  npm test

  Added unit tests for the 4 functions in utils.ts, npm test passes (12 passed).

  ¥0.03 · 3 turns · 8.2k tokens
```

## Permission classes

Tools with `isReadOnly` true are auto-approved by default, with no confirmation prompt; tools that write files or run commands need your confirmation by default (unless the permission mode or a rule says otherwise). The full decision priority — deny rules > plan-mode read-only > system-level safety backstop > read-only shortcut > allow/ask rules — is covered in [permission modes](/en/usage/permissions); it isn't repeated here.

## Full parameter reference

Per-tool parameters and input schemas live in [tools reference](/en/reference/tools).

---

Next: [MCP](/en/tools/mcp) (connecting external tools), [permission modes](/en/usage/permissions).
