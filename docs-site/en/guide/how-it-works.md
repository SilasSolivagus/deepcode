---
title: How it works
---

# How it works

deepcode isn't a "prompt in, generation out" tool — it's an agent loop running in your terminal: the model decides what to do, the code decides how it gets executed and how failures are handled. Understanding that split explains most of deepcode's behavior.

## Mental model

Four principles run through the whole harness:

- **Control flow belongs to code; intelligence belongs to the model.** Whether to retry, whether to keep looping, whether a permission check passes — that's deterministic code's job. What to do next, which tool to call, how to interpret an error — that's the model's job. Neither side crosses into the other's territory.
- **Retries only wrap connection setup to the API — tool execution is never replayed.** Network hiccups and connection timeouts are retried at the "establish a connection to the model service" layer only. Once a tool has actually started running — especially side-effecting ones like `Bash` or `Edit` — it is never silently re-run, so a single network blip can't cause the same command to fire twice.
- **Errors are written for the model to read.** When a tool fails, deepcode doesn't swallow the exception or abort the whole turn — it feeds a structured error back to the model so it can decide whether to try a different approach. This is the mechanism that lets the agent self-correct.
- **Tool results are untrusted input.** File contents, command output, fetched web pages — these are external data, and being "returned by a tool" doesn't make them trustworthy by default. Permission checks, path validation, and SSRF protection all treat tool output as untrusted input rather than assuming it's safe.

## The loop

A single task runs roughly like this:

```
Model (decides next step) → tool call (Read / Grep / Edit / Bash …) → result fed back to the model → repeat until done
```

Each turn, the model only decides which tool to call next and with what arguments. The result of that call — file contents, command output, a diff — is fed straight back into the conversation, and the model decides its next move based on that updated state. This repeats until the model judges the task complete or you interrupt it. **Permission gating happens before a tool actually executes**: every tool call passes through a permission check (allow / ask / deny) first, and only a call that clears it touches disk or runs in a shell — a layer of control the model never sees directly.

## Subsystems at a glance

Outside the main loop, a few subsystems each own a slice of responsibility:

- **Tool orchestration**: scheduling, argument validation, and result formatting for tools like Read, Grep, Edit, Bash, WebFetch, and WebSearch. See [Tools overview](/en/tools/overview).
- **Permissions**: five modes (default / accept / plan / auto / ask-deny) decide what asks you first, what's allowed outright, and what's blocked outright. See [Permission modes](/en/usage/permissions).
- **Memory**: context accumulated during a session is retained, and key facts can be recalled across sessions, so you don't have to re-explain your project every time. See [Memory](/en/tools/memory).
- **Subagents & worktrees**: complex tasks can be delegated to independent subagents, optionally running writes in an isolated git worktree so your working copy stays untouched. See [Subagents & worktree](/en/tools/subagents).
- **Workflows (loop)**: tasks that need multiple rounds or multiple cooperating agents can be composed into a workflow that advances automatically based on dependencies. See [Workflows (loop)](/en/tools/workflows).
- **MCP · Skills · Hooks ecosystem**: MCP connects external tools and data sources, Skills package reusable capabilities, and Hooks let you inject custom logic at key points in the loop. See [MCP](/en/tools/mcp), [Skills](/en/tools/skills), and [Hooks](/en/tools/hooks).

## Every line stays yours

None of this lives in a black box — these subsystems are just the source in this repository. System prompts, tool descriptions, permission logic, retry strategy: all of it is readable, editable, ordinary TypeScript, not an undocumented internal you can't touch. Want a different permission policy, an extra rule on a tool, a different error format for the model to read? Change the code — every line of deepcode stays yours.
