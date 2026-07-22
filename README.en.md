<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/header.svg" width="820" alt="deepcode — terminal coding agent, direct to DeepSeek / GLM / Kimi">
</p>

<p align="center">
  <a href="https://deepcode.dirctable.com"><img src="https://img.shields.io/badge/website-deepcode.dirctable.com-5b7cfa" alt="website"></a>
  <a href="https://www.npmjs.com/package/@silassolivagus/deepcode"><img src="https://img.shields.io/npm/v/@silassolivagus/deepcode?color=5b7cfa&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@silassolivagus/deepcode"><img src="https://img.shields.io/npm/dm/@silassolivagus/deepcode?color=5b7cfa&label=downloads" alt="downloads"></a>
  <a href="https://github.com/SilasSolivagus/deepcode/stargazers"><img src="https://img.shields.io/github/stars/SilasSolivagus/deepcode?color=5b7cfa" alt="stars"></a>
  <img src="https://img.shields.io/badge/license-MIT-5b7cfa" alt="license">
  <img src="https://img.shields.io/node/v/@silassolivagus/deepcode?color=5b7cfa" alt="node">
</p>

<p align="center">
  <b>A terminal coding agent that talks directly to DeepSeek / GLM / Kimi.</b><br>
  The cost-efficiency of Chinese models, with full tool orchestration · permissions · memory · subagents · workflows — <b>every line of it in your hands</b>.
</p>
<p align="center">🌐 Website · <a href="https://deepcode.dirctable.com">deepcode.dirctable.com</a></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/demo.gif" width="820" alt="deepcode terminal session: Grep/Read tool calls → a substantive answer citing line numbers → cost line settled">
</p>
<p align="center"><sub>For developers who want to run Chinese LLMs from the terminal, with the experience and full control you'd expect from top-tier closed-source agents.</sub></p>

## 30-Second Quickstart

```bash
npm i -g @silassolivagus/deepcode   # 需要 Node ≥ 22.5
deepcode                             # 首跑向导粘 key，直接用
```

