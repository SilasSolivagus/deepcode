---
title: Subagents & worktree
---
# Subagents & worktree

A subagent is a **one-shot, context-isolated** unit of work: the main agent dispatches one with the
`Agent` tool, it runs, hands back a single block of text, and disappears.

## Why they exist

Two reasons; the second is the interesting one:

1. **Context economy** — searching a codebase means opening a dozen files. The main agent doesn't
   need that transcript, only the conclusion.
2. **A second pair of eyes** — a subagent can't see the current conversation. It only gets the
   prompt you wrote for it. That's a limitation and a feature: it can't be led astray by
   conclusions the main agent already reached. Verification subagents depend entirely on this.

::: warning A subagent cannot see the conversation
The `prompt` must be **self-contained**: paths, what to look for, what output shape you expect. It
has no idea what "keep going with that" refers to.
:::

## Built-in types

| Type | Purpose | Tools | Model |
|---|---|---|---|
| `general-purpose` | Research, code search, multi-step work; the default when you're not sure one shot will land | All | Inherits parent |
| `Explore` | Fast read-only search / locating an implementation, at quick / medium / very thorough depth | All except Edit/Write/NotebookEdit/Agent | **fast tier** (cheap) |
| `Plan` | Software architect; designs an implementation plan | All except Edit/Write/NotebookEdit/Agent | Inherits parent |
| `verification` | Independently verifies an implementation actually works; returns PASS / FAIL / PARTIAL with evidence | All except Edit/Write/NotebookEdit/Agent (**keeps Bash**) | Inherits parent |

`verification` is flag-gated and not registered by default — see [Verification subagents](#verification-subagents).

### Denied to every subagent

```
ExitPlanMode  EnterWorktree  ExitWorktree  Workflow
ScheduleWakeup  CronCreate  CronList  CronDelete
Monitor  TaskStop  PushNotification
```

These either mutate session-level state or spawn more work. **A subagent must not open further
branches of its own** — the cost of that going wrong is unbounded.

## Calling one

```
Agent(
  description: "one-line description (shown to the user)",
  prompt:      "the full, self-contained instruction",
  subagent_type: "Explore",          // omit = general-purpose
  run_in_background: true,           // optional: run in background, notify on completion
  isolation: "worktree"              // optional: isolate into a temporary git worktree
)
```

## worktree isolation

`isolation: "worktree"` gives the subagent a temporary git worktree — **an isolated copy of the
repository**.

- Its cwd is anchored inside the worktree and the system prompt gains an isolation note.
- If it made **no changes, the worktree is cleaned up automatically**; if it did, you get the
  worktree path and branch back and decide how to merge.
- Cost: creation overhead and disk per worktree.

When to use it: **several subagents editing the same repo in parallel.** Otherwise they trample
each other. A single subagent, or any read-only task, doesn't need it.

`worktree` in settings takes `symlinkDirectories` (directories to symlink in, e.g. `node_modules`)
and `sparsePaths`.

## Turn budget and truncation

Each subagent has its own turn budget: **30 by default**, **50** for `verification`.

::: danger A truncated return is not a conclusion
When a subagent burns through its budget, the value it returns is prefixed with an explicit
warning: this is a **truncated intermediate state, not a conclusion, and must not be used to claim
the task is complete or verified**.

That warning was added after the fact. Previously, hitting the cap sealed the transcript with a
neutral "reached the maximum turn count" line — indistinguishable to the parent from "finished
normally without much to say". The observed consequence: a verification subagent was truncated,
never returned a verdict, and the parent finished anyway and wrote "verified" into its delivery
summary. **A verification mechanism that fails this way is worse than none** — the deliverable ends
up carrying a "verified" label nobody earned.
:::

If a subagent keeps hitting the cap, raising the budget is not the first thing to try. Measured:
the run that finished did **the most work in the fewest turns** — it batched independent checks
into a single turn. The ones that failed issued one command per turn and spent the budget on
round-trips.

## Verification subagents

A subagent whose whole job is to **try to break** an implementation, and which **holds exclusive
authority over the verdict** — the main agent may not self-assess a pass.

- Forbidden from modifying project files (`Edit`/`Write`/`NotebookEdit` all denied) but **keeps
  `Bash`**: it needs to run builds, test suites and targeted checks, and to redirect one-off
  scripts into `/tmp`. What's forbidden is touching project files, not writing files at all.
- The output format is mandatory: every check must include the command run and the output seen.
  **A check with no command block is a skip, not a pass.** The final line must be
  `VERDICT: PASS` / `FAIL` / `PARTIAL`.
- On FAIL: fix, then dispatch a **new** verifier (subagents can't be resumed), carrying the
  previous round's raw findings.
- On PASS: re-run 2-3 of the commands from its report yourself and reconcile.

::: info Off by default
Gated behind `DEEPCODE_FLAGS='{"verificationAgent":true}'`, and the contract is only injected in
headless. It's off because **it hasn't been shown to be stable**: with the same prompt and the same
flag, some runs dispatched a verifier on their own and some never did. Flipping the default
requires A/B results with criteria frozen before the run.
:::

## Custom subagents

Drop `*.md` files into `.deepcode/agents/`, one file per type:

```markdown
---
name: reviewer
description: Reviews a change for correctness. Give it the diff and the original requirement.
tools: [Read, Grep, Glob, Bash]
model: inherit
---

You are a code reviewer. Judge correctness only; ignore style.
...(this body becomes its system prompt)
```

| Frontmatter field | Notes |
|---|---|
| `name` | **Required** — this is the `subagent_type` value |
| `description` | **Required** — tells the model when to reach for it |
| `tools` | Allowlist; omit or `['*']` for the full pool minus the global denies |
| `disallowedTools` | Denylist |
| `model` | `inherit` (default) or a specific tier |

Everything after the frontmatter becomes the subagent's system prompt.

**Loading and precedence**: user level (`~/.deepcode/agents/`) loads before project level
(`<project>/.deepcode/agents/`), and on a name collision the later one wins; a custom type also
overrides a built-in of the same name. Files missing `name` or `description` are skipped, and one
broken file doesn't affect the others.

## Background subagents

`run_in_background: true` detaches the subagent from the current turn and notifies you when it
finishes — good for long research you don't want to sit and wait on. `/stop` lists running
background sessions and can stop them.

---

Related: [Tools overview](/en/tools/overview) · [Workflows](/en/tools/workflows) ·
[Permissions](/en/usage/permissions)
