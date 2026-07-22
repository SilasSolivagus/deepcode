---
title: Permission modes
---

# Permission modes

Whether a tool call needs a confirmation prompt — and how that prompt gets decided — is controlled by the "permission mode". deepcode has six modes; `Shift+Tab` cycles through five of them, and the footer shows the current mode's label. This page explains how the modes work and how priority is resolved; the actual `permissions.allow`/`ask`/`deny` rule fields are documented in [settings](/en/config/settings).

## The six modes

| Mode | Purpose |
| --- | --- |
| `default` | Default mode: writes and dangerous operations are confirmed one by one against allow/ask/deny rules. |
| `acceptEdits` | Edit/Write are auto-approved with no confirmation; Bash and others still require confirmation. |
| `yolo` | Almost everything is auto-approved with no confirmation prompt; can only be enabled with the `--yolo` startup flag, and is excluded from the `Shift+Tab` cycle. |
| `plan` | Read-only mode: exploration and planning only — any non-read-only operation is rejected outright, until `ExitPlanMode` is called to turn the plan into actual changes. |
| `auto` | Hands the decision to a classifier that judges run / ask / block automatically; read-only operations skip review. Repeated or cumulative high-risk judgments trip a circuit breaker and fall back to asking you. |
| `dontAsk` | No confirmation prompt: reads are approved, and any write that would otherwise need confirmation is automatically denied (not automatically approved). |

`/plan`, `/accept`, and `/dontask` are real typed commands you can use to enter/exit those modes directly. `auto` and `yolo` have no typed command — `auto` can only be entered via the `Shift+Tab` cycle, and `yolo` can only be enabled via the startup flag.

## The Shift+Tab cycle

`Shift+Tab` cycles through five modes (`yolo` is not part of the cycle):

```
default → auto → acceptEdits → plan → dontAsk → default
```

Each switch updates the footer label: `default`, `auto`, `accept` (for `acceptEdits`), `plan`, `⏵⏵DONT-ASK` (for `dontAsk`). `yolo` has no footer label in the cycle — it only takes effect via the `--yolo` startup flag.

## Priority order

`checkPermission` evaluates in the following order, highest priority first:

1. **`deny` rules are highest priority** — a `deny` hit is rejected outright (for Bash commands it's downgraded to a forced confirmation instead of an outright rejection; every other tool is rejected directly). This check runs before the read-only shortcut, `yolo`, `acceptEdits`, and allow/ask rules — no mode can bypass it.
2. **System-level safety backstop** — for example `rm`/`rmdir` targeting a critical system path or the current working directory requires explicit confirmation even in `yolo` mode; this backstop bypasses permission rules entirely, and `yolo` cannot skip it.
3. **Read-only tools / `yolo` / `acceptEdits`** — read-only operations are approved directly; `yolo` approves almost everything; `acceptEdits` only approves `Edit`/`Write`, everything else still goes through the rules below.
4. **allow / ask rules** — a matching `allow` rule approves the call; a matching `ask` rule forces a confirmation prompt even if the same call also matches an `allow` rule or the session is in `yolo` mode.
5. **`auto` mode classifier** — if none of the above matched, the classifier decides run / ask / block.

`dontAsk` does not go through this chain — the moment a confirmation would normally be shown, it's decided as a rejection instead. In practice that behaves as "reads approved, writes all denied."

## `plan` mode is read-only

In `plan` mode, any non-read-only tool call is rejected outright without going through the allow/ask evaluation. To turn a plan into actual file changes, call `ExitPlanMode` to ask for your approval; once approved, the read-only restriction lifts.

## Viewing saved rules

`/permissions` shows the currently active allow/ask/deny rules and each rule's source layer. You can also delete a rule with `/permissions rm <number>`, `deny-rm <number>`, or `ask-rm <number>`.

## Rule field configuration

How to write the `permissions.allow`/`ask`/`deny` rule fields, and which config layer they belong in, is documented in [settings](/en/config/settings) — this page covers the interactive modes themselves.

---

Next: [settings and environment variables](/en/config/settings).
