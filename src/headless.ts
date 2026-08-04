// src/headless.ts
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
import { isContextOverflowError } from './compact.js'
import { createCompactionManager } from './compactionManager.js'
import { planOverflowRetry } from './overflowRetry.js'
import { allTools } from './tools/index.js'
import { makeAgentTool } from './tools/agent.js'
import { makeWorkflowTool } from './tools/workflow.js'
import { runSubagent } from './subagentRunner.js'
import { resolveAgents } from './agentsLoader.js'
import { makeWebFetchTool } from './tools/webfetch.js'
import { makeWebSearchTool, resolveWebSearchConfig } from './tools/webSearchTool.js'
import { bgTaskListTool, taskOutputTool } from './tools/taskTools.js'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from './tools/taskListTools.js'
import { installTaskCleanup } from './tasks.js'
import { enableTrace } from './requestTrace.js'
import { buildSystemPrompt, findMemoryFiles, VERIFICATION_CONTRACT } from './prompt.js'
import { loadOutputStyles, resolveOutputStyle } from './outputStyles.js'
import { loadLayeredSettings, strippedRulesNotice } from './settingsLayers.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { initMcpTools } from './mcp.js'
import { createMcpRegistry } from './mcpRegistry.js'
import { loadSkills } from './skillsLoader.js'
import { headlessToolArg } from './headlessTrace.js'
import { makeSkillTool } from './tools/skill.js'
import { TaskListStore } from './taskList.js'
import { costCNY } from './pricing.js'
import { resolveDenyList, buildDenySourceMap } from './deny.js'
import type { PermissionMode } from './permissions.js'
import { classify } from './autoMode.js'
import { streamInit, streamFromLoopEvent, streamResult } from './streamJson.js'
import { flag } from './flags.js'
import { makeVerifyGate } from './verifyGate.js'
import { globalMemdirFor, sessionMemoryPathFor } from './memdir/paths.js'
import { DEFAULT_MEMORY_CONFIG } from './memdir/memoryConfig.js'
import { availablePresets, modelFallbackReason, resolveActiveProvider, resolveStartupModel, resolveSubModel } from './providers.js'
import type { ToolContext, WorktreeSessionState } from './tools/types.js'
import type { Usage } from './api.js'

/** 撞满步数上限后注入的收尾指令（实验项，flag `wrapUpOnMaxTurns` 门控，默认关）。
 *  措辞刻意窄：只要「落地」，不要「继续查」。
 *
 *  ⚠️ 其前提存疑：提出时认为「撞上限会产出空补丁」，但两份 SWE-bench 报告记录的实测
 *  相反——「撞上限但补丁是对的、判分全过」，即过度 grind 而非零输出。故默认关，
 *  等 B-2 跑正经实验。 */
export const WRAP_UP_PROMPT = '步数预算已耗尽，这是最后一轮。立刻停止一切探索、阅读与调查，把你目前认为最好的修改直接写入文件——即使不完整、不完美也要落地。空手退出等于零分，一个不完美的产物远好过没有产物。本轮只做写入操作。'

export interface HeadlessResult {
  text: string
  /** context_overflow：压缩后仍超窗，已停止。走返回而非抛出，
   *  好让 index.ts 既有的 `exitCode = status === 'done' ? 0 : 1` 拿到非零码，
   *  同时保住 text 里崩溃前的部分产出与 json 输出里的确切状态。 */
  status: 'done' | 'aborted' | 'max_turns' | 'context_overflow'
  turns: number
  usage: Usage
  costCNY: number
}

