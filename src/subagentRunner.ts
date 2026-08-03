// src/subagentRunner.ts —— Agent 工具与 forked skill 共用的子代理运行器。
// 并发由 loop CONCURRENCY=5 只读批每级独立约束（零上限并发，无共享阻塞池）。
import type OpenAI from 'openai'
import type { z } from 'zod'
import type { Tool, ToolContext } from './tools/types.js'
import type { Usage } from './api.js'
import { runLoop } from './loop.js'
import { makeStructuredOutputTool, structuredOutputReminder, MAX_STRUCTURED_OUTPUT_RETRIES } from './tools/structuredOutput.js'
import { isSecurityGate } from './tools/agent.js'
import { isDangerous, type PermissionContext, type PermissionSnapshot } from './permissions.js'
import { isInsideWorkspace } from './workspace.js'

// 记忆 fork 专用信号量（独立于用户 subagent 池，防三连点火打爆限流）。
// MAX_MEMORY_ACTIVE=2：extract+sessionMemory+dream 最多 2 个并发，不饿死用户主动起的 Task。
const MAX_MEMORY_ACTIVE = 2
let memActive = 0
const memWaiters: Array<() => void> = []
export async function acquireMemory(): Promise<void> {
  if (memActive < MAX_MEMORY_ACTIVE) { memActive++; return }
  await new Promise<void>(r => memWaiters.push(r)) // 许可由 releaseMemory 移交，不再自增
}
export function releaseMemory(): void {
  const next = memWaiters.shift()
  if (next) next() // 移交许可：memActive 不变
  else memActive--
}

/** 仅测试用：重置记忆信号量状态（memActive/memWaiters）。 */
export function __resetMemorySemaphoreForTest(): void {
  memActive = 0
  memWaiters.length = 0
}

export interface RunSubagentOpts {
  client: OpenAI
  onUsage: (u: Usage, model: string) => void
  systemPrompt: string
  userPrompt: string
  tools: Tool<any>[]
  model: string
  outputSchema?: z.ZodTypeAny
  ctx: ToolContext
  signal: AbortSignal
  agentId: string
  agentType: string
  /** worktree 路径。设置后子代理 cwd 锚定此 worktree，系统提示追加隔离说明。 */
  worktreePath?: string
  /** 推理开关。默认 false（保持现有所有调用者行为不变）。Workflow agent({effort}) 用。 */
  thinking?: boolean
  /** 推理档位（thinking=true 时透传 api reasoning_effort）。 */
  effortLevel?: 'low' | 'medium' | 'high'
}

/** worktree 子代理隔离提示（追加在 agent 系统提示后）。 */
export function worktreeSubagentPrompt(parentCwd: string, worktreePath: string): string {
  return `\n\n你在一个隔离的 git worktree 里工作：${worktreePath}——同一仓库、同样的相对文件结构、独立工作副本。继承上下文里的路径指向父代理的工作目录（${parentCwd}），需翻译到你的 worktree 根。编辑前先重读文件（父代理可能已改动）。你的改动只留在此 worktree，不会影响父代理的文件。`
}

/** 组装子代理的 PermissionContext：继承父级全部安全约束，ask 按 reason 来源二分。
 *  拿不到父快照 → 回落 default + 空规则（= 改动前行为），不放宽。
 *  fenceRoot 由调用方定死，便于对抗性单测直接喂 checkPermission；唯一副作用是缺 cwd 时的告警。 */
export function buildSubagentPermission(
  parent: PermissionSnapshot | undefined,
  fenceRoot: string,
  askUp?: ToolContext['askUp'],
  origin?: { agentId: string; agentType: string },
): PermissionContext {
  // 父快照存在但缺 cwd 是异常路径：三处注入点（useChat/headless/backgroundRunner）都固定填了 cwd，
  // 缺失意味着将来新增第四个注入点忘填，会静默回落到调用方给定的 fenceRoot——不算错但不可观测，
  // 故告警使其可发现，不静默吞掉。
  if (parent && parent.cwd === undefined) {
    console.error('[deepcode] 父级权限快照缺少 cwd，子代理围栏根回落到调用方给定值——请检查注入点是否漏填。')
  }
  return {
    mode: parent?.mode ?? 'default',
    rules: parent?.rules ?? [],
    deny: parent?.deny,
    denySources: parent?.denySources,
    ruleSources: parent?.ruleSources,
    askRules: parent?.askRules,
    askSources: parent?.askSources,
    additionalDirs: parent?.additionalDirs,
    classify: parent?.classify,
    cwd: fenceRoot,
    saveRule: () => {}, // 子代理不得持久化权限规则
    // 子代理不再本地拍板。分三档，改造后每一档都不比改造前更松：
    //   安全门 / 危险命令 → 硬拒（与改造前同）
    //   其余 → 转发给顶层（改造前是自动 'yes'，现在交给人；无人值守下顶层给 'no'）
    //   askUp 缺失（新注入点漏接）→ 硬拒，不回落旧启发式
    ask: async (toolName, desc, reason, previewRule) => {
      if (isSecurityGate(reason)) return 'no'
      if (isDangerous(desc)) return 'no'
      return askUp ? askUp(toolName, desc, reason, previewRule, origin) : 'no'
    },
  }
}

