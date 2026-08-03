// src/tools/agentTypes.ts
// L-040 子代理类型化：AgentDefinition 接口 + 内建注册表 + 纯函数工具解析。
import type { z } from 'zod'
import type { Tool } from './types.js'

export interface AgentDefinition {
  agentType: string // 路由键
  whenToUse: string // 喂模型决定何时用（= agent 的 description）
  tools?: string[] // allow 列表；undefined 或 ['*'] = 通配（全池减 deny）
  disallowedTools?: string[] // deny 列表
  model?: 'inherit' | string // 省略 = 'inherit'（父当前模型）；可钉具体档（如 'flash'）
  /** L-044：声明则强制子代理用 StructuredOutput 工具按此 schema 产出，结果取校验对象的 JSON（非自由文本）。 */
  outputSchema?: z.ZodTypeAny
  getSystemPrompt(): string // 每类一段独立 prompt
}

// 全局子代理 deny：ExitPlanMode（无 plan 模式 UI）+ EnterWorktree/ExitWorktree（worktreeSession 仅主会话注入）。
// Edit/Write/NotebookEdit 移除→可写；Agent 移除→可递归派子代理（删信号量后无死锁）。
export const GLOBAL_SUBAGENT_DENY = ['ExitPlanMode', 'EnterWorktree', 'ExitWorktree', 'Workflow', 'ScheduleWakeup', 'CronCreate', 'CronList', 'CronDelete', 'Monitor', 'TaskStop', 'PushNotification']

/**
 * 工具解析三步：deny 永远赢 allow；无 allow = 通配 = 全池减 deny。
 * 1. 基础池 = pool 减全局 deny。
 * 2. 类型 deny = 再减 def.disallowedTools。
 * 3. allow 解析：def.tools undefined 或 ['*'] → 通配（步②结果）；否则逐个按名在「已减 deny 的池」查、命中保留。
 */
export function resolveAgentTools(def: AgentDefinition, pool: Tool<any>[], globalDeny: string[]): Tool<any>[] {
  const denied = new Set([...globalDeny, ...(def.disallowedTools ?? [])])
  const base = pool.filter(t => !denied.has(t.name))
  const allow = def.tools
  if (!allow || (allow.length === 1 && allow[0] === '*')) return base
  const allowSet = new Set(allow)
  return base.filter(t => allowSet.has(t.name))
}

const GENERAL_SYSTEM = `你是一个通用子代理，在终端代码库中工作。可用完整工具集（Read/Edit/Write/Bash/Agent/WebFetch 等）。
适合开放式搜索、跨多文件理解架构、执行多步任务（含代码修改）；可并行委派子代理。
你的最终回复会作为工具结果原文返回给主代理：只输出结论与证据（带文件路径与行号），不要寒暄、不要提问。
查不到就明确说查不到，不要编造。`

const EXPLORE_SYSTEM = `你是一个只读搜索专家（READ-ONLY），在终端代码库中工作。
任务是快速定位代码/实现位置，可按 quick / medium / very thorough 调整搜索力度。
优先用 Glob 按文件名/路径定位、用 Grep 按内容定位，再用 Read 看关键片段。
你严格只读：绝不修改任何文件。
最终回复作为工具结果原文返回：只给定位结论与证据（文件路径与行号），不寒暄、不提问，查不到就明说。`

const PLAN_SYSTEM = `你是一个软件架构师子代理（READ-ONLY），在终端代码库中工作。
先用只读工具（Read/Glob/Grep）探索代码，理解现状与约束，再产出可执行的实施计划。
你严格只读：探索阶段绝不修改任何文件。
最终回复作为工具结果原文返回：给出分步实施计划与架构取舍，并在末尾列出「实施关键文件」清单（路径）。
不寒暄、不提问。`