Defaults to `deepseek-v4-pro`. Already have a key? `export DEEPSEEK_API_KEY=sk-...` and you're set. To switch to GLM / Kimi / a self-hosted backend, see [Configuration](#configuration) below.

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costCNY）
```

## Real Benchmarks, Not Slides

A reproducible, self-built eval harness (`eval/`) pitted against top-tier closed-source agents on the same tasks. **Anti-contamination custom scenarios × 5 models × 3 seeds of pass^3** (borrowing the reliability philosophy of τ-bench, built specifically to catch flakiness), scored programmatically — not by subjective judgment.

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/benchmark.svg" width="840" alt="Cost-reliability Pareto: deepseek-v4-pro is fully reliable and 7–10× cheaper; ties top-tier closed-source agents across four task categories">
</p>

- **Pareto winner = `deepseek-v4-pro`**: deepseek-v4-pro / glm-5.2 / kimi-k3 all pass 5/5 scenarios at pass^3; deepseek-v4-pro costs only **¥0.68 — 7–10× cheaper**.
- **Matches top-tier closed-source agents**: across four real-world task categories — Office-suite automation, web-connected deep research, data analysis, and a complex evaluator — output is tied.
- **Kimi is equally reliable**: `kimi-k3` passes 5/5 (including the hardest evaluator task), a good fit for the Kimi ecosystem or 1M-context scenarios, at the cost of the highest price tag (¥6.56).
- **pass^N catches flakiness**: deepseek-flash only passes 1/3 on the evaluator task — a single run would look fine, but multiple seeds expose the unreliability. That's exactly the point of a reliability metric.

> Honest caveat: on the hardest deep-reasoning work (subtle algorithmic bugs / huge codebases / deep architecture decisions), top-tier closed-source agents may still lead — mostly a gap in **model capability**, not the harness. Full report: [`eval/RESULTS-2026-07-17.md`](eval/RESULTS-2026-07-17.md).

## Why Not Just Run a Closed-Source Agent Through a Compatibility Endpoint?

DeepSeek offers a [compatible endpoint](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api) — two environment variables and you can point a closed-source terminal agent at DeepSeek. But that's **renting**: the harness is a black box, its system prompt and tool descriptions were tuned for a different model, and the compatibility layer drops fields along the way. deepcode is **owning**:

| | Compat endpoint + closed-source agent | deepcode |
|---|---|---|
| System prompt / tool descriptions | Tuned for a different model | Written for Chinese models, editable line by line |
| Compatibility layer | Drops fields, translation loss | Direct native OpenAI-compatible endpoint, no translation |
| thinking cost | Determined by the agent's own behavior | Explicitly `disabled` by default (saves ~39× output tokens) |
| Multi-provider | Single provider | DeepSeek / GLM / Kimi / self-hosted, switch at runtime |
| Modifiability | Not modifiable | Every line is yours |

## Differentiators

<table>
<tr>
<td width="50%" valign="top">

**🔀 Native multi-provider, switch at runtime**

One harness covers DeepSeek / GLM / Kimi / self-hosted backends; a dialect adapter layer normalizes each vendor's usage, cache-hit, and thinking tri-state fields so switching vendors is seamless (including Kimi's thinking-only models k2.7-code/k3, with automatic error avoidance).

</td>
<td width="50%" valign="top">

**💰 Cost control for Chinese thinking models**

Turning off thinking by default saves ~39× output tokens; also fixes a real bug where, on short answers or gated scenarios, Chinese thinking models let reasoning tokens crowd out content — a problem you'd never hit going straight to a closed-source agent.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🧠 Built-in memory system**

Per-project memory + a cross-project global drawer + background "dream" consolidation + `SearchMemory` full-text search (node:sqlite FTS5, zero dependencies); signal-gated extraction only fires when there's something worth keeping, giving unobtrusive proactive recall and continuity across projects.

</td>
<td width="50%" valign="top">

**📊 Reproducible eval harness**

Anti-contamination scenarios × multiple models × N seeds × programmatic scoring, one command producing pass^N reliability plus cost-Pareto regression reports — turning "reliability per yuan of a cheap model" into a first-class metric.

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🖼️ Chinese multimodal support**

GLM-4.6v vision pass-through and GLM-OCR document input, injected into the main loop model-agnostically.

</td>
<td width="50%" valign="top">

**🛡️ Permissions & security**

allow/ask/deny three-bucket model + an auto-mode classifier + layered settings + SSRF protection + git-worktree-isolated subagents — let it run, you decide the boundaries.

</td>
</tr>
</table>

<a id="configuration"></a>
<details>
<summary><b>Configuration</b> (env / wizard / settings.json, switching GLM · Kimi · self-hosted)</summary>

Pick one (priority: env > settings):
- On first run of `deepcode`, paste your key into the wizard (written to `~/.deepcode/settings.json`, mode 600)
- Or `export DEEPSEEK_API_KEY=sk-...`
- Or hand-edit `~/.deepcode/settings.json`

**Switching provider**:

```jsonc
{
  "provider": "kimi",                       // deepseek(默认) | glm | kimi | custom
  "providers": { "kimi": { "apiKey": "..." } }
}
```

- **GLM · Zhipu**: `provider: "glm"` + `providers.glm.apiKey` (or env `ZHIPUAI_API_KEY`).
- **Kimi · Moonshot**: ships with `kimi-k3` / `kimi-k2.7-code` / `k2.6` / `k2.5`, defaulting to smart=`kimi-k2.7-code` (code-specialized), fast=`kimi-k2.5`; env `MOONSHOT_API_KEY` also works.
- **custom**: any OpenAI-compatible backend — set `baseURL` / `models` / `apiKeyEnv`.
- Behind a proxy? Set `https_proxy` and deepcode routes through it automatically.

</details>

<details>
<summary><b>Usage & Commands</b></summary>

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costCNY）
echo "<任务>" | deepcode     # 管道喂入走 headless
```

- `@file` references a file, `!command` runs shell directly, `/` pops up the command menu
- Common commands: `/model` (switch model/provider), `/think`, `/accept`, `/auto`, `/plan`, `/cost`, `/compact`, `/resume`, `/rewind`, `/memory`, `/permissions`, `/init`, `/help`, `/exit`
- Esc interrupts the current turn (redirect mid-flight), Ctrl+C×2 to quit

</details>

<details>
<summary><b>Capabilities</b> (tools / permissions / subagents / long tasks / ecosystem / TUI)</summary>

- **Tools**: Read / Glob / Grep / Bash / Edit / Write / NotebookEdit / WebFetch / WebSearch / SearchMemory …
- **Permissions**: allow/ask/deny three-bucket model + dontAsk + auto mode (a classifier decides run/ask/block) + layered settings (user<project<local<flag) + SSRF protection
- **Subagents & orchestration**: typed subagents (general-purpose/Explore/Plan) + writable subagents + git worktree isolation + background tasks + a multi-agent workflow DSL + FleetView
- **Long tasks**: context compaction (microcompact + auto-trigger + circuit breaker), steering mid-task redirection, plan mode
- **Ecosystem**: MCP (stdio + resource tools), Skills, Hooks lifecycle, custom slash commands
- **TUI**: scrollable ink fullscreen UI + completion menu + themes + statusline

</details>

<details>
<summary><b>Reproducing Evals & Development</b></summary>

```bash
# 复现成本-可靠性 Pareto
node eval/run.mjs --models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo,glm-5.2 --seeds 3

# 开发
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
```

Design principles: control flow belongs to code, intelligence belongs to the model; retries wrap only API stream setup, never replay tool execution; error messages are written for the model to read; tool results are untrusted input.

</details>

---

<p align="center">
  Found this useful? A <a href="https://github.com/SilasSolivagus/deepcode">⭐</a> means a lot · Issues / PRs welcome · MIT
</p>
