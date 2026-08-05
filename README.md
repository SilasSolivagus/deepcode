<p align="center"><b>中文</b> · <a href="README.en.md">English</a></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/header.svg" width="820" alt="deepcode — 终端编码 agent，直连 DeepSeek / GLM / Kimi">
</p>

<p align="center">
  <a href="https://deepcode.dirctable.com"><img src="https://img.shields.io/badge/website-deepcode.dirctable.com-5b7cfa" alt="website"></a>
  <a href="https://deepcode.dirctable.com/docs/"><img src="https://img.shields.io/badge/docs-文档站-5b7cfa" alt="docs"></a>
  <a href="https://www.npmjs.com/package/@silassolivagus/deepcode"><img src="https://img.shields.io/npm/v/@silassolivagus/deepcode?color=5b7cfa&label=npm" alt="npm"></a>
  <a href="https://github.com/SilasSolivagus/deepcode/stargazers"><img src="https://img.shields.io/github/stars/SilasSolivagus/deepcode?color=5b7cfa" alt="stars"></a>
  <img src="https://img.shields.io/badge/license-MIT-5b7cfa" alt="license">
  <img src="https://img.shields.io/node/v/@silassolivagus/deepcode?color=5b7cfa" alt="node">
</p>

<p align="center">
  <b>直连 DeepSeek / GLM / Kimi 的终端编码 agent。</b><br>
  工具编排 · 权限 · 记忆 · 子代理 · 工作流全都有——<b>每一行都在你手里</b>。
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/SilasSolivagus/deepcode/main/assets/demo.gif" width="820" alt="deepcode 演示：一句话需求「写个 mdtoc 命令行工具」→ 它读文件、写代码、跑起来、自己发现问题再改 → 目录出现在 README 里">
</p>

## 30 秒上手

```bash
npm i -g @silassolivagus/deepcode   # 需要 Node ≥ 22.5
deepcode                             # 首跑向导粘 key，直接用
```

```bash
deepcode                    # 交互式 TUI
deepcode -p "<任务>"         # 一次性 headless 输出
deepcode --help             # 全部参数
```

