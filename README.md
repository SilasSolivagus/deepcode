<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/header.svg" width="820" alt="deepcode — 终端编码 agent，直连 DeepSeek / GLM / Kimi">
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
  <b>直连 DeepSeek / GLM / Kimi 的终端编码 agent。</b><br>
  国产模型的性价比，工具编排 · 权限 · 记忆 · 子代理 · 工作流全都有——<b>每一行都在你手里</b>。
</p>
<p align="center">🌐 官网 · <a href="https://deepcode.dirctable.com">deepcode.dirctable.com</a></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/demo.gif" width="820" alt="deepcode 终端会话：Grep/Read 工具调用 → 引用行号的实质答案 → 成本行结算">
</p>
<p align="center"><sub>适合想在终端用国产大模型、又要国际一线 agent 体验与完全掌控感的开发者。</sub></p>

## 30 秒上手

```bash
npm i -g @silassolivagus/deepcode   # 需要 Node ≥ 22.5
deepcode                             # 首跑向导粘 key，直接用
```

默认 `deepseek-v4-pro`。已有 key 就 `export DEEPSEEK_API_KEY=sk-...` 秒开。切 GLM / Kimi / 自建后端见下方 [配置](#配置)。

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costCNY）
```

## 实测，不是 PPT

可复现的自建 eval harness（`eval/`）+ 与顶级闭源 agent 同题对打。**防污染自建场景 × 5 模型 × 3 seed 的 pass^3**（照 τ-bench 可靠性理念，专抓 flaky），程序化判分不靠主观。

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/benchmark.svg" width="840" alt="成本-可靠性 Pareto：deepseek-v4-pro 满分可靠、成本便宜 7–10×；vs 国际一线闭源 agent 四类打平">
</p>

- **Pareto 赢家 = `deepseek-v4-pro`**：deepseek-v4-pro / glm-5.2 / kimi-k3 均跑满 5/5 场景 pass^3；deepseek-v4-pro 仅 **¥0.68——便宜 7–10×**。
- **追平国际一线闭源 agent**：Office 三件套 / 联网深度研究 / 数据分析 / 复杂求值器，四类真实任务产出全部打平。
- **Kimi 同样全可靠**：`kimi-k3` 跑满 5/5（含最难的求值器），适合 Kimi 生态或 1M 上下文场景，代价是成本最高（¥6.56）。
- **pass^N 抓 flaky**：deepseek-flash 求值器仅 1/3——单跑会误判 OK，多 seed 才照出不可靠，这正是可靠性度量的价值。

> 诚实边界：最烧脑的深推理（微妙算法 bug / 超大代码库 / 深架构）上，国际一线闭源 agent 可能仍领先——主要是**模型能力**差距、非 harness。完整报告见 [`eval/RESULTS-2026-07-17.md`](eval/RESULTS-2026-07-17.md)。

## 为什么不直接用兼容接口跑闭源 agent？

DeepSeek 提供 [兼容接口](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)，两行环境变量就能让闭源终端 agent 跑在 DeepSeek 上——但那是**租房**：harness 是黑盒，系统提示词与工具描述是为别的模型调教的，兼容层还会丢字段。deepcode 是**拥有**：

| | 兼容接口 + 闭源 agent | deepcode |
|---|---|---|
| 系统提示词 / 工具描述 | 为别的模型调教 | 为国产模型撰写，可逐字调 |
| 兼容层 | 忽略部分字段、有转译损耗 | 直连原生 OpenAI 兼容接口，无转译 |
| thinking 成本 | 由 agent 行为决定 | 显式 `disabled` 默认关（省 ~39× 输出 token） |
| 多 provider | 单一 | DeepSeek / GLM / Kimi / 自建，运行时切 |
| 可改性 | 不可改 | 每一行都是你的 |

## 差异化亮点

<table>
<tr>
<td width="50%" valign="top">

**🔀 原生多 provider，运行时切换**

一套 harness 通吃 DeepSeek / GLM / Kimi / 自建后端；方言 adapter 统一各厂 usage、缓存命中、thinking 三态字段，切厂无感（含 Kimi 仅思考模式的 k2.7-code/k3，自动规避报错）。

</td>
<td width="50%" valign="top">

**💰 国产 thinking 模型的成本控制**

显式关思考默认省 ~39× 输出 token；并修复国产 thinking 模型短回答/门控场景 content 被 reasoning 击穿的坑——直连闭源 agent 遇不到的问题。

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🧠 自带记忆系统**

per-project + 跨项目全局抽屉 + dream 后台归纳 + `SearchMemory` 全文检索（node:sqlite FTS5，零依赖）；信号门控只在有持久信息时提取，无感主动召回、跨项目连续记忆。

</td>
<td width="50%" valign="top">

**📊 可复现 eval harness**

防污染场景 × 多模型 × N seeds × 程序化判分，一键出 pass^N 可靠性 + 成本-Pareto 回归报告，把「便宜模型的可靠性/元」做成一等指标。

</td>
</tr>
<tr>
<td width="50%" valign="top">

**🖼️ 国产多模态**

GLM-4.6v 视觉透传 + GLM-OCR 文档输入，模型无关地注入主循环。

</td>
<td width="50%" valign="top">

**🛡️ 权限与安全**

allow/ask/deny 三桶 + auto 模式分类器 + 分层 settings + SSRF 防护 + git worktree 隔离子代理——放手干活，边界你说了算。

</td>
</tr>
</table>

<a id="配置"></a>
<details>
<summary><b>配置</b>（env / 向导 / settings.json，切 GLM · Kimi · 自建）</summary>

三选一（优先级 env > settings）：
- 首次运行 `deepcode`，按向导粘贴 key（写入 `~/.deepcode/settings.json`，权限 600）
- 或 `export DEEPSEEK_API_KEY=sk-...`
- 或手写 `~/.deepcode/settings.json`

**切 provider**：

```jsonc
{
  "provider": "kimi",                       // deepseek(默认) | glm | kimi | custom
  "providers": { "kimi": { "apiKey": "..." } }
}
```

- **GLM·智谱**：`provider: "glm"` + `providers.glm.apiKey`（或 env `ZHIPUAI_API_KEY`）。
- **Kimi·Moonshot**：内置 `kimi-k3` / `kimi-k2.7-code` / `k2.6` / `k2.5`，默认 smart=`kimi-k2.7-code`（代码专用）、fast=`kimi-k2.5`；env `MOONSHOT_API_KEY` 亦可。
- **custom**：任意 OpenAI 兼容后端，填 `baseURL` / `models` / `apiKeyEnv`。
- 网络需代理时设 `https_proxy`，deepcode 自动经它请求。

</details>

<details>
<summary><b>用法 & 命令</b></summary>

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costCNY）
echo "<任务>" | deepcode     # 管道喂入走 headless
```

- `@文件` 引用文件、`!命令` 直跑 shell、`/` 浮出命令菜单
- 常用命令：`/model`（切模型/provider）、`/think`、`/accept`、`/auto`、`/plan`、`/cost`、`/compact`、`/resume`、`/rewind`、`/memory`、`/permissions`、`/init`、`/help`、`/exit`
- Esc 中断当前轮（可中途转向），Ctrl+C×2 退出

</details>

<details>
<summary><b>能力</b>（工具 / 权限 / 子代理 / 长任务 / 生态 / TUI）</summary>

- **工具**：Read / Glob / Grep / Bash / Edit / Write / NotebookEdit / WebFetch / WebSearch / SearchMemory …
- **权限**：allow/ask/deny 三桶 + dontAsk + auto 模式（分类器判 run/ask/block）+ 分层 settings（user<project<local<flag）+ SSRF 防护
- **子代理与编排**：类型化子代理（general-purpose/Explore/Plan）+ 可写 subagent + git worktree 隔离 + 后台任务 + 多 agent 工作流 DSL + FleetView
- **长任务**：上下文 compact（microcompact + 自动触发 + 熔断）、steering 中途转向、plan 模式
- **生态**：MCP（stdio + 资源工具）、Skills、Hooks 生命周期、自定义 slash 命令
- **TUI**：ink 全屏可滚 + 补全菜单 + 主题 + statusline

</details>

<details>
<summary><b>评测复现 & 开发</b></summary>

```bash
# 复现成本-可靠性 Pareto
node eval/run.mjs --models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo,glm-5.2 --seeds 3

# 开发
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
```

设计原则：控制流姓代码、智能姓模型；重试只包 API 建流、工具执行不重放；报错写给模型看；工具结果是不可信输入。

</details>

---

<p align="center">
  觉得有用？点个 <a href="https://github.com/SilasSolivagus/deepcode">⭐</a> 是最大的鼓励 · Issues / PR 都欢迎 · MIT
</p>
