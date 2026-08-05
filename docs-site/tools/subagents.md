---
title: 子代理 & worktree
---
# 子代理 & worktree

子代理是**一次性的、上下文隔离的**执行单元：主代理用 `Agent` 工具派出去，它跑完把结论作为
一段文本交回来，然后消失。

## 为什么要它

两个理由，第二个更实在：

1. **省上下文**——搜代码常要翻十几个文件，这些中间过程主代理不需要知道，只需要结论。
2. **换一双眼睛**——子代理看不到当前对话，只能拿到你写给它的 prompt。这既是限制也是价值：
   它不会被主代理已有的判断带偏。验证类子代理就是靠这一点成立的。

::: warning 子代理看不到对话历史
`prompt` 必须**自包含**：路径、要找什么、期望什么格式的输出，都得写进去。写「继续刚才那个」
它是看不懂的。
:::

## 内置类型

| 类型 | 用途 | 工具 | 模型 |
|---|---|---|---|
| `general-purpose` | 研究复杂问题、搜代码、执行多步任务；不确定能否一次命中时用它 | 全部 | 继承父级 |
| `Explore` | 快速只读搜代码 / 定位实现，可指定 quick / medium / very thorough 力度 | 除 Edit/Write/NotebookEdit/Agent | **fast 档**（便宜） |
| `Plan` | 软件架构师，设计实施计划 | 除 Edit/Write/NotebookEdit/Agent | 继承父级 |
| `verification` | 独立验证一处实现是否真能用，返回 PASS / FAIL / PARTIAL 与证据 | 除 Edit/Write/NotebookEdit/Agent（**保留 Bash**） | 继承父级 |

`verification` 由 flag 门控，默认不注册——见下方[验证子代理](#验证子代理)。

### 所有子代理一律禁用的工具

```
ExitPlanMode  EnterWorktree  ExitWorktree  Workflow
ScheduleWakeup  CronCreate  CronList  CronDelete
Monitor  TaskStop  PushNotification
```

这些要么会改变会话级状态，要么会派生更多任务——**子代理不能自己再开分支**，否则失控成本不可控。

## 怎么调

```
Agent(
  description: "一句话描述（显示给用户）",
  prompt:      "完整任务指令，必须自包含",
  subagent_type: "Explore",          // 省略 = general-purpose
  run_in_background: true,           // 可选：后台跑，完成时通知
  isolation: "worktree"              // 可选：隔离到临时 git worktree
)
```

## worktree 隔离

`isolation: "worktree"` 会给子代理开一个临时 git worktree——**仓库的隔离副本**。

- 子代理的 cwd 锚定在 worktree 里，系统提示追加隔离说明
- 跑完**没有改动就自动清理**；有改动则返回 worktree 路径与分支，交给你决定怎么合
- 代价：每个 worktree 有创建开销和磁盘占用

什么时候用：**多个子代理并行改同一个仓库**时。不然它们会互相踩。单个子代理、或者只读任务，
不需要隔离。

可在 settings 的 `worktree` 里配 `symlinkDirectories`（软链进 worktree 的目录，如
`node_modules`）与 `sparsePaths`。

## 轮次预算与截断

每个子代理有独立的轮次预算，默认 **30 轮**。`verification` 类型是 **50 轮**。

::: danger 撞上限时的返回值不是结论
子代理烧完预算被截断时，返回内容前面会带一段明确警示，写明**这是被截断的中间状态、不是结论，
不得据此声称任务已完成或已验证**。

这条警示是补出来的。此前撞上限只封一句中性的「已达最大轮数上限，已停止」，父代理拿到手与
「正常收工但没多说什么」无从分辨——实测后果是一个验证子代理被截断、从未给出结论，父代理却
照常收工并在交付陈述里写下「已验证」。**有验证机制而这样失效，比没有更糟**：交付物挂上了
一个没人挣来的「已验证」标题。
:::

如果子代理反复撞上限，先想的不该是调大预算。实测：跑成的那次**干活最多却用轮次最少**——
因为它把彼此独立的检查并成一轮批量发；失败的那些是一轮一条，把预算烧在了往返上。

## 验证子代理

一个专职「试图弄坏这份实现」的子代理，**判定权归它独占**——主代理不能自评通过。

- 禁止修改项目文件（`Edit`/`Write`/`NotebookEdit` 全禁），但**保留 `Bash`**：它要靠 Bash
  跑构建、跑测试、跑针对性检查，也靠重定向往 `/tmp` 写一次性脚本。禁的是碰项目文件，不是
  禁止写任何文件。
- 输出格式是强制的：每条检查必须带「跑了什么命令」与「看到什么输出」，**没有命令块的检查
  不算 PASS，算跳过**。最后一行必须是 `VERDICT: PASS` / `FAIL` / `PARTIAL` 之一。
- 收到 FAIL 就修，然后派**一个新的**验证者（子代理无法续跑），带上上一轮的原始 findings。
- 收到 PASS 后要抽 2-3 条它报告里的命令自己重跑对账。

::: info 默认关闭
这套机制由 `DEEPCODE_FLAGS='{"verificationAgent":true}'` 门控，且只在 headless 注入合同。
默认关是因为**它还没被证明稳定**：实测里同样的提示词、同样的开关，有的跑主动派了验证者、
有的跑一次都没派。要翻默认值得先有跑前冻结判据的 A/B 结果。
:::

## 自定义子代理

在 `.deepcode/agents/` 下放 `*.md`，一个文件一个类型：

```markdown
---
name: reviewer
description: 审阅一段改动，指出正确性问题。传入 diff 与原始需求。
tools: [Read, Grep, Glob, Bash]
model: inherit
---

你是代码审阅者。只看正确性，不评风格。
...（这段正文就是它的系统提示）
```

| frontmatter 字段 | 说明 |
|---|---|
| `name` | **必填**，即 `subagent_type` 的取值 |
| `description` | **必填**，喂给模型判断何时该用它 |
| `tools` | allow 列表；省略或 `['*']` = 全池减去全局禁用项 |
| `disallowedTools` | deny 列表 |
| `model` | `inherit`（默认）或具体档位 |

正文（frontmatter 之后的全部内容）就是这个子代理的系统提示。

**加载与覆盖**：用户级（`~/.deepcode/agents/`）先于项目级（`<项目>/.deepcode/agents/`），
同名后者覆盖前者；自定义同名会覆盖内置类型。缺 `name` 或 `description` 的文件直接跳过，
单个文件坏了不影响其它。

## 后台子代理

`run_in_background: true` 让子代理脱离当前回合去跑，完成时通知你。适合耗时长、你不想干等的
调研任务。用 `/stop` 可以列出并停止运行中的后台会话。

---

相关：[工具总览](/tools/overview) · [工作流](/tools/workflows) · [权限模式](/usage/permissions)