默认 `deepseek-v4-pro`。已有 key 就 `export DEEPSEEK_API_KEY=sk-...` 秒开。
切 GLM / Kimi / 自建后端见 [配置文档](https://deepcode.dirctable.com/docs/config/providers)。

## 这是什么

一个从头写的终端编码 agent，**为国产模型而写**，不是把别的 harness 接到国产 API 上。

系统提示词与工具描述按 DeepSeek / GLM / Kimi 的实际行为逐字调过；thinking 三态、缓存命中、
usage 字段这些各厂方言由 adapter 统一，切厂无感。MIT，没有黑盒，你不喜欢哪行就改哪行。

## 为什么不直接用兼容接口跑闭源 agent？

DeepSeek 提供 [兼容接口](https://api-docs.deepseek.com/zh-cn/guides/anthropic_api)，两行环境变量就能让闭源终端 agent 跑在 DeepSeek 上——但那是**租房**：harness 是黑盒，系统提示词与工具描述是为别的模型调教的，兼容层还会丢字段。deepcode 是**拥有**：

| | 兼容接口 + 闭源 agent | deepcode |
|---|---|---|
| 系统提示词 / 工具描述 | 为别的模型调教 | 为国产模型撰写，可逐字调 |
| 兼容层 | 忽略部分字段、有转译损耗 | 直连原生 OpenAI 兼容接口，无转译 |
| thinking 成本 | 由 agent 行为决定 | 显式 `disabled` 默认关（省 ~39× 输出 token） |
| 多 provider | 单一 | DeepSeek / GLM / Kimi / 自建，运行时切 |
| 可改性 | 不可改 | 每一行都是你的 |

## 实测，不是 PPT

**SWE-bench Verified** —— 行业标准题集，官方 Docker 判分、跑隐藏测试，不是自己给自己打分。
`deepseek-v4-pro` 上 100 题 × 3 seed：

| | |
|---|---|
| pass@1 | **62.7%**（188/300） |
| pass^3（三次全中，可靠性） | **52/100** |

同题、同模型、同判分下，与一个商业 harness **统计打平**——25 道有差异的题里各赢一半，
符号检验 p=1.0。**不宣称胜负**，这是个有统计分量的平局。

自建 eval（`eval/`）另测可靠性：防污染场景 × 5 模型 × 3 seed 的 pass^3，
`deepseek-v4-pro` / `glm-5.2` / `kimi-k3` 均跑满 5/5。

📊 完整方法、公平性锚点与原始数据 → [deepcode-arena](https://github.com/SilasSolivagus/deepcode-arena)（clone 下来能自己复现）
· [成本-可靠性 Pareto](https://deepcode.dirctable.com/#bench) · [自建 eval 报告](eval/RESULTS-2026-07-17.md)

> 诚实边界：
> ① SWE-bench Verified 是**公开集，可能已被训练污染**——要挤掉这部分水分，得加跑未污染集。
> ② 最烧脑的深推理（微妙算法 bug / 超大代码库 / 深架构）上，国际一线闭源 agent 可能仍领先，
> 主要是**模型能力**差距、非 harness。

## 文档

| | |
|---|---|
| 🚀 [快速开始](https://deepcode.dirctable.com/docs/guide/quickstart) | 装好之后的第一个任务 |
| ⚙️ [配置](https://deepcode.dirctable.com/docs/config/settings) · [多 provider](https://deepcode.dirctable.com/docs/config/providers) | 切 GLM · Kimi · 自建后端 |
| 💻 [TUI 用法](https://deepcode.dirctable.com/docs/usage/tui) · [斜杠命令](https://deepcode.dirctable.com/docs/usage/commands) | 交互式怎么用 |
| 🤖 [headless / CI](https://deepcode.dirctable.com/docs/usage/headless) | `-p` · JSON · stream-json · 请求轨迹 |
| 🛡️ [权限模型](https://deepcode.dirctable.com/docs/usage/permissions) | allow/ask/deny · auto 模式 · 分层 settings |
| 🧩 [工具与扩展](https://deepcode.dirctable.com/docs/tools/overview) · [MCP](https://deepcode.dirctable.com/docs/tools/mcp) · [Hooks](https://deepcode.dirctable.com/docs/tools/hooks) | 生态怎么接 |

## 参与进来

项目还很年轻，**现在提的每一条 issue 都会被认真对待**。

- 🐛 **遇到 bug** → [提 issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose)，带上 `deepcode --version` 和复现步骤
- 💡 **想要某个功能** → [提 issue](https://github.com/SilasSolivagus/deepcode/issues/new/choose)，说说你的场景——场景比功能本身更有用
- 🗣️ **想聊聊** → [Discussions](https://github.com/SilasSolivagus/deepcode/discussions)
- 🔧 **想动手** → 先读 [CONTRIBUTING.md](CONTRIBUTING.md)，`npm test` 跑得起来就能开工
- ⭐ **只是觉得有用** → 点个 star，这是目前最有帮助的事

变更记录见 [CHANGELOG.md](CHANGELOG.md)。安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，别开公开 issue。

## 支持这个项目

deepcode 是我一个人在业余时间写的，MIT 开源，不做任何收费功能。

如果它给你省下了时间，可以请我喝杯咖啡——**但真的不必**。点个 star、提一条能复现的 bug、
或者告诉我你在什么场景下用它，对现在这个阶段的项目帮助更大。

<p align="center">
  <img src="assets/wechat-pay.jpg" width="200" alt="微信赞赏码">
</p>

## 本地开发

```bash
git clone https://github.com/SilasSolivagus/deepcode && cd deepcode && npm i
npm test           # vitest
npm run typecheck  # tsc --noEmit
npm run build      # tsc -p tsconfig.build.json
```

设计原则：控制流姓代码、智能姓模型；重试只包 API 建流、工具执行不重放；报错写给模型看；工具结果是不可信输入。

---

<p align="center">
  MIT · Issues / PR 都欢迎 · 觉得有用点个 <a href="https://github.com/SilasSolivagus/deepcode">⭐</a>
</p>
