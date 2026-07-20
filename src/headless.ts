// src/headless.ts
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type OpenAI from 'openai'
import { runLoop } from './loop.js'
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
import { buildSystemPrompt, findMemoryFiles } from './prompt.js'
import { loadOutputStyles, resolveOutputStyle } from './outputStyles.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { initMcpTools } from './mcp.js'
import { createMcpRegistry } from './mcpRegistry.js'
import { loadSkills } from './skillsLoader.js'
import { makeSkillTool } from './tools/skill.js'
import { TaskListStore } from './taskList.js'
import { costCNY } from './pricing.js'
import { resolveDenyList, buildDenySourceMap } from './deny.js'
import { globalMemdirFor } from './memdir/paths.js'
import { DEFAULT_MEMORY_CONFIG } from './memdir/memoryConfig.js'
import { availablePresets, resolveActiveProvider, resolveStartupModel, resolveSubModel } from './providers.js'
import type { ToolContext, WorktreeSessionState } from './tools/types.js'
import type { Usage } from './api.js'

export interface HeadlessResult {
  text: string
  status: 'done' | 'aborted' | 'max_turns'
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
export async function runHeadless(opts: { client: OpenAI; prompt: string; yolo: boolean; flagSettingsPath?: string; home?: string }): Promise<HeadlessResult> {
  installTaskCleanup() // 退出时 kill 仍 running 的后台任务
  const home = opts.home ?? os.homedir() // 测试注入：隔离全局记忆抽屉落盘根目录，避免污染 ~/.deepcode
  const layered = loadLayeredSettings(process.cwd(), opts.flagSettingsPath)
  const settings = layered.settings
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  // 全局记忆抽屉：headless 是真实生产路径（红线偏好必须在场），门控同 useChat.ts
  const mem = settings.memory ?? DEFAULT_MEMORY_CONFIG
  const globalMemdir = mem.enabled && mem.global.enabled ? globalMemdirFor(home) : undefined
  // activeProvider() 不带 flagPath，与 createClient(flagSettingsPath) 会分叉；用手里的 layered settings 解析
  const activePreset = resolveActiveProvider(settings)
  const model = resolveStartupModel(settings.model, activePreset, availablePresets(settings))
  if (settings.model && settings.model !== model) {
    // 绝不静默失效：配置被推翻必须说出来（stderr，不污染 stdout 结果通道）
    console.error(`[deepcode] settings.model=${settings.model} 不属于当前 provider（${activePreset.id}），已回落到 ${model}`)
  }
  let cwd = process.cwd()
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
    ...makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)
  // SessionStart：会话开始（headless 恒 startup）。await 注入 additionalContext 到初始上下文。
  const initMsgs: any[] = [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, undefined, resolveOutputStyle(settings.outputStyle, loadOutputStyles()), undefined, undefined, settings.language, globalMemdir, mem.global.maxBytes) }]
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
  let promptText = opts.prompt
  if (settings.hooks) {
    const ups = await runHooks('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit', cwd, prompt: opts.prompt,
    }, settings.hooks, hookDeps)
    if (ups.block || ups.preventContinuation) {
      const extra = ups.additionalContext ? `\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>` : ''
      return { text: `输入被 hook 拦截：${ups.blockReason ?? ''}${extra}`, status: 'aborted', turns: 0, usage: total, costCNY: 0 }
    }
    if (ups.additionalContext) promptText = `${opts.prompt}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
  }
  const messages: any[] = [...initMsgs, { role: 'user', content: promptText }]
  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, {
    onWarn: msg => process.stderr.write(msg + '\n'),
    registry: createMcpRegistry(),
  })
  const gen = runLoop(messages, {
    client: opts.client,
    tools: buildHeadlessToolset({ client: opts.client, addUsage, getModel: () => model, agents, settings, cwd, skills, mcpTools }),
    model,
    thinking: false,
    maxToolResultChars: settings.maxToolResultChars,
    ctx,
    permission: {
      mode: opts.yolo ? 'yolo' : 'default',
      rules: settings.permissions.allow,
      deny: resolveDenyList(settings.permissions.deny),
      cwd,
      saveRule: () => { /* headless 不持久化规则 */ },
      ask: async () => 'no', // 无人值守：默认拒绝，拒绝理由按正常机制喂回模型
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
  try {
    while (!(step = await gen.next()).done) {
      const ev = step.value
      if (ev.type === 'tool_start') process.stderr.write(`⏺ ${ev.name}(${ev.desc.slice(0, 100)})\n`)
      if (ev.type === 'turn_end') { turns++; addUsage(ev.usage) }
    }
  } finally {
    await mcpCleanup()
  }
  const final = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)
  return {
    text: final?.content ?? '',
    status: step!.value,
    turns,
    usage: total,
    costCNY: costCNY(model, total.prompt_tokens, total.prompt_cache_hit_tokens, total.completion_tokens),
  }
}
