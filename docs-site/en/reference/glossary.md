---
title: Glossary
---
# Glossary

Alphabetical. One-line definition plus a pointer to the detailed page.

**auto mode** — A permission mode: when no rule matches, a classifier decides run / ask / block.
**Adds one model call per tool invocation** (~3s plus a little cost). There's no `/auto` command;
you reach it via `Shift+Tab` or `/cycle-mode`. → [Permissions](/en/usage/permissions)

**compaction** — Compressing history into a summary as the context approaches the window limit.
The threshold is configurable, and `/compact` triggers it manually.
→ [Steering / rewind / compact](/en/usage/steering)

**dangerous-key stripping** — About 20 keys are removed from the project layer of configuration,
because project config may come from an untrusted repository. Each key is on the list for a
specific reason, not as a blanket rule.
→ [Settings reference](/en/reference/settings#layers-and-dangerous-key-stripping)

**dream** — Background consolidation of memory: scattered entries are folded into more general
ones. The bar is deliberately high (≥24h since the last run **and** ≥5 new sessions) because it
calls a model and running it often freezes not-yet-stable observations into "conclusions".
→ [Memory](/en/tools/memory)

**flag (experimental switch)** — An experimental mechanism gated by the `DEEPCODE_FLAGS`
environment variable, **all off by default**. It exists so that A/B arms run the same code with the
variable as the only difference. → [CLI reference](/en/reference/cli)

**global drawer** — The cross-project memory layer (`~/.deepcode/memory/`). `maxBytes` is an
**injection budget, not a storage cap** — over budget it degrades to an index listing.
→ [Memory](/en/tools/memory)

**headless** — Non-interactive mode: `deepcode -p "<task>"` or piped stdin; runs once and exits.
Built for scripts and CI. → [Headless / CI](/en/usage/headless)

**hook** — A lifecycle hook that runs a command or HTTP request on specific events (session start,
before commit, subagent stop, …). → [Hooks](/en/tools/hooks)

**MCP** — Model Context Protocol; connects external tool servers over stdio. `/mcp` lists what's
connected. → [MCP](/en/tools/mcp)

**memory vs instruction file** — `DEEPCODE.md` holds **the rules you wrote**: injected in full
every time, high priority. Memory holds **what it observed itself**: possibly stale, possibly
wrong. Found a bad memory? Edit that `.md`. → [Memory](/en/tools/memory)

**pass^N** — A task counts as passed only if **all N seeds** succeed. It measures reliability — a
model that passes once and fails twice looks fine under pass@1.
→ [Benchmarks](/en/eval/benchmark)

**pipeline / parallel** — The two orchestration primitives in workflows. `pipeline` runs each item
through all stages independently with no barrier between stages; `parallel` **is** a barrier —
nothing proceeds until the slowest finishes. **pipeline is the default choice.**
→ [Workflows](/en/tools/workflows)

**plan mode** — A read-only permission mode; every non-read-only tool is refused. Leaving it
**restores the mode you were in**, not `default`. → [Permissions](/en/usage/permissions)

**read-only short-circuit** — Tools declaring `isReadOnly` are short-circuited to allowed by the
permission chain, **but deny rules still take precedence**.
→ [Permissions](/en/usage/permissions)

**request trace** — `--trace <dir>` dumps every request sent to the model verbatim. stream-json
shows **what the model said**; a request trace shows **what we said** (system prompt, injected
reminders, post-compaction history, hook output). ⚠️ Contains the full context, possibly secrets.
→ [CLI reference](/en/reference/cli#trace-request-side-traces)

**stream-json** — An output format: one JSON line per event on stdout with tool arguments and
results untruncated, ready for `jq`. → [Headless / CI](/en/usage/headless)

**subagent** — A one-shot, context-isolated unit of work. **It cannot see the current
conversation**, so its prompt must be self-contained. → [Subagents](/en/tools/subagents)

**verification subagent** — A subagent whose job is to try to break an implementation, and which
**holds exclusive authority over the verdict** — the main agent may not self-assess a pass.
Flag-gated, off by default. → [Subagents](/en/tools/subagents#verification-subagents)

**workflow** — Orchestrating multiple subagents with deterministic JavaScript. `Date.now()` and
`Math.random()` are removed inside the sandbox, because resume depends on "same script + same args
= same call sequence". → [Workflows](/en/tools/workflows)

**worktree isolation** — Giving a subagent a temporary git worktree (an isolated copy of the repo).
Useful when several subagents edit the same repo in parallel; cleaned up automatically if nothing
changed. → [Subagents](/en/tools/subagents#worktree-isolation)
