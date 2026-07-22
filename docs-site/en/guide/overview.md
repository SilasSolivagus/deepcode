---
title: Overview
---

# Overview

deepcode is a **terminal coding agent that talks directly to DeepSeek / GLM / Kimi**: full tool orchestration, permissions, memory, subagents, and workflows — every line of it in your hands, not a wrapper and not a black-box harness.

## What makes it different

- **Native multi-provider, switch at runtime**: one harness covers DeepSeek / GLM / Kimi / self-hosted backends; a dialect adapter layer normalizes each vendor's usage, cache-hit, and thinking tri-state fields, so switching vendors is seamless.
- **Cost control for Chinese thinking models**: `thinking: disabled` by default saves roughly 39× on output tokens, and fixes a real bug where, on short answers or gated scenarios, Chinese thinking models let reasoning tokens crowd out content.
- **Built-in memory system**: per-project memory + a cross-project global drawer + background "dream" consolidation + `SearchMemory` full-text search (node:sqlite FTS5, zero dependencies), with signal-gated extraction that only fires when there's something worth keeping — unobtrusive, proactive recall.
- **Reproducible eval harness**: anti-contamination scenarios × multiple models × N seeds × programmatic scoring, one command producing pass^N reliability plus cost-Pareto regression reports, turning "reliability per yuan of a cheap model" into a first-class metric.
- **Chinese multimodal support**: GLM-4.6v vision pass-through and GLM-OCR document input, injected into the main loop model-agnostically.
- **Permissions & security**: an allow/ask/deny three-bucket model + an auto-mode classifier + layered settings + SSRF protection + git-worktree-isolated subagents — let it run, you decide the boundaries.

## Who it's for

Developers who want to run Chinese LLMs from the terminal, with the experience and full control you'd expect from top-tier closed-source agents.

## Owning, Not Renting

DeepSeek and others offer compatible endpoints — two environment variables and you can point a top-tier closed-source agent at a Chinese model. But that's **renting**: the harness is a black box, its system prompt and tool descriptions were tuned for a different model, and the compatibility layer drops fields along the way. deepcode is **owning**:

| | Compat endpoint + closed-source agent | deepcode |
|---|---|---|
| System prompt / tool descriptions | Tuned for a different model | Written for Chinese models, editable line by line |
| Compatibility layer | Drops fields, translation loss | Direct native OpenAI-compatible endpoint, no translation |
| thinking cost | Determined by the agent's own behavior | Explicitly `disabled` by default (saves ~39× output tokens) |
| Multi-provider | Single provider | DeepSeek / GLM / Kimi / self-hosted, switch at runtime |
| Modifiability | Not modifiable | Every line is yours |

## Next steps

- [Quickstart](/en/guide/quickstart): up and running in 30 seconds.
- [How it works](/en/guide/how-it-works): the main loop, tools, permissions, and memory architecture.
