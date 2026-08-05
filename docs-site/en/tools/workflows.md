---
title: Workflows
---
# Workflows

A workflow is **a JavaScript script that orchestrates multiple subagents**: what runs in parallel,
what runs in sequence, what retries and when — decided by code, not improvised by the model.

## When to reach for one

"More subagents" is not the criterion. The real question is **whether control flow should be
decided by code or by the model**:

| Use a workflow | Don't |
|---|---|
| Covering a known set exhaustively (review 20 files, one each) | A one-off exploratory task |
| Several independent perspectives, then a synthesis (three reviewers, majority wins) | Something one subagent can answer |
| Scale beyond a single context (a repo-wide migration) | Tightly coupled steps where you can't know step N+1 without seeing step N |

::: warning It can spend a lot
A workflow may dispatch dozens of subagents. **A spend warning is shown by default**; you can
disable it with `skipWorkflowUsageWarning` in settings, but think first about whether the run is
worth it.
:::

## What a script looks like

It must begin with `export const meta = {...}`, and that must be a **pure object literal** — no
variables, function calls, spreads or template interpolation (it has to be statically resolvable
before anything runs).

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changes across dimensions; verify each finding independently',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: 'Look for correctness problems…' },
  { key: 'perf', prompt: 'Look for performance problems…' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: 'Review', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`Adversarially verify: ${f.title}`, { phase: 'Verify', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)

return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

## Available functions

| Function | What it does |
|---|---|
| `agent(prompt, opts?)` | Dispatch a subagent. Without `schema` it returns the final text; with one, structured output is enforced and you get the validated object |
| `parallel(thunks)` | Run concurrently. **This is a barrier** — it waits for all of them |
| `pipeline(items, ...stages)` | Each item runs all stages independently; **no barrier between stages** |
| `phase(title)` | Start a new phase; subsequent `agent()` calls group under it |
| `log(msg)` | Emit a progress line |
| `workflow(name, args?)` | Run another workflow inline (one level of nesting only) |
| `args` | The JSON value passed in from the Workflow tool |

`agent()` options: `label` (display name), `phase` (grouping), `schema` (JSON Schema, forces
structured output), `model`, `effort`, `isolation: 'worktree'`, `agentType`.

### pipeline is the default; parallel is the exception

This is the easiest thing to get wrong. `parallel` is a barrier: **nothing downstream moves until
the slowest one finishes.**

```js
// Don't do this — that middle transform doesn't need a barrier
const a = await parallel(...)
const b = transform(a)          // just flatten/map/filter
const c = await parallel(b.map(...))
```

A barrier is only correct when **stage N genuinely needs all of stage N−1** — deduplicating across
the whole result set, say, or bailing out entirely if nothing was found. Otherwise use `pipeline`:
item A can be in stage 3 while item B is still in stage 1.

## Limits

| | Value | Notes |
|---|---|---|
| Concurrency | `min(16, CPU cores − 2)` | Excess queues; nothing is dropped |
| Items per `parallel`/`pipeline` call | 4096 | **Exceeding it is an error, not a silent truncation** |
| Total subagents per workflow | 1000 | Runaway backstop |

"Not a silent truncation" is deliberate: truncation makes you believe you covered everything when
half of it was skipped — far harder to diagnose than an error.

## Scripts are deterministic

Inside the sandbox, **`Date.now()`, `Math.random()` and no-arg `new Date()` are deleted** — calling
them throws. `import()` is unavailable too.

The reason is **resume**: `resumeFromRunId` relies on "same script + same args = same call
sequence" to know which `agent()` results can be reused from cache. One source of randomness or
time dependence and that premise is gone.

Need a timestamp? Pass it in via `args`, or stamp results after the workflow returns.

## Resume

Every run returns a `runId`. Re-invoking with `Workflow({ scriptPath, resumeFromRunId })`:
**the longest unchanged prefix of `agent()` calls returns cached results instantly; the first
edited call and everything after it runs for real.**

So iterating on a script doesn't mean paying for the whole thing again — which is exactly why the
determinism rule above exists.

## Three ways to invoke

```
Workflow({ script: "..." })                // inline script
Workflow({ name: "review-changes" })       // predefined: project .deepcode/workflows/ first, then ~/.deepcode/workflows/
Workflow({ scriptPath: "/path/to.js" })    // script on disk, highest precedence
```

Every invocation persists its script under the session directory and returns the path — **iterate
by editing that file and re-running with `scriptPath`** instead of resending the whole script.

## Orchestration patterns worth knowing

- **Adversarial verification** — spawn N independent skeptics per finding, each prompted to refute
  it; kill it if the majority do. This is what catches plausible-but-wrong conclusions.
- **Perspective-diverse verification** — when a finding can be wrong in several ways, give each
  verifier a distinct lens (correctness / security / performance / does-it-reproduce). More useful
  than N identical verifiers.
- **Judge panel** — generate N approaches from different angles, score them in parallel,
  synthesize from the winner while grafting good ideas from the runners-up.
- **Loop until dry** — for discovery of unknown size (bugs, edge cases), keep dispatching until K
  consecutive rounds turn up nothing new. A simple "stop at N" misses the tail.
- **Completeness critic** — a final agent asking "what's missing: which modality wasn't tried,
  which claim wasn't verified, which source wasn't read?"

---

Related: [Subagents](/en/tools/subagents) · [Tools overview](/en/tools/overview)
