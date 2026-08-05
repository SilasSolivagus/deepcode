---
title: Memory
---
# Memory

deepcode remembers things across sessions: who you are, what you've corrected it on, what
constraints this project has. **One memory is one `.md` file** — plain text you can read, edit and
delete yourself at any time.

## Three layers

| Layer | Location | Purpose |
|---|---|---|
| **Project memory** | `~/.deepcode/projects/<project-key>/memory/` | Decisions and constraints specific to this project |
| **Global drawer** | `~/.deepcode/memory/` | Cross-project things: your preferences, how you like to work |
| **Session summary** | `~/.deepcode/projects/<key>/<session-id>/session-memory/summary.md` | Rolling summary of the current session |

The project key resolves to the repository root (the directory containing `.git`), so **opening the
same repo from a different path uses the same memories**.

## What a memory looks like

```markdown
---
name: prefers-tabs
description: This project indents with tabs, not spaces
metadata:
  type: feedback
---

This project uses tab indentation throughout. **Why:** the existing code is all tabs; mixing them
makes diffs noisy. **How to apply:** new files use tabs too — don't "tidy them up" to spaces.
```

`type` is one of four:

| type | What it holds |
|---|---|
| `user` | Who the user is — role, expertise, preferences |
| `feedback` | Corrections or explicit guidance about how to work (**always record the why**) |
| `project` | Key decisions or constraints that aren't derivable from the code and git history |
| `reference` | Pointers to external resources: URLs, dashboards, tickets |

The index file `MEMORY.md` holds one line per memory and is **loaded into context at the start of
every session** — so it's an index, not a content store.

## What actually gets recorded

**Not every turn.** There's a gate: a small model decides whether a stretch of conversation
contains information worth remembering long-term, and answers yes or no.

| Counts as yes | Counts as no |
|---|---|
| Facts about the user, or lasting preferences | Small talk |
| Corrections or guidance about how to work | Execution details of a one-off task |
| Key project decisions or constraints | Specific code or command contents |
| | Its own analysis or summaries; temporary context |

::: tip Why the gate exists
Without it, an extraction model runs every turn — expensive, and it turns a pile of one-off details
into "long-term memories". A few weeks later the index is all noise. The gate only lets extraction
through when there's genuinely something durable.
:::

## Session summaries

Long sessions maintain a rolling summary so that history compaction doesn't drop key early
information. Three thresholds gate it:

| Setting | Default | Meaning |
|---|---|---|
| `minInitTokens` | 10000 | Tokens accumulated before the first summary is generated |
| `minUpdateTokens` | 5000 | Additional tokens before each subsequent update |
| `toolCallsBetween` | 3 | Minimum tool calls between two updates |

Together they keep short sessions from generating summaries nobody needs.

## dream: background consolidation

Once enough has accumulated, deepcode consolidates scattered memories into more general entries in
the background. **The bar is deliberately high:**

| Setting | Default | Meaning |
|---|---|---|
| `minHours` | 24 | Hours since the last consolidation |
| `minSessions` | 5 | New sessions accumulated since |

**Both** must hold. Consolidation calls a model and costs money; running it often is expensive and
tends to freeze not-yet-stable observations into "conclusions".

## The global drawer's injection budget

The global drawer defaults to `maxBytes: 8192` — **that's a full-text injection budget, not a
storage cap**.

Under budget, the drawer is injected in full. **Over budget it degrades to an index listing**
(titles and one-line summaries only); the model then reaches for `SearchMemory` and `Read` when it
needs detail.

The reason is that the global drawer is injected into *every* session. Without a cap it would
quietly eat more and more of the context budget over time.

## Search

The `SearchMemory` tool runs **full-text search** across project memory and the global drawer
(SQLite FTS5, no external dependency) and returns the most relevant snippets plus file keys.

The division of labour: **the index (`MEMORY.md`) tells it something exists, search finds where,
and `Read` shows the whole thing.** The model is instructed to read the full file before answering
rather than concluding from a snippet.

## Configuration

The `memory` field in settings; every key optional:

```jsonc
{
  "memory": {
    "enabled": true,                    // master switch
    "extractEveryTurns": 1,             // how often to run the gate
    "sessionMemory": {
      "enabled": true,
      "minInitTokens": 10000,
      "minUpdateTokens": 5000,
      "toolCallsBetween": 3
    },
    "dream": { "enabled": true, "minHours": 24, "minSessions": 5 },
    "global": { "enabled": true, "maxBytes": 8192 },
    "indexConsolidation": { "enabled": true }
  }
}
```

An invalid value doesn't invalidate the whole config — each field falls back to its default
independently (a positive-integer field given a negative number or a string just uses the default).

## Related commands

| Command | What it does |
|---|---|
| `/memory` | Show the memory files currently in effect |
| `/pause-memory` | Pause extraction for this session (aliases: `/memory-pause`, `/toggle-memory`) |
| `/init` | Generate the project's `DEEPCODE.md` instruction file |

::: info Memory is not the instruction file
`DEEPCODE.md` is **the rules you wrote**: injected in full every time, high priority. Memory is
**what it observed on its own**: possibly stale, possibly wrong. They're different things — if you
find an incorrect memory, just edit that `.md` file.
:::

---

Related: [Tools overview](/en/tools/overview) · [Subagents](/en/tools/subagents) ·
[Settings reference](/en/reference/settings)
