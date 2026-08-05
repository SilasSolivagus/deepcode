---
title: Tools reference
---
# Tools reference

Every built-in tool the model can call. **31 of them** — 20 statically registered, 11 constructed
per session (they need a client, model tier, subagent list injected). MCP server tools are added
dynamically on top.

The "Permission" column has three values:

- **No** — never prompts
- **Depends** — on the arguments (is the path inside the working directory, does the command match
  a rule) and goes through the full [permission chain](/en/usage/permissions)
- Tools declaring `isReadOnly` are short-circuited by the permission chain, **but deny rules still
  win**

## Files

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `Read` | ✓ | No | Read a file with line numbers. Use `offset`/`limit` for large ones. **Any file must be Read before editing** |
| `Glob` | ✓ | No | Find files by glob, max 100, `node_modules`/`.git` ignored automatically |
| `Grep` | ✓ | No | Regex search inside files, returns `file:line:content`, max 100. ripgrep syntax by default |
| `Edit` | | Depends | Exact string replacement. `old_string` must match **character for character** (indentation and newlines included) and be unique by default |
| `Write` | | Depends | Whole-file write, parent directories created. **Overwriting requires having Read the file first**; new files don't |
| `NotebookEdit` | | Depends | Edit a single `.ipynb` cell: replace / insert / delete |

::: tip Glob for filenames, Grep for contents
Don't shell out to `find` / `grep` — the dedicated tools have result caps and ignore rules, so
their output costs far less context.
:::

## Execution

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `Bash` | | Depends | Run a command in a **persistent** working directory (`cd` affects every later command). 120s default timeout; output over 30000 chars is truncated in the middle |

## Network

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `WebFetch` | | Depends | Fetch an http(s) URL and extract/summarize per a prompt |
| `WebSearch` | | Depends | Search the web for current information; returns title / link / snippet |

## Task list

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `TaskCreate` | | No | Create a task. **Start anything with 3+ steps by listing the plan** |
| `TaskUpdate` | | No | Update a task. Mark one completed and the next in_progress — **at most one in_progress at a time** |
| `TaskGet` | ✓ | No | Fetch all fields of a task by id |
| `TaskList` | ✓ | No | List the current task list |

## Subagents & orchestration

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `Agent` | ✓ | No | Dispatch a subagent. See [Subagents](/en/tools/subagents) |
| `Workflow` | ✓ | Depends | Orchestrate subagents with a deterministic JavaScript script. See [Workflows](/en/tools/workflows) |
| `Skill` | ✓ | No | Invoke a skill. See [Skills](/en/tools/skills) |

## Background tasks & scheduling

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `Monitor` | ✓ | No | Start a background monitor streaming events from a long-running script. **Each stdout line is one event** |
| `BgTaskList` | ✓ | No | List background tasks (id / status / description) |
| `TaskOutput` | ✓ | No | Fetch a background task's output |
| `TaskStop` | ✓ | No | Stop a running background task by id (Monitor, background Bash, cron) |
| `Sleep` | ✓ | No | Wait N seconds; the user can interrupt at any time |
| `CronCreate` | ✓ | No | Queue a prompt for the future — recurring on a cron schedule, or one-shot |
| `CronList` | ✓ | No | List cron tasks scheduled in this session |
| `CronDelete` | ✓ | No | Cancel a cron task |
| `ScheduleWakeup` | ✓ | No | Schedule the next iteration in `/loop` dynamic mode |

## Memory

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `SearchMemory` | ✓ | No | Full-text search across project memory and the global drawer. See [Memory](/en/tools/memory) |

## Session & environment

| Tool | Read-only | Permission | What it does |
|---|---|---|---|
| `Config` | | Depends | Read/write user-level config. Omit `value` to read the merged value; supply it to write the user layer |
| `ExitPlanMode` | ✓ | No | Submit a plan for approval in plan mode. **Only available in plan mode** |
| `EnterWorktree` | | No | Create an isolated git worktree and move the session into it |
| `ExitWorktree` | | No | Leave the worktree; `action=keep` or `remove` |
| `PushNotification` | ✓ | No | Send a desktop notification to pull attention back. **This has a cost — prefer not to** |
| `AskUserQuestion` | ✓ | No | Pop a structured question when the user should decide, instead of guessing. 1–4 questions, 2–4 options each |

## Denied to subagents

Regardless of type, these 11 are denied to every subagent:

```
ExitPlanMode  EnterWorktree  ExitWorktree  Workflow
ScheduleWakeup  CronCreate  CronList  CronDelete
Monitor  TaskStop  PushNotification
```

They either mutate session-level state or spawn more work — **a subagent must not open branches of
its own**. Individual types add further restrictions (`Explore` / `Plan` / `verification` all deny
`Edit`/`Write`); see [Subagents](/en/tools/subagents).

## MCP tools

Tools provided by MCP servers are injected at runtime and namespaced by server. `/mcp` shows
connected servers and what they expose. See [MCP](/en/tools/mcp).

---

Related: [Tools overview](/en/tools/overview) · [Permissions](/en/usage/permissions) ·
[Subagents](/en/tools/subagents)