/** 跑子代理子循环，返回最后一条 assistant 文本或结构化 JSON。SubagentStart/Stop hook + L-044 结构化输出。 */
export async function runSubagent(opts: RunSubagentOpts): Promise<string | undefined> {
  const { ctx, signal, agentId, agentType: type } = opts
  // 子代理独立 cwd：初值=worktreePath（worktree 模式）或调用时父 cwd 快照。setCwd 漂移自身、不污染父 cwd。
  let subCwd = opts.worktreePath ?? ctx.cwd()
  const sysPrompt = opts.worktreePath
    ? opts.systemPrompt + worktreeSubagentPrompt(ctx.cwd(), opts.worktreePath)
    : opts.systemPrompt
  const messages: any[] = [
    { role: 'system', content: sysPrompt },
    { role: 'user', content: opts.userPrompt },
  ]
  if (ctx.hookDispatch) {
    const startOut = await ctx.hookDispatch('SubagentStart', {
      hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
    })
    if (startOut.additionalContext) {
      messages.push({ role: 'user', content: `<hook-context>\n${startOut.additionalContext}\n</hook-context>` })
    }
  }
  const parentPerm = ctx.parentPermission?.()
  // 围栏根：构造时求值一次，不随子代理内 cd 漂移——漂移即围栏绕过（cd / 后可写任意路径）。
  // 与 subCwd 是两个量：subCwd 管"在哪执行"，fenceRoot 管"允许碰哪"。
  // 优先级：worktree 隔离 > 调用方（子代理）自己不可变的 ctx.fenceRoot（孙代理场景，防继承漂移后的 cwd 造成跨层逃逸）
  // > parentPerm.cwd（顶层会话本回合的围栏根快照，与 useChat/headless/backgroundRunner 喂给 checkPermission 的
  //   pc.cwd 同源、回合内不随 Bash cd/EnterWorktree/ExitWorktree 漂移）> ctx.cwd()（兜底：两者都拿不到时的最后手段，
  //   即改动前行为，不比之前更松；这一兜底若被触发，说明 parentPerm 缺 cwd，已由 buildSubagentPermission
  //   里的告警覆盖，不会静默发生）。
  const fenceRoot = opts.worktreePath ?? ctx.fenceRoot ?? parentPerm?.cwd ?? ctx.cwd()
  // 子代理允许 cd 落脚的范围：围栏根 ∪ 继承的工作目录白名单。越界 cd 一律拒绝持久化——
  // 否则「判定用 fenceRoot 解析相对路径」与「执行用 subCwd 解析相对路径」会分裂成两个基准，
  // cd 到围栏外后传相对路径就能绕过围栏与 deny（实证：cd 到 outside 后 Write 相对路径写到围栏外；
  // cd 到 ~/.aws 后 Read 相对路径读到真实 credentials）。
  const allowedCdRoots = [fenceRoot, ...(parentPerm?.additionalDirs ?? [])]
  const subCtx: ToolContext = {
    cwd: () => subCwd,
    // 子代理纯执行，cd 不得漂出围栏：命中围栏内才持久化漂移，越界则静默保留原 subCwd
    // （shell 子进程里的 cd 本身已经执行完毕退出，这里只是不落地这次目录切换）。
    setCwd: d => { if (isInsideWorkspace(d, allowedCdRoots)) subCwd = d },
    get signal() { return signal }, // 前台=主 loop signal；后台=任务 AbortController（供 TaskStop）
    fileState: new Map(), // 独立 fileState，不污染主会话 read-before-edit 状态
    isSubagent: true, // 子代理纯执行：禁止起后台任务（防污染主会话通知队列）
    denyPatterns: ctx.denyPatterns, // Glob/Grep 输出过滤：不继承则派个子代理 Grep 即可绕过 deny
    subagentDepth: (ctx.subagentDepth ?? 0) + 1,
    fenceRoot, // 注入自身定死的围栏根，供下一层子代理继承而非误用已漂移的 cwd()
    askUp: ctx.askUp, // 原样透传：顶层是唯一真实提供者，中间层只做管道（孙代理同样抵达顶层）
    // 逐层传递：孙代理同样受约束（fenceRoot 已收窄），而非在第二层丢失
    parentPermission: () => ({
      mode: parentPerm?.mode ?? 'default',
      rules: parentPerm?.rules ?? [],
      deny: parentPerm?.deny,
      denySources: parentPerm?.denySources,
      ruleSources: parentPerm?.ruleSources,
      askRules: parentPerm?.askRules,
      askSources: parentPerm?.askSources,
      additionalDirs: parentPerm?.additionalDirs,
      classify: parentPerm?.classify,
      cwd: fenceRoot, // 传给下一层：与自身 ctx.fenceRoot 一致，双保险（ctx.fenceRoot 已优先生效）
    }),
  }
  let subStopFired = false
  // L-044：声明 outputSchema → 注入 StructuredOutput 工具，强制子代理产出校验对象。
  let captured: unknown
  let structuredRetries = 0
  const subTools = opts.outputSchema
    ? [...opts.tools, makeStructuredOutputTool(opts.outputSchema, v => { captured = v })]
    : opts.tools
  while (true) {
    const gen = runLoop(messages, {
      client: opts.client,
      tools: subTools,
      model: opts.model,
      thinking: opts.thinking ?? false,
      effortLevel: opts.effortLevel,
      // 子代理自身无审批 UI：安全门/危险命令就地硬拒，其余向上转发到顶层（交互式弹窗，无人值守硬拒）；
      // 继承父级安全约束（deny/ask/rules/mode/classify），围栏根固定为 fenceRoot，不随 cd 漂移。
      permission: buildSubagentPermission(parentPerm, fenceRoot, ctx.askUp, { agentId, agentType: type }),
      ctx: subCtx,
      maxTurns: 30,
      // 轨迹里主循环与子代理的记录本来完全同形；带上类型才能事后把子代理的执行记录摘出来。
      // 带上 agentId：Agent 工具只读、同一轮多个 Agent 调用走 loop.ts 的并发批，两个同类型
      // 子代理并发时请求交错落盘，仅凭类型无法区分是同一次 spawn 的多轮还是两次独立 spawn；
      // agentId 每次 spawn 唯一，把 spawn 身份直接写进标签，恢复时按完整标签分组即可，
      // 不再需要任何长度启发式（见 bench/ab/subagentTrace.ts）。
      traceLabel: `subagent:${type}#${agentId}`,
    })
    let step
    while (!(step = await gen.next()).done) {
      if (step.value.type === 'turn_end') opts.onUsage(step.value.usage, opts.model)
    }
    const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
    // L-044 强约束：声明了 schema 但本轮还没拿到校验对象 → 注入提醒续跑（≤MAX 次；独立于 subStopFired 配额）。
    if (opts.outputSchema && captured === undefined) {
      if (structuredRetries < MAX_STRUCTURED_OUTPUT_RETRIES) {
        structuredRetries++
        messages.push({ role: 'user', content: structuredOutputReminder() })
        continue
      }
      // 超限：fail-safe 兜底返回末条文本（不死循环）。
    }
    // L-044：结构化对象优先于自由文本（声明 schema 且已捕获→返回校验 JSON，否则末条文本）。
    const result = captured !== undefined ? JSON.stringify(captured) : final?.content
    if (ctx.hookDispatch && !signal.aborted) {
      const stopOut = await ctx.hookDispatch('SubagentStop', {
        hook_event_name: 'SubagentStop', agent_id: agentId, agent_type: type, cwd: ctx.cwd(),
        stop_hook_active: subStopFired,
        last_assistant_message: final?.content ?? '',
      })
      // continue:false（硬停）优先于 block 续跑：即便另一 hook 要续跑，continue:false 也压倒之。
      if (stopOut.stop) return result
      if (stopOut.preventContinuation && !subStopFired) {
        subStopFired = true
        messages.push({ role: 'user', content: stopOut.blockReason ?? '（SubagentStop 要求继续未尽事项）' })
        continue
      }
    }
    return result
  }
}