/** 共享工具集构造（runHeadless 与 runBackgroundSession 都用，避免重复）。纯机械搬移，零行为变化。 */
export function buildHeadlessToolset(d: {
  client: OpenAI; addUsage: (u: Usage) => void; getModel: () => string
  agents: ReturnType<typeof resolveAgents>; settings: any; cwd: string
  skills: ReturnType<typeof loadSkills>; mcpTools: any[]
}): any[] {
  const { client, addUsage, getModel, agents, settings, cwd, skills, mcpTools } = d
  const model = getModel()
  return [...allTools, taskCreateTool, taskGetTool, taskUpdateTool, taskListTool,
    makeAgentTool({ client, onUsage: (u, _m) => addUsage(u), getModel, agents, worktree: settings.worktree }),
    // 非交互（headless/后台）：ask 桩恒 'no'，B7 用量确认门若走 ask 会 100% 误拒 workflow。
    // 跳过警告（getSkipWorkflowWarning 恒 true）→ needsPermission() 恒 false → isReadOnly 短路放行，不问。
    makeWorkflowTool({ client, onUsage: (u, _m) => addUsage(u), sessionModel: model, agents, runSubagent, journalDir: path.join(cwd, '.deepcode', 'workflows'), resolveModelAlias: (m: string) => resolveSubModel(m, model), worktree: settings.worktree, getSkipWorkflowWarning: () => true }),
    makeWebFetchTool({ client, onUsage: (u, _m) => addUsage(u) }),
    makeWebSearchTool({ config: resolveWebSearchConfig(settings) }),
    bgTaskListTool, taskOutputTool, ...mcpTools,
    makeSkillTool(() => skills, { client, onUsage: (u, _m) => addUsage(u), getModel, agents, skillPool: [...allTools, makeWebFetchTool({ client, onUsage: (u, _m) => addUsage(u) })], listingBudgetChars: settings.skills?.listingBudgetChars })]
}

