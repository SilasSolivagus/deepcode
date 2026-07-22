---
title: 概览
---

# 概览

deepcode 是一个**直连 DeepSeek / GLM / Kimi 的终端编码 agent**：工具编排、权限、记忆、子代理、工作流一应俱全，每一行都在你手里，不是套壳，也不是黑盒 harness。

## 独创点

- **原生多 provider，运行时切换**：一套 harness 通吃 DeepSeek / GLM / Kimi / 自建后端，方言 adapter 统一各厂 usage、缓存命中、thinking 三态字段，切厂无感。
- **国产 thinking 模型的成本控制**：显式 `thinking: disabled` 默认关闭，省下约 39× 输出 token；并修复国产 thinking 模型在短回答、门控场景下 content 被 reasoning 击穿的坑。
- **自带记忆系统**：per-project 记忆 + 跨项目全局抽屉 + `dream` 后台归纳 + `SearchMemory` 全文检索（node:sqlite FTS5，零依赖），信号门控只在有持久信息时提取，无感主动召回。
- **可复现 eval harness**：防污染场景 × 多模型 × N seeds × 程序化判分，一键出 pass^N 可靠性与成本-Pareto 回归报告，把「便宜模型的可靠性/元」做成一等指标。
- **国产多模态**：GLM-4.6v 视觉透传 + GLM-OCR 文档输入，模型无关地注入主循环。
- **权限与安全**：allow/ask/deny 三桶 + auto 模式分类器 + 分层 settings + SSRF 防护 + git worktree 隔离子代理，放手干活，边界你说了算。

## 适合谁

适合想在终端用国产大模型、又要国际一线闭源 agent 的体验与完全掌控感的开发者。

## 拥有，而非租房

DeepSeek 等厂商提供兼容接口，两行环境变量就能把国际一线闭源 agent 接到国产模型上——但那是**租房**：harness 是黑盒，系统提示词与工具描述是为别的模型调教的，兼容层还会丢字段。deepcode 是**拥有**：

| | 兼容接口 + 闭源 agent | deepcode |
|---|---|---|
| 系统提示词 / 工具描述 | 为别的模型调教 | 为国产模型撰写，可逐字调 |
| 兼容层 | 忽略部分字段、有转译损耗 | 直连原生 OpenAI 兼容接口，无转译 |
| thinking 成本 | 由 agent 行为决定 | 显式 `disabled` 默认关（省 ~39× 输出 token） |
| 多 provider | 单一 | DeepSeek / GLM / Kimi / 自建，运行时切 |
| 可改性 | 不可改 | 每一行都是你的 |

## 下一步

- [快速上手](/guide/quickstart)：30 秒装好、跑起第一个任务。
- [如何工作](/guide/how-it-works)：主循环、工具、权限与记忆的整体架构。
