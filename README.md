<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/header.svg" width="820" alt="deepcode — 为 DeepSeek 与 GLM 打造的终端编码 agent">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@silassolivagus/deepcode"><img src="https://img.shields.io/npm/v/@silassolivagus/deepcode?color=5b7cfa&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/node/v/@silassolivagus/deepcode?color=5b7cfa" alt="node">
  <img src="https://img.shields.io/badge/models-DeepSeek%20%C2%B7%20GLM%20%C2%B7%20Kimi-5b7cfa" alt="models">
</p>

**为 DeepSeek 与 GLM 打造的终端编码 agent。** 多 provider、自带记忆系统，低成本高可靠。默认 `deepseek-v4-pro`，一条命令切换 DeepSeek / GLM·智谱 / Kimi·Moonshot / 任意 OpenAI 兼容后端。

```
❯ deepcode
› versions 路由的权限是怎么校验的？
⏺ Grep({"pattern": "versions", "glob": "*route*"})   ← 模型自主并行调用工具
⏺ Read({"file_path": ".../check-role.ts"})
权限校验走统一的 checkRole(minRole)，基于 JWT + users 表角色字段……
[入 3366（缓存命中 2816）出 602]                      ← KV 缓存命中，长会话近乎只付输出 token
```

## 为什么

国产模型便宜、能力也上来了，缺的是一套真正好用、又完全可控的终端 agent。deepcode 直连 DeepSeek/GLM 的原生接口，把工具编排、权限、上下文压缩、子代理、记忆、工作流都做扎实，让**便宜模型也能干重活、且每一层都在你手里**。

**实测背书**（`eval/RESULTS-2026-07-17.md`，防污染自建场景 × 多模型 × 3 seed 的 pass^3）：

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/benchmark.svg" width="840" alt="成本-可靠性 Pareto：deepseek-v4-pro 同等可靠、成本 1/7">
</p>

同题对打中，deepcode + deepseek-v4-pro 在 Office 文档 / 联网研究 / 数据分析 / 复杂编程四类真实任务上，产出与顶级闭源 agent 打平。

## 独创 · deepcode 的差异化

- **原生多 provider，运行时切换。** 一套 harness 通吃 DeepSeek / GLM / Kimi / 自建 OpenAI 兼容后端；方言 adapter 把不同厂商的 usage、缓存命中、thinking 三态字段统一归一，切厂无感（含 Kimi 仅思考模式的 k2.7-code/k3，自动规避 disabled 报错）。
- **国产 thinking 模型的成本控制。** 显式 `thinking:{type:"disabled"}` 默认关，实测省 ~39× 输出 token；并专门解决了国产 thinking 模型在短回答/门控场景 content 被 reasoning 击穿的坑（`buildThinkingParams` 统一处理）——这是直连闭源 agent 遇不到的问题。
- **自带记忆系统。** per-project + 跨项目全局抽屉 + dream 后台归纳 + `SearchMemory` 全文检索（node:sqlite FTS5，零依赖），信号门控只在真有持久信息时才提取。目标是无感主动召回 + 跨项目连续记忆。
- **可复现 eval harness。** 防污染自建场景 × 多模型 × N seeds × 程序化判分，出 **pass^N 可靠性 + 成本-Pareto**，一键回归（`eval/`）。把「便宜模型上的可靠性/元」做成一等指标。
- **国产多模态集成。** GLM-4.6v 视觉透传 + GLM-OCR 文档输入，模型无关地注入主循环。

## 安装

```bash
npm i -g @silassolivagus/deepcode
```

命令为 `deepcode`。需要 **Node ≥ 22.5**。

## 配置

三选一（优先级 env > settings）：
- 首次运行 `deepcode`，按向导粘贴 key（写入 `~/.deepcode/settings.json`，权限 600）
- 或 `export DEEPSEEK_API_KEY=sk-...`
- 或手写 `~/.deepcode/settings.json`

**切 provider**（DeepSeek / GLM / Kimi / 自建）：
```jsonc
{
  "provider": "kimi",                       // deepseek(默认) | glm | kimi | custom
  "providers": { "kimi": { "apiKey": "..." } }
}
```
Kimi（Moonshot）内置 `kimi-k3` / `kimi-k2.7-code` / `k2.6` / `k2.5`，默认 smart=`kimi-k2.7-code`（代码专用）、fast=`kimi-k2.5`；env `MOONSHOT_API_KEY` 亦可。`custom` 可接任意 OpenAI 兼容后端（填 `baseURL`/`models`/`apiKeyEnv`）。网络需代理时设 `https_proxy`，deepcode 自动经它请求。

## 用法

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode -p "<任务>" --json  # headless + JSON（text/status/turns/usage/costCNY）
echo "<任务>" | deepcode     # 管道喂入走 headless
```

- `@文件` 引用文件、`!命令` 直跑 shell、`/` 浮出命令菜单
- 常用命令：`/model`（切模型/provider）、`/think`、`/accept`、`/auto`、`/plan`、`/cost`、`/compact`、`/resume`、`/rewind`、`/memory`、`/permissions`、`/init`、`/help`、`/exit`
- Esc 中断当前轮（可中途转向），Ctrl+C×2 退出

## 能力

- **工具**：Read / Glob / Grep / Bash / Edit / Write / NotebookEdit / WebFetch / WebSearch / SearchMemory …
- **权限**：allow/ask/deny 三桶 + dontAsk + auto 模式（分类器判 run/ask/block）+ 分层 settings（user<project<local<flag）+ SSRF 防护
- **子代理与编排**：类型化子代理（general-purpose/Explore/Plan）+ 可写 subagent + git worktree 隔离 + 后台任务 + 多 agent 工作流 DSL + FleetView
- **长任务**：上下文 compact（microcompact + 自动触发 + 熔断）、steering 中途转向、plan 模式
- **生态**：MCP（stdio + 资源工具）、Skills、Hooks 生命周期、自定义 slash 命令
- **TUI**：ink 全屏可滚 + 补全菜单 + 主题 + statusline

## 为什么不直接用兼容接口跑闭源 agent？

DeepSeek 提供 [Anthropic 兼容接口](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)，两行环境变量就能让闭源终端 agent 跑在 DeepSeek 上——但那是**租房**：harness 是黑盒，系统提示词与工具描述是为别的模型调教的，兼容层还会丢字段。

| | 兼容接口 + 闭源 agent | deepcode |
|---|---|---|
| 系统提示词/工具描述 | 为别的模型调教 | 为国产模型撰写，可逐字调 |
| 兼容层 | 忽略部分字段、有转译损耗 | 直连原生 OpenAI 兼容接口，无转译 |
| thinking 成本 | 由 agent 行为决定 | 显式 `disabled` 默认关（省 ~39× 输出 token） |
| 多 provider | 单一 | DeepSeek / GLM / 自建，运行时切 |
| 可改性 | 不可改 | 每一行都是你的 |

## 评测

自建可复现 eval harness（`eval/`）：防污染自建场景 × 多模型 × N seeds × 程序化判分，出 **pass^N 可靠性 + 成本/延迟 Pareto**。

```bash
node eval/run.mjs --models deepseek-v4-pro,deepseek-v4-flash,glm-5-turbo --seeds 3
```

## 开发

```bash
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
```

设计原则：控制流姓代码、智能姓模型；重试只包 API 建流、工具执行不重放；报错写给模型看；工具结果是不可信输入。
