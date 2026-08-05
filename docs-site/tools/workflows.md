---
title: 工作流
---
# 工作流

工作流是**用一段 JavaScript 脚本编排多个子代理**：什么并行、什么串行、什么条件下重试，
由代码决定，不由模型临场发挥。

## 什么时候用

不是「多派几个子代理」就该上工作流。真正的判据是**控制流该由代码定还是由模型定**：

| 该用工作流 | 不该用 |
|---|---|
| 要覆盖一批已知的东西（20 个文件各审一遍） | 一次性的探索任务 |
| 要多个独立视角再汇总（三个评审各判一次，取多数） | 一个子代理就能答的问题 |
| 规模超出单个上下文（全仓库迁移） | 步骤之间强耦合、必须看着上一步结果才知道下一步干嘛 |

::: warning 它会花很多钱
一个工作流可能派出几十个子代理。**默认会先提示消费警告**，可用 settings 的
`skipWorkflowUsageWarning` 关掉，但先想清楚值不值。
:::

## 脚本长什么样

必须以 `export const meta = {...}` 开头，且**只能是纯字面量**——不能有变量、函数调用、展开
或模板插值（要在跑之前就能静态解析出它是什么）。

```js
export const meta = {
  name: 'review-changes',
  description: '按维度审阅改动，每条发现独立复核',
  phases: [{ title: '审阅' }, { title: '复核' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: '找正确性问题…' },
  { key: 'perf', prompt: '找性能问题…' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `review:${d.key}`, phase: '审阅', schema: FINDINGS }),
  review => parallel(review.findings.map(f => () =>
    agent(`对抗性复核这条：${f.title}`, { phase: '复核', schema: VERDICT })
      .then(v => ({ ...f, verdict: v })))),
)

return { confirmed: results.flat().filter(Boolean).filter(f => f.verdict?.isReal) }
```

## 可用的函数

| 函数 | 作用 |
|---|---|
| `agent(prompt, opts?)` | 派一个子代理。不给 `schema` 时返回它的最终文本；给了就强制结构化输出并返回校验过的对象 |
| `parallel(thunks)` | 并发跑一批，**这是屏障**——全部完成才返回 |
| `pipeline(items, ...stages)` | 每个 item 独立走完全部 stage，**阶段之间没有屏障** |
| `phase(title)` | 开始一个新阶段，后续 `agent()` 归到这个分组显示 |
| `log(msg)` | 往进度显示里打一行 |
| `workflow(name, args?)` | 内联跑另一个工作流（只能嵌套一层） |
| `args` | Workflow 工具传进来的 JSON 值 |

`agent()` 的选项：`label`（显示名）、`phase`（归组）、`schema`（JSON Schema，强制结构化输出）、
`model`、`effort`、`isolation: 'worktree'`、`agentType`。

### pipeline 是默认选择，parallel 是例外

这是最容易做错的一处。`parallel` 是屏障：**最慢的那个不跑完，后面一个都别想动**。

```js
// 别这么写：中间那个 transform 根本不需要屏障
const a = await parallel(...)
const b = transform(a)          // 只是 flatten/map/filter
const c = await parallel(b.map(...))
```

只有当**第 N 阶段真的需要第 N−1 阶段的全部结果**时才该用屏障——比如要跨全部结果去重、
或者要「一个都没找到就整段跳过」。其余情况用 `pipeline`：item A 可以在第 3 阶段，
而 item B 还在第 1 阶段。

## 上限

| | 值 | 说明 |
|---|---|---|
| 并发 | `min(16, CPU 核数 − 2)` | 超出的排队，不是丢弃 |
| 单次 `parallel`/`pipeline` 的条目 | 4096 | **超了直接报错，不静默截断** |
| 单个工作流累计子代理数 | 1000 | 跑飞了的兜底 |

「不静默截断」是刻意的：截断会让你以为覆盖全了，实际漏了一半——那比报错难查得多。

## 脚本是确定性的

沙箱里 **`Date.now()`、`Math.random()`、无参 `new Date()` 都被删掉了**，调用会抛错。
`import()` 也不可用。

理由是**断点续跑**：`resumeFromRunId` 靠「同样的脚本 + 同样的参数 = 同样的调用序列」来判断
哪些 `agent()` 可以直接复用缓存结果。脚本里只要有一处随机或时间依赖，这个前提就没了。

需要时间戳就通过 `args` 传进去，或者等工作流返回之后再打。

## 断点续跑

每次跑都会返回一个 `runId`。用 `Workflow({ scriptPath, resumeFromRunId })` 重跑时：
**没改动过的那一段前缀直接返回缓存结果，从第一个改动过的调用开始才真跑。**

改完脚本重跑一遍不用从头烧一次钱——这也是上面那条「必须确定性」的由来。

## 三种调用方式

```
Workflow({ script: "..." })                    // 内联脚本
Workflow({ name: "review-changes" })           // 预定义：先找项目 .deepcode/workflows/，再找 ~/.deepcode/workflows/
Workflow({ scriptPath: "/path/to.js" })        // 磁盘脚本，优先级最高
```

每次调用都会把脚本存一份到会话目录并返回路径——**要迭代就编辑那个文件、用 `scriptPath` 重跑**，
不用每次重发整段脚本。

## 几个好用的编排形态

- **对抗性复核**：每条发现派 N 个独立的「反驳者」，多数反驳就毙掉。防的是「听起来有道理但其实
  是错的」那类结论。
- **视角多样化复核**：一条发现可能有多种错法时，给每个复核者一个不同的视角（正确性 / 安全 /
  性能 / 能否复现），比 N 个相同的复核者管用。
- **评委团**：从不同角度生成 N 个方案，并行打分，从赢家出发再嫁接亚军的好点子。
- **跑到干为止**：规模未知的发现类任务（找 bug、找边界情况），一直派直到连续 K 轮没有新东西。
  简单的「找够 N 个就停」会漏掉长尾。
- **完整性批评者**：最后派一个专门问「还缺什么——哪种方式没试过、哪条断言没验、哪个来源没读」。

---

相关：[子代理](/tools/subagents) · [工具总览](/tools/overview)
