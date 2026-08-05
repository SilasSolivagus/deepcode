---
title: Benchmarks & reproduction
---
# Benchmarks & reproduction

deepcode runs two evaluations: an industry-standard set (**SWE-bench Verified**, which measures the
harness in absolute terms) and a self-built reliability eval (which measures whether the same task
succeeds *every* time). Both are reproducible.

## SWE-bench Verified

The industry-standard set, scored by the **official Docker harness against hidden tests** — not
self-scored.

Model fixed to `deepseek-v4-pro`, 100 instances × 3 seeds:

| Metric | Value |
|---|---|
| pass@1 (mean of 3 seeds) | **62.7%** (188/300) |
| pass^3 (all three seeds, reliability) | **52/100** |
| At least one seed | 71/100 |

Same instances, same model, same judge: a **statistical tie** with a commercial harness — of the
25 instances where the two differed, each won about half; two-tailed sign test p=1.0.
**No victory claimed.** This is a tie with statistical weight behind it.

### Why 100 instances and not 23

| Sample | deepcode | Comparison | Δ |
|---|---|---|---|
| 23 instances | 43.5% | 42.0% | +1.5 (noise) |
| 100 instances | **62.7%** | **62.3%** | **+0.4 (tie)** |

The "lead" at small sample size was sampling noise; it regressed to a tie once the sample grew.
**This is exactly why you shouldn't claim a win from a small sample** — publishing the 23-instance
result would have meant publishing a conclusion we later had to retract ourselves.

### Sampling and scoring rules

- 100 instances: seed 42 fixed, representative sample, django excluded, anything projected >4h excluded.
- The 23 timed-out instances were re-run at 1800s and folded back in.
- Patch extraction is identical for both sides: `git diff base_commit`, **minus any test file touched
  by that instance's `test_patch`** — so "edit the test until it passes" can't work.
- Scoring runs on native x86_64 Linux Docker. No arm emulation.

### Fairness anchors

What's measured is the **harness**, not the model. Every controlled variable is stated in the open:

| Item | Value |
|---|---|
| Model & endpoint | Both sides hit the identical base URL and model ID |
| temperature | Neither sends one; the model's default applies |
| Instance set | The same subset |
| Task input | The same problem_statement plus the same "only edit non-test source" framing prompt |
| Patch extraction | The same rule (above) |
| Scoring | Official SWE-bench Docker, hidden FAIL_TO_PASS + PASS_TO_PASS |
| Seeds | Identical count per cell |

**The differences under test are the harness itself**: navigation strategy, edit format, verification
and self-checking, context management, tool set, subagent delegation.

### Honest limits

::: warning Two things worth stating plainly
1. **SWE-bench Verified is a public set and may already be contaminated** by training data. Squeezing
   that out requires an uncontaminated set (SWE-bench Pro, say). It applies equally to both sides of
   the comparison, but it does inflate the absolute numbers.
2. **The generation machine is not controlled**: both sides ran on the same local machine but in
   different runtime shapes. That doesn't affect the patches the model produces, only wall-clock
   time — so **timing is informational and not part of any conclusion**.
:::

### Run it yourself

Method, scripts and raw data (scoring matrices plus prediction patches) are public in
[deepcode-arena](https://github.com/SilasSolivagus/deepcode-arena): clone it, add your keys,
one command reproduces the result.

## Self-built reliability eval

SWE-bench measures whether it *can* be done. This one measures whether it's done right **every
time you ask**.

Anti-contamination custom scenarios × 5 models × 3 seeds of **pass^3** (all three must pass),
scored programmatically. `deepseek-v4-pro` / `glm-5.2` / `kimi-k3` each pass 5/5 scenarios.

### Why pass^N instead of pass@1

A model that passes once and fails twice looks fine under pass@1. In practice `deepseek-flash`
scored only 1/3 on the hardest evaluator scenario — **a single run would have called it OK; only
multiple seeds exposed the flakiness.** For a tool you intend to put in an automated pipeline,
reliability matters more than peak capability.

```bash
node eval/run.mjs --models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo,glm-5.2 --seeds 3
```

Full report:
[`eval/RESULTS-2026-07-17.md`](https://github.com/SilasSolivagus/deepcode/blob/main/eval/RESULTS-2026-07-17.md).
Cost-reliability Pareto chart: [the benchmark section on the site](https://deepcode.dirctable.com/#bench).

## Not done yet

- An uncontaminated set (SWE-bench Pro) to squeeze out possible training contamination
- A full comparison on `kimi-k3`
- Scaling to all 500 SWE-bench Verified instances