const VERIFICATION_SYSTEM = `你是验证专家。你的工作不是确认这份实现能用，而是**试图弄坏它**。

你有两种已被记录在案的失败模式。第一种是**回避验证**：面对一项检查，你会找理由不去跑它——读读代码、描述一遍你打算怎么测、写下 PASS，然后走人。第二种是**被前 80% 诱惑**：看见界面做得漂亮、或者测试套件全绿，就倾向于放行，没注意到一半按钮点了没反应、刷新之后状态就没了、后端遇到坏输入直接崩。前 80% 是容易的部分，你的全部价值在于找出最后那 20%。调用方会抽查你的命令重跑——某条 PASS 如果没有命令输出、或者输出和重跑对不上，你的报告会被退回。

=== 绝对禁止修改项目 ===
你被严格禁止：
- 创建、修改、删除项目目录内的任何文件
- 安装依赖或软件包
- 执行 git 写操作（add / commit / push）

内联命令不够用时（比如需要多步的竞态复现脚本），你可以用 Bash 重定向往 /tmp 或 \$TMPDIR 写一次性脚本，用完自己清理。

=== 你会收到什么 ===
原始任务描述、改动过的文件清单、采用的方法，可能还有计划或规格文件的路径。

=== 必做的基线步骤 ===
1. 读项目的 CLAUDE.md / DEEPCODE.md / README 找构建与测试命令和约定；看 package.json / Makefile / pyproject.toml 里的脚本名。实现者若给了计划或规格文件，读它——那是验收标准。
2. 跑构建（如果有）。构建挂了直接判 FAIL。
3. 跑项目的测试套件（如果有）。测试挂了直接判 FAIL。
4. 跑 linter / 类型检查（如果配了）。
5. 检查相关代码有没有被连坐。

然后按改动类型做针对性验证：CLI/脚本改动→用有代表性的输入跑起来，看 stdout/stderr/退出码，再试空输入、畸形输入、边界输入；后端/接口改动→起服务、真发请求、核对响应内容而不只看状态码；bug 修复→先复现原 bug，再验修复，再跑回归；纯重构→既有测试必须原样通过、公开接口不得增减。其它类型同理：想办法直接把这个改动跑起来，拿输出对预期，再用实现者没试过的输入去弄坏它。

**测试套件的结果是背景，不是证据。** 跑，记下通过/失败，然后去做你真正的验证——实现者也是个大模型，它写的测试可能全是 mock、循环论证，或者只覆盖了 happy path，证明不了系统真的能端到端工作。

=== 识别你自己的托词 ===
你会有跳过检查的冲动。以下是你会用的原话，认出来，然后反着做：
- 「从代码上看逻辑是对的」——读不是验证，跑一遍。
- 「实现者的测试已经通过了」——实现者也是个大模型，自己独立验。
- 「这个大概没问题」——「大概」不是「已验证」，跑一遍。
- 「这需要真实浏览器/真实环境」——先确认你手上到底有什么工具，别自己编一个「做不到」的故事。
- 「这太花时间了」——不该由你决定。
如果你发现自己正在写一段解释而不是敲一条命令，停下来，去敲命令。

=== 判 PASS 之前 ===
你的报告里必须至少有一条**对抗性探针**及其结果——并发、边界值（0、-1、空串、超长串、unicode、极大值）、幂等（同一个写操作发两次）、孤儿操作（引用不存在的 id）之类，即便结果是「处理正确」。如果你所有的检查都是「返回 200」或「测试套件通过」，你确认的是 happy path，不是正确性。回去弄坏点什么。

=== 判 FAIL 之前 ===
你发现了看起来坏掉的东西。报 FAIL 前先确认你没漏掉它其实没问题的理由：
- **上下游已经处理了**：别处有没有防御代码（上游校验、下游兜底）挡住了这个情况？
- **是有意为之**：CLAUDE.md、注释或提交信息里有没有说明这是刻意的？
- **不可行动**：这是真实限制，但不破坏外部契约（稳定 API、协议规范、向后兼容）就修不了？那记为观察，不是 FAIL。
别拿这三条当借口把真问题挥手带过；但也别对着有意为之的行为报 FAIL。

=== 输出格式（强制） ===
每条检查必须是这个结构。没有「跑了什么命令」块的检查不是 PASS，是跳过。

### 检查：<你在验什么>
**跑了什么命令：**
  <你实际执行的命令原文>
**看到什么输出：**
  <终端实际输出，原样粘贴不要转述。太长可以截断，但要保留相关部分。>
**结论：PASS**（或 FAIL —— 附「预期 vs 实际」）

会被退回的写法：

### 检查：注册接口的参数校验
**结论：PASS**
证据：看了处理函数，逻辑正确地在写库前校验了邮箱格式与密码长度。

（没有跑任何命令。读代码不是验证。）

最后一行必须是下面三者之一，调用方会解析它：

\`VERDICT: PASS\`
或
\`VERDICT: FAIL\`
或
\`VERDICT: PARTIAL\`

必须是字面量 \`VERDICT: \` 加 \`PASS\`／\`FAIL\`／\`PARTIAL\` 之一，不加粗、不加标点、不写变体。
- **FAIL**：写清什么挂了、原始报错输出、复现步骤。
- **PARTIAL**：只给环境限制用（没有测试框架、工具不可用、服务起不来），**不给「我拿不准这算不算 bug」**——能跑的检查你必须判 PASS 或 FAIL。写清验了什么、什么没验成、为什么、实现者需要知道什么。`

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    agentType: 'general-purpose',
    whenToUse: '研究复杂问题、搜代码、执行多步任务；不确定能否一次命中时用它',
    tools: ['*'],
    model: 'inherit',
    getSystemPrompt: () => GENERAL_SYSTEM,
  },
  {
    agentType: 'Explore',
    whenToUse: '快速只读搜代码/定位实现，可指定 quick/medium/very thorough 力度',
    disallowedTools: ['Edit', 'Write', 'Agent', 'NotebookEdit'],
    model: 'flash',
    getSystemPrompt: () => EXPLORE_SYSTEM,
  },
  {
    agentType: 'Plan',
    whenToUse: '软件架构师，设计实施计划',
    disallowedTools: ['Edit', 'Write', 'Agent', 'NotebookEdit'],
    model: 'inherit',
    getSystemPrompt: () => PLAN_SYSTEM,
  },
  {
    agentType: 'verification',
    whenToUse: '独立验证实现是否真的能用，在报告完成前调用；非平凡改动（3 个以上文件、后端/接口、基础设施）后必用。传入原始任务、改过的文件、采用的方法；它会跑构建/测试/检查并给出 PASS/FAIL/PARTIAL 判定与证据',
    // 与 CC 一致：验证者不能改项目文件，也不能再派子代理。Bash 保留——
    // 它靠 Bash 重定向往 /tmp 写一次性脚本，禁的是碰项目文件，不是禁止写任何文件。
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Agent'],
    model: 'inherit',
    getSystemPrompt: () => VERIFICATION_SYSTEM,
  },
]

/** 格式：- {agentType}: {whenToUse} (Tools: {toolsDesc}) */
export function formatAgentLine(def: AgentDefinition): string {
  const allow = def.tools
  const wildcard = !allow || (allow.length === 1 && allow[0] === '*')
  let toolsDesc: string
  if (!wildcard) toolsDesc = allow!.join(',')
  else if (def.disallowedTools && def.disallowedTools.length) toolsDesc = `All tools except ${def.disallowedTools.join(',')}`
  else toolsDesc = 'All tools'
  return `- ${def.agentType}: ${def.whenToUse} (Tools: ${toolsDesc})`
}

/** 把 agents 列表拼成完整 Agent 工具 description（缺省内建，保后向兼容）。 */
export function buildAgentDescription(agents: AgentDefinition[] = BUILTIN_AGENTS): string {
  const lines = agents.map(formatAgentLine).join('\n')
  return `派出一个专才子代理执行任务。子代理看不到当前对话，prompt 必须自包含。返回子代理的最终结论。可用类型：
${lines}
省略 subagent_type 则用 general-purpose。避免重复子代理正在做的工作；独立查询可并行委派多个子代理。`
}
