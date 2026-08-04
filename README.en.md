<p align="center"><a href="README.md">中文</a> · <b>English</b></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/header.svg" width="820" alt="deepcode — terminal coding agent, direct to DeepSeek / GLM / Kimi">
</p>

<p align="center">
  <a href="https://deepcode.dirctable.com"><img src="https://img.shields.io/badge/website-deepcode.dirctable.com-5b7cfa" alt="website"></a>
  <a href="https://deepcode.dirctable.com/docs/en/"><img src="https://img.shields.io/badge/docs-documentation-5b7cfa" alt="docs"></a>
  <a href="https://www.npmjs.com/package/@silassolivagus/deepcode"><img src="https://img.shields.io/npm/v/@silassolivagus/deepcode?color=5b7cfa&label=npm" alt="npm"></a>
  <a href="https://github.com/SilasSolivagus/deepcode/stargazers"><img src="https://img.shields.io/github/stars/SilasSolivagus/deepcode?color=5b7cfa" alt="stars"></a>
  <img src="https://img.shields.io/badge/license-MIT-5b7cfa" alt="license">
  <img src="https://img.shields.io/node/v/@silassolivagus/deepcode?color=5b7cfa" alt="node">
</p>

<p align="center">
  <b>A terminal coding agent that talks directly to DeepSeek / GLM / Kimi.</b><br>
  Tool orchestration · permissions · memory · subagents · workflows — <b>every line of it in your hands</b>.
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/demo.gif" width="820" alt="deepcode terminal session: Grep/Read tool calls → a substantive answer citing line numbers → cost line settled">
</p>

## 30-Second Quickstart

```bash
npm i -g @silassolivagus/deepcode   # requires Node >= 22.5
deepcode                             # first run walks you through pasting a key
```

```bash
deepcode                    # interactive TUI
deepcode -p "<task>"        # one-shot headless output
deepcode --help             # all flags
```

Defaults to `deepseek-v4-pro`. Already have a key? `export DEEPSEEK_API_KEY=sk-...` and you're set.
To switch to GLM / Kimi / a self-hosted backend, see the
[configuration docs](https://deepcode.dirctable.com/docs/en/config/providers).

## What This Is

A terminal coding agent written from scratch **for Chinese LLMs** — not someone else's harness
pointed at a Chinese API.

System prompts and tool descriptions are tuned line by line against how DeepSeek / GLM / Kimi
actually behave. Vendor dialects — thinking modes, cache-hit accounting, usage fields — are
normalized by an adapter layer, so switching providers is seamless. MIT, no black boxes: don't
like a line? Change it.

## Why Not Just Run a Closed-Source Agent Through a Compatibility Endpoint?

DeepSeek offers a [compatibility endpoint](https://api-docs.deepseek.com/guides/anthropic_api),
and two environment variables will point a closed-source terminal agent at DeepSeek — but that's
**renting**: the harness is a black box, its system prompts and tool descriptions were tuned for
a different model, and the compatibility layer drops fields. deepcode is **owning**:

| | Compat endpoint + closed-source agent | deepcode |
|---|---|---|
| System prompts / tool descriptions | Tuned for a different model | Written for Chinese models, editable line by line |
| Compatibility layer | Drops some fields, lossy translation | Direct to the native OpenAI-compatible API, no translation |
| Thinking cost | Determined by agent behavior | Explicitly `disabled` by default (~39× fewer output tokens) |
| Multi-provider | Single | DeepSeek / GLM / Kimi / self-hosted, switchable at runtime |
| Modifiability | None | Every line is yours |

## Real Benchmarks, Not Slides

A reproducible, self-built eval harness (`eval/`): anti-contamination scenarios × 5 models ×
3 seeds of **pass^3**, scored programmatically rather than by subjective judgment.
`deepseek-v4-pro` / `glm-5.2` / `kimi-k3` each pass 5/5 scenarios; `deepseek-v4-pro` is the cheapest.

📊 **Full results and the cost-reliability Pareto chart** →
[benchmark section](https://deepcode.dirctable.com/#bench) · [raw report](eval/RESULTS-2026-07-17.md)

> Honest caveat: on the hardest deep-reasoning work (subtle algorithmic bugs / huge codebases /
> deep architecture decisions), top-tier closed-source agents may still lead — mostly a gap in
> **model capability**, not the harness.

## Documentation

| | |
|---|---|
| 🚀 [Quickstart](https://deepcode.dirctable.com/docs/en/guide/quickstart) | Your first task after install |
| ⚙️ [Configuration](https://deepcode.dirctable.com/docs/en/config/settings) · [Providers](https://deepcode.dirctable.com/docs/en/config/providers) | GLM · Kimi · self-hosted backends |
| 💻 [TUI](https://deepcode.dirctable.com/docs/en/usage/tui) · [Slash commands](https://deepcode.dirctable.com/docs/en/usage/commands) | Using it interactively |
| 🤖 [Headless / CI](https://deepcode.dirctable.com/docs/en/usage/headless) | `-p` · JSON · stream-json · request traces |
| 🛡️ [Permissions](https://deepcode.dirctable.com/docs/en/usage/permissions) | allow/ask/deny · auto mode · layered settings |
| 🧩 [Tools & extensions](https://deepcode.dirctable.com/docs/en/tools/overview) · [MCP](https://deepcode.dirctable.com/docs/en/tools/mcp) · [Hooks](https://deepcode.dirctable.com/docs/en/tools/hooks) | Wiring up the ecosystem |

## Getting Involved

The project is young — **every issue filed right now gets real attention.**

- 🐛 **Hit a bug** → [open an issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose) with `deepcode --version` and repro steps
- 💡 **Want a feature** → [open an issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose) describing your *scenario* — that's more useful than the feature itself
- 🗣️ **Just want to talk** → [Discussions](https://github.com/SilasSolivagus/deepcode/discussions)
- 🔧 **Want to hack on it** → read [CONTRIBUTING.md](CONTRIBUTING.md); if `npm test` runs, you're ready
- ⭐ **Just find it useful** → a star is genuinely the most helpful thing right now

Changes are tracked in [CHANGELOG.md](CHANGELOG.md). For security issues, please follow
[SECURITY.md](SECURITY.md) rather than opening a public issue.

## Local Development

```bash
git clone https://github.com/SilasSolivagus/deepcode && cd deepcode && npm i
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
```

Design principles: control flow belongs to code, intelligence belongs to the model; retries wrap
API stream creation only, never tool execution; error messages are written for the model to read;
tool results are untrusted input.

---

<p align="center">
  MIT · Issues and PRs welcome · Find it useful? Leave a <a href="https://github.com/SilasSolivagus/deepcode">⭐</a>
</p>