/** 单 prompt 跑完整个 loop。工具事件打到 stderr（stdout 留给最终结果，方便脚本消费）。 */
export async function runHeadless(opts: { client: OpenAI; prompt: string; yolo: boolean; flagSettingsPath?: string; home?: string; outputFormat?: 'text' | 'json' | 'stream-json'; write?: (s: string) => void; traceDir?: string; maxTurns?: number; model?: string; permissionMode?: PermissionMode }): Promise<HeadlessResult> {
  installTaskCleanup() // 退出时 kill 仍 running 的后台任务
  // 轨迹要在任何 chatStream 之前开启，否则前几个请求会漏记。
  if (opts.traceDir) enableTrace(opts.traceDir)
  const home = opts.home ?? os.homedir() // 测试注入：隔离全局记忆抽屉落盘根目录，避免污染 ~/.deepcode
  const layered = loadLayeredSettings(process.cwd(), opts.flagSettingsPath)
  const settings = layered.settings
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  // 全局记忆抽屉：headless 是真实生产路径（红线偏好必须在场），门控同 useChat.ts
  const mem = settings.memory ?? DEFAULT_MEMORY_CONFIG
  const globalMemdir = mem.enabled && mem.global.enabled ? globalMemdirFor(home) : undefined
  // activeProvider() 不带 flagPath，与 createClient(flagSettingsPath) 会分叉；用手里的 layered settings 解析
  const activePreset = resolveActiveProvider(settings)
  // --model 优先于 settings.model（照 backgroundRunner 的 opts.model ?? … 次序）。此前 headless
  // 压根不收这个入参，`deepcode --model X -p "任务"` 会静默按 settings 里的模型跑完并按那个模型计费——
  // 与本文件下面那句「绝不静默失效」自相矛盾。解析与白名单钳制仍走同一条路，不给 flag 开后门。
  const requestedModel = opts.model ?? settings.model
  const model = resolveStartupModel(requestedModel, activePreset, availablePresets(settings), settings.availableModels)
  const modelFallback = modelFallbackReason(requestedModel, model, activePreset, settings.availableModels)
  if (modelFallback) {
    // 绝不静默失效：配置被推翻必须说出来（stderr，不污染 stdout 结果通道）
    console.error(`[deepcode] ${opts.model ? '--model' : 'settings.model'}=${modelFallback}`)
  }
  // --permission-mode 优先于 --yolo 之外的一切；两者同时给出且不一致时 index.ts 已当场报错，
  // 这里不再兜底猜意图。未传时沿用原行为（yolo ? 'yolo' : 'default'）。
  const permMode: PermissionMode = opts.yolo ? 'yolo' : (opts.permissionMode ?? 'default')

  const strippedNotice = strippedRulesNotice(layered.strippedDangerousRules)
  if (strippedNotice) {
    // 绝不静默失效：always/plan 批准存下的规则若被剥，产品不能只在用户手动敲 /config 时才说。
    console.error(`[deepcode] ${strippedNotice}`)
  }
  let cwd = process.cwd()
  // 本次 headless 单轮运行的围栏根快照：单发模式全程只有一轮 runLoop，此值在此冻结，
  // 不随本轮内 Bash cd/EnterWorktree/ExitWorktree 漂移；子代理 fenceRoot 必须取它而非
  // 实时 ctx.cwd()，否则先 cd 再派子代理会绕过围栏。
  const roundCwd = cwd
  const agents = resolveAgents(cwd)
  const skills = loadSkills(cwd, undefined, settings.skills, settings.skillOverrides)
  const injectionBuffer: string[] = []
  const taskList = new TaskListStore()
  const sessionId = 'headless-' + crypto.randomBytes(4).toString('hex')
  taskList.bind(sessionId)
  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    parentPermission: () => ({
      mode: permMode,
      // auto 模式必须带分类器：checkPermission 的 auto 分支要求 pc.classify 为真，否则整段被跳过、
      // 行为静默退化成 default。此前 headless 与后台都没提供它——于是「在 auto 模式下开的后台任务」
      // 实际跑在 default 下，需要权限的工具全被拒（askUp 恒 'no'），且没有任何提示。
      classify: (t: string, d: string, sib: string) => classify(t, d, sib, { onUsage: u => addUsage(u) }),
      rules: settings.permissions.allow,
      deny: resolveDenyList(settings.permissions.deny),
      ruleSources: layered.permissionSources.allow,
      denySources,
      askRules: settings.permissions.ask ?? [],
      askSources: layered.permissionSources.ask,
      cwd: roundCwd,
    }),
    askUp: async () => 'no', // 无人值守：与本环境主代理的 ask 一致，不存在「没人在所以放行」
    signal: new AbortController().signal,
    fileState: new Map(),
    taskList,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks), // overwritten below after hookDeps is built
    sessionId: () => sessionId,
    injectUserMessage: (c: string) => injectionBuffer.push(c),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  let turns = 0
  // makeAgentTool 的 onUsage 回调签名为 (u: Usage, model: string)
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens
    total.completion_tokens += u.completion_tokens
    total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const hookDeps = {
    ...makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd, parentPermission: ctx.parentPermission, askUp: ctx.askUp, denyPatterns: ctx.denyPatterns }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)
  // 主动压缩：与 TUI(useChat.ts) 共用同一个 manager 实现（src/compactionManager.ts），这里只注入
  // headless 侧的环境差异。此前 headless 全程无主动压缩，唯一防线是单发的反应式超窗恢复
  // （见下方 catch 分支）——压过一次后本 run 内后续超窗直接收摊，长跑上下文无界累积。
  const compaction = createCompactionManager({
    client: opts.client,
    model,
    settings,
    abortSignal: ctx.signal,
    // stderr，与本文件既有的 `⏺ 工具名(...)` 轨迹同流；不得写 stdout，会污染 --output-format json。
    notice: (_level, msg) => process.stderr.write(`${msg}\n`),
    onUsage: u => addUsage(u),
    persistCompact: async () => { /* headless 无转录，落盘无处可去 */ },
    sessionMemoryContent: () => {
      // 门控同 useChat.ts：全局记忆开关 + 会话记忆子开关都开才读。sessionId 恒定（headless 单发不切会话）。
      if (!(mem.enabled && mem.sessionMemory.enabled)) return undefined
      try { return fs.readFileSync(sessionMemoryPathFor(cwd, sessionId, home), 'utf8') }
      catch { return undefined } // summary.md 不存在（headless 从不写它）则跳过，不当错误
    },
    runPreCompactHook: async (trigger, messagesCount) => {
      if (!settings.hooks) return
      await runHooks('PreCompact', {
        hook_event_name: 'PreCompact', cwd, trigger, messages_count: messagesCount,
      }, settings.hooks, hookDeps)
    },
    runPostCompactHook: async meta => {
      if (!settings.hooks) return
      await runHooks('PostCompact', {
        hook_event_name: 'PostCompact', cwd, trigger: meta.trigger,
        summary: meta.summary, truncated: meta.truncated,
        messages_before: meta.messagesBefore, messages_after: meta.messagesAfter,
      }, settings.hooks, hookDeps)
    },
    // headless 无 TUI 那套 provider fast-model 解析路径，压缩摘要的用量记账直接记到主模型上。
    activeFastModel: () => model,
  })
  // SessionStart：会话开始（headless 恒 startup）。await 注入 additionalContext 到初始上下文。
  // 合同只在 headless 注入：TUI 与 backgroundRunner 结构上拿不到（见 VERIFICATION_CONTRACT 注释）。
  const baseSystem = buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, undefined, resolveOutputStyle(settings.outputStyle, loadOutputStyles()), undefined, undefined, settings.language, globalMemdir, mem.global.maxBytes)
  // 合同自成一段（# 验证），不拼进 # 环境 段末尾：拼进环境信息里会削弱遵从度，
  // 且违反本文件自己的门控约定（实验条目不该绕过既有的段门控自成一路，见 prompt.ts）。
  const initMsgs: any[] = [{ role: 'system', content: flag('verificationAgent', false) ? `${baseSystem}\n\n# 验证\n${VERIFICATION_CONTRACT}` : baseSystem }]
  if (settings.hooks) {
    const ss = await runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source: 'startup',
    }, settings.hooks, hookDeps)
    if (ss.additionalContext) initMsgs.push({ role: 'user', content: `<hook-context>\n${ss.additionalContext}\n</hook-context>` })
    if (ss.systemMessage) process.stderr.write(ss.systemMessage + '\n')
    // InstructionsLoaded：记忆文件加载记录（DEEPCODE.md/CLAUDE.md/全局）。fire-and-forget。
    const globalMem = path.join(home, '.deepcode', 'DEEPCODE.md')
    for (const f of findMemoryFiles(cwd)) {
      void runHooks('InstructionsLoaded', {
        hook_event_name: 'InstructionsLoaded', cwd, session_id: ctx.sessionId?.(),
        file_path: f, memory_type: f === globalMem ? 'user' : 'project', load_reason: 'startup',
      }, settings.hooks!, hookDeps).catch(() => {})
    }
  }
  // outputFormat/streaming/write 只依赖 sessionId/cwd/model（均已就绪），在此上移，
  // 确保 stream-json 下 init 首行恒早于任何早退分支（包括 UserPromptSubmit hook 拦截），
  // 拦截理由才能随 result.text 流出而不是零字节 stdout 静默蒸发。
  const outputFormat = opts.outputFormat ?? 'text'
  const streaming = outputFormat === 'stream-json'
  const write = opts.write ?? ((s: string) => { process.stdout.write(s) })
  if (streaming) write(streamInit({ sessionId, cwd, model, yolo: opts.yolo }))
  let promptText = opts.prompt
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks, hookDeps)
    if (ups.block || ups.preventContinuation) {
      const extra = ups.additionalContext ? `\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>` : ''
      const result: HeadlessResult = { text: `输入被 hook 拦截：${ups.blockReason ?? ''}${extra}`, status: 'aborted', turns: 0, usage: total, costCNY: 0 }
      if (streaming) write(streamResult(result))
      return result
    }
    if (ups.additionalContext) promptText = `${opts.prompt}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
  }
  const messages: any[] = [...initMsgs, { role: 'user', content: promptText }]
  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, {
    onWarn: msg => process.stderr.write(msg + '\n'),
    registry: createMcpRegistry(),
  })
  // microcompact 重试后不能续用旧 generator（旧 generator 闭包的是压缩前的 messages 快照），
  // 必须拿改写后的 messages 重开一个 runLoop——故整块搬进可重入的 drive()。
  // maxTurnsOverride：重试时收窄的剩余预算（见调用处）。undefined＝沿用 settings.headlessMaxTurns。
  // `--max-turns` 覆盖 settings.headlessMaxTurns；两者都没有则由 loop.ts 兜底到 80。
  // 只解析一次并在下方全部消费点复用——重试路径的剩余预算若漏算它，
  // 用它卡成本的调用方预算就形同虚设。
  const effectiveMaxTurns = opts.maxTurns ?? settings.headlessMaxTurns
  async function drive(maxTurnsOverride?: number): Promise<HeadlessResult['status']> {
    const gen = runLoop(messages, {
      client: opts.client,
      tools: buildHeadlessToolset({ client: opts.client, addUsage, getModel: () => model, agents, settings, cwd, skills, mcpTools }),
      model,
      // headless 无会话状态可继承 TUI 的 /think，改由 settings 显式开关（缺省 false＝维持既有行为）。
      // 参考实验的结论是自动化路径「关了思考跑难题」是 flaky 的一个来源，但是否划算须 A/B 验，
      // 故给开关不改默认——默认改了就没有干净基线可比。
      thinking: settings.headlessThinking ?? false,
      // 收工前验证自检门：与验证合同同一个 flag 门控（合同只在 headless 注入，门也只在这里接）。
      // 合同此前是纯说服，真机实测在跑完的三次里被违反过一次——机制侧毫无问题、轮次还剩一半，
      // 模型改了 19 个文件直接收工并自评「## Verifying … tests pass」。这个门在它真要走的那一刻拦一下。
      verifyGate: flag('verificationAgent', false) ? makeVerifyGate() : undefined,
      // 撞 headlessMaxTurns 会被直接 seal 退出（无收尾降级），长任务评测可调高；不传＝沿用 loop.ts 的 80。
      maxTurns: maxTurnsOverride ?? effectiveMaxTurns,
      maxToolResultChars: settings.maxToolResultChars,
      // 主动压缩挂在这里而不是 drive() 之后：-p 只有一条用户消息，增长全在这一个
      // runLoop 的 80-120 轮里；挂末尾的话压缩发生时 messages 已不再发给 API。
      beforeSend: async m => {
        await compaction.maybeCompact(m)
        compaction.armPrecompute(m)   // 紧跟其后：读 maybeCompact 末尾记下的同一个 estimated
      },
      ctx,
      permission: {
        mode: permMode,
        classify: (t: string, d: string, sib: string) => classify(t, d, sib, { onUsage: u => addUsage(u) }),
        rules: settings.permissions.allow,
        deny: resolveDenyList(settings.permissions.deny),
        cwd: roundCwd, // 与 ctx.parentPermission().cwd 同一份快照，二者必须同源
        saveRule: () => { /* headless 不持久化规则 */ },
        ask: async () => 'no', // 无人值守：默认拒绝，拒绝理由按正常机制喂回模型
        unattended: true, // ask 恒 'no'，无法真正弹窗——yolo 危险命令门在此退化成硬拒，故豁免
        ruleSources: layered.permissionSources.allow,
        denySources,
        askRules: settings.permissions.ask ?? [],
        askSources: layered.permissionSources.ask,
      },
      reminders: () => {
        taskList.tick()
        const note = taskList.staleReminder()
        return note ? [note] : []
      },
      drainInjections: () => injectionBuffer.splice(0),
      injectTaskNotifications: true, // 运行中完成的后台任务在终止点注入续跑（单发模式无空闲订阅）
      hooks: settings.hooks,
      hookDeps,
    })
    let step
    while (!(step = await gen.next()).done) {
      const ev = step.value
      if (streaming) {
        const line = streamFromLoopEvent(ev)
        if (line) write(line)
      } else if (ev.type === 'tool_start') {
        process.stderr.write(`⏺ ${ev.name}(${headlessToolArg(ev.name, ev.desc)})\n`)
      }
      if (ev.type === 'turn_end') {
        turns++; addUsage(ev.usage)
        // 第二参必须是 ev.sentLen（发送时的 messages 前缀长度，含本轮 user、不含本轮 assistant 产出），
        // 不是 messages.length——后者已含本轮新增，会让 maybeCompact 的发送前预估基线偏大、压缩偏晚。
        compaction.observeTurnEnd(ev.usage.prompt_tokens, ev.sentLen)
      }
    }
    return step.value
  }
  let overflowRetried = false
  let status: HeadlessResult['status']
  try {
    try {
      status = await drive()
    } catch (e) {
      const plan = planOverflowRetry(e, messages, overflowRetried)
      if (plan.action === 'report') {
        // 二分依据必须是「是否超窗错误」而非 plan.action：plan.action==='report' 还覆盖了
        // 「超窗但 microcompact 无可甩」这条本分支要修的路径——它不该抛出，应正常返回可诊断状态。
        // 真正该抛的只有非超窗错误（如 provider 502）。
        if (!isContextOverflowError(e)) throw e
        process.stderr.write('⚠ 上下文超长且无可回收的旧工具输出，已停止。\n')
        status = 'context_overflow'
      } else {
        // 原地改写：messages 被 runLoop 入参与末尾抽 final 的 [...messages] 同时持有，
        // 重新赋值只换局部指向，重试跑的会是旧内容。
        messages.length = 0
        messages.push(...plan.messages)
        overflowRetried = true
        process.stderr.write(`⚠ 上下文超长，已甩掉 ~${plan.tokensSaved} tok 旧工具输出后重试\n`)
        try {
          // 重试复用同一预算而非满血重开：drive() 内部的 turn 计数器随每次调用归零，
          // 两次 drive() 若都给满 headlessMaxTurns，有效步数上限会悄悄翻倍，
          // 用 headlessMaxTurns 卡成本的用户预算形同虚设。turns 是已完成的真实轮数。
          const remaining = effectiveMaxTurns !== undefined
            ? Math.max(1, effectiveMaxTurns - turns)
            : undefined
          status = await drive(remaining)
        } catch (e2) {
          if (!isContextOverflowError(e2)) throw e2
          process.stderr.write('⚠ 压缩后仍超长，已停止。请分块读取大文件或缩小任务范围。\n')
          status = 'context_overflow'
        }
      }
    }
    // 收尾轮（实验项）：撞满步数上限时注入一轮「停止探索、立刻落地」再跑恰好 1 轮。
    //
    // ⚠️ 刻意不放在 loop.ts：runLoop 有 6 个调用方，webfetch 传 maxTurns:1，
    // 在 loop.ts 里加收尾会让每次 WebFetch 从 1 轮变 2 轮（成本与延迟翻倍）；
    // hook(10)、子代理(30) 也会各多烧一轮。放这里爆炸半径为零。
    //
    // 只跑 1 轮 = 模型有且只有一次 API 调用机会，工具执行完即止，看不到工具结果、
    // 也不会再有收尾文本。这是刻意的：目标是让改动落到磁盘，不是让它把话说完。
    if (status === 'max_turns' && flag('wrapUpOnMaxTurns', false)) {
      messages.push({ role: 'user', content: WRAP_UP_PROMPT })
      process.stderr.write('⚠ 已达步数上限，进入收尾轮：停止探索，落地当前最好的修改\n')
      try {
        await drive(1)
      } catch (e) {
        // 收尾轮失败不能盖掉主状态：它是尽力而为的补救，不是新的失败来源。
        if (!isContextOverflowError(e)) throw e
        process.stderr.write('⚠ 收尾轮上下文超长，已跳过。\n')
      }
      // status 保持 'max_turns'：确实撞了上限，退出码与判分口径都不该因为补了一轮就变。
    }
    // 这里不调 maybeCompact/armPrecompute：主动压缩已挂在 runLoop 的 beforeSend 接缝上
    // （见上方 deps），每轮请求发出前判定，这才是长跑累积真正发生的地方。
    // 而在此处（drive() 之后）调用有害无益：messages 只剩下方抽 final 文本一个消费者，
    // rebuildMessages 会把落在最近 8 条之外的 assistant 文本连同产出一起砍掉——
    // 正是本文件开头承诺要保住的「崩溃前的部分产出」（超窗路径实测能压成空串）。
  } finally {
    // armPrecompute 是 fire-and-forget：拿的是 entry 自己的 AbortController，没有像
    // compactNow 那样的 COMPACT_TIMEOUT_MS 超时，无人消费也不会自己收尾——它发起的一次真实
    // summarize 请求（到 provider 的 HTTPS 连接）会拖住事件循环，而 -p 分支（index.ts）
    // 只设 process.exitCode 不调 process.exit()，Node 要等事件循环排空，CLI 便会在结果
    // 已产出后继续挂起。beforeSend 逐轮化后，一次 run 的 arm 机会从「回合末最多 1 次」
    // 变成「每轮一次，可达 80-120 次」，run 结束时必须主动收摊，不能指望它自然耗尽。
    compaction.clearPrecompute()
    await mcpCleanup()   // 只跑一次，不随重试重复执行
  }
  const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
  const result: HeadlessResult = {
    text: final?.content ?? '',
    status,
    turns,
    usage: total,
    costCNY: costCNY(model, total.prompt_tokens, total.prompt_cache_hit_tokens, total.completion_tokens),
  }
  if (streaming) write(streamResult(result))
  return result
}
