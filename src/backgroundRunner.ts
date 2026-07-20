// src/backgroundRunner.ts
// 7.3：/background detached 子进程的运行器。resume 会话续跑 + 持久化 + job 状态机。
import os from 'node:os'
import type OpenAI from 'openai'
import { runLoop, toolOk } from './loop.js'
import { resolveAgents } from './agentsLoader.js'
import { installTaskCleanup } from './tasks.js'
import { buildSystemPrompt } from './prompt.js'
import { loadOutputStyles, resolveOutputStyle } from './outputStyles.js'
import { loadLayeredSettings } from './settingsLayers.js'
import { runHooks } from './hooks.js'
import { makeHookRuntime } from './hookRuntime.js'
import { initMcpTools } from './mcp.js'
import { createMcpRegistry } from './mcpRegistry.js'
import { loadSkills } from './skillsLoader.js'
import { TaskListStore } from './taskList.js'
import { resolveDenyList, buildDenySourceMap } from './deny.js'
import { availablePresets, resolveActiveProvider, resolveStartupModel } from './providers.js'
import { loadSession, openSession, sessionIdFromFile } from './session.js'
import { createActivityWriter } from './memdir/activityLog.js'
import { memdirFor, globalMemdirFor } from './memdir/paths.js'
import { DEFAULT_MEMORY_CONFIG } from './memdir/memoryConfig.js'
import { updateJobState } from './backgroundSession.js'
import { buildHeadlessToolset } from './headless.js'
import type { ToolContext, WorktreeSessionState } from './tools/types.js'
import type { Usage } from './api.js'

export async function runBackgroundSession(opts: {
  client: OpenAI; resumeFile: string; jobShort: string
  seed?: string; yolo?: boolean; permMode?: string; model?: string; flagSettingsPath?: string
  home?: string  // 测试注入：隔离活动日志落盘根目录，避免污染 ~/.deepcode
}): Promise<void> {
  process.env.DEEPCODE_SESSION_KIND = 'bg'
  const home = opts.home ?? os.homedir() // 活动日志落盘根目录
  installTaskCleanup()

  // 安全网：setup 阶段（loadSession/initMcpTools 等）目前在 try/catch 之外，且任何未捕获异常/
  // rejection 都会让 Node 直接退出——不加这个僵尸 job 会卡死在 working（见 7.3 后台会话薄片
  // 现场复现的根因）。二者必须极简、不可再抛，否则本身变成新的僵尸源。
  const onCrash = () => {
    try { updateJobState(opts.jobShort, { state: 'failed', updatedAt: Date.now() }) } catch { /* best-effort */ }
    process.exit(1)
  }
  process.on('uncaughtException', onCrash)
  process.on('unhandledRejection', onCrash)

  // SIGTERM（/stop 杀）→ 标 stopped，best-effort 跑 mcpCleanup（cleanup 在 initMcpTools 后才回填），再退出
  let cleanup: (() => Promise<void>) | null = null
  const onTerm = async () => {
    updateJobState(opts.jobShort, { state: 'stopped', updatedAt: Date.now() })
    try { await cleanup?.() } catch { /* best-effort */ }
    process.exit(0)
  }
  process.on('SIGTERM', onTerm)

  const loaded = loadSession(opts.resumeFile)
  const layered = loadLayeredSettings(loaded.meta.cwd || process.cwd(), opts.flagSettingsPath)
  const settings = layered.settings
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  const activePreset = resolveActiveProvider(settings)
  const requestedModel = opts.model ?? loaded.meta.model ?? settings.model
  const model = resolveStartupModel(requestedModel, activePreset, availablePresets(settings))
  if (requestedModel && requestedModel !== model) {
    // 绝不静默失效。后台子进程 stdio:'ignore'，stderr 被丢弃 → 唯一可见通道是 job state（/stop 列表会显示）。
    updateJobState(opts.jobShort, {
      model,
      warning: `model=${requestedModel} 不属于当前 provider（${activePreset.id}），已回落到 ${model}`,
      updatedAt: Date.now(),
    })
  }
  let cwd = loaded.meta.cwd || process.cwd()
  const agents = resolveAgents(cwd)
  const skills = loadSkills(cwd, undefined, settings.skills, settings.skillOverrides)
  const injectionBuffer: string[] = []
  const taskList = new TaskListStore()
  const sessionId = sessionIdFromFile(opts.resumeFile)
  taskList.bind(sessionId)
  // 活动日志：后台会话恰恰是用户看不见的活动，dream 挖掘价值最高。
  // toolset 在 initMcpTools 之后才建；isReadOnly 是回调，首次被调用（本轮 tool 消息落盘）已在其后。
  const mem = settings.memory ?? DEFAULT_MEMORY_CONFIG
  // 全局记忆抽屉：后台会话是真实生产路径（红线偏好必须在场），门控同 useChat.ts；提取侧维持不接（既有缺口，不在本次范围）
  const globalMemdir = mem.enabled && mem.global.enabled ? globalMemdirFor(home) : undefined
  let toolset: any[] = []
  const firstUser = loaded.messages.find(m => m.role === 'user' && typeof m.content === 'string')
  const handle = openSession(opts.resumeFile, f => createActivityWriter({
    memdir: () => memdirFor(cwd, home),
    sessionId: sessionIdFromFile(f),
    meta: { cwd, model },
    enabled: () => mem.enabled,
    toolOk: m => toolOk.get(m),
    isReadOnly: name => toolset.find(t => t.name === name)?.isReadOnly ?? true,
    // 续写的是既有会话文件 → slug 用已知标题/首条用户消息，别拿 seed 推出第二个文件名
    slug: loaded.meta.title ?? (typeof firstUser?.content === 'string' ? firstUser.content : undefined),
  }))
  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    signal: new AbortController().signal,
    fileState: new Map(loaded.fileState),
    taskList,
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks),
    sessionId: () => sessionId,
    injectUserMessage: (c: string) => injectionBuffer.push(c),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const total: Usage = { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 }
  const addUsage = (u: Usage) => {
    total.prompt_tokens += u.prompt_tokens; total.completion_tokens += u.completion_tokens; total.prompt_cache_hit_tokens += u.prompt_cache_hit_tokens
  }
  const hookDeps = {
    ...makeHookRuntime({ client: opts.client, getModel: () => model, onUsage: (u, _m) => addUsage(u), cwd: () => cwd }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  ctx.hookDispatch = (event, payload) => runHooks(event, payload, settings.hooks, hookDeps)

  // resume：用已存消息续跑；若无 system 头则补一条（防空会话）
  const messages: any[] = loaded.messages.length
    ? [...loaded.messages]
    : [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, undefined, resolveOutputStyle(settings.outputStyle, loadOutputStyles()), undefined, undefined, settings.language, globalMemdir, mem.global.maxBytes) }]
  // seed prompt → 追加 user 消息并落盘（无 seed 时续跑未完回合，reply-on-resume）
  if (opts.seed) {
    const um = { role: 'user', content: opts.seed }
    messages.push(um)
    handle.appendMessage(um, loaded.maxTurnId + 1)
  }

  const { tools: mcpTools, cleanup: mcpCleanup } = await initMcpTools(settings.mcpServers, { onWarn: msg => process.stderr.write(msg + '\n'), registry: createMcpRegistry() })
  cleanup = mcpCleanup
  const lenBefore = messages.length
  toolset = buildHeadlessToolset({ client: opts.client, addUsage, getModel: () => model, agents, settings, cwd, skills, mcpTools })
  const gen = runLoop(messages, {
    client: opts.client,
    tools: toolset,
    model,
    thinking: false,
    maxToolResultChars: settings.maxToolResultChars,
    ctx,
    permission: {
      mode: opts.yolo ? 'yolo' : (opts.permMode as any) || 'default',
      rules: settings.permissions.allow,
      deny: resolveDenyList(settings.permissions.deny),
      cwd,
      saveRule: () => {},
      ask: async () => 'no', // 后台无人值守：默认拒绝，理由喂回模型
      ruleSources: layered.permissionSources.allow,
      denySources,
      askRules: settings.permissions.ask ?? [],
      askSources: layered.permissionSources.ask,
    },
    reminders: () => { taskList.tick(); const n = taskList.staleReminder(); return n ? [n] : [] },
    drainInjections: () => injectionBuffer.splice(0),
    injectTaskNotifications: true,
    hooks: settings.hooks,
    hookDeps,
  })
  // 消息只许落盘一遍：persisted 之后（appendFileState / updateJobState）再抛，catch 不得重复补写，
  // 否则 .jsonl 里同一批消息出现两次，活动日志也跟着重复。
  let persisted = false
  try {
    let step
    while (!(step = await gen.next()).done) {
      const ev = step.value
      if (ev.type === 'turn_end') { addUsage(ev.usage); handle.appendUsage(ev.usage, model) }
    }
    // 落盘本轮新增消息 + fileState 快照
    for (const m of messages.slice(lenBefore)) handle.appendMessage(m)
    persisted = true
    handle.appendFileState([...ctx.fileState])
    updateJobState(opts.jobShort, { state: 'completed', updatedAt: Date.now() })
  } catch (e) {
    try { if (!persisted) for (const m of messages.slice(lenBefore)) handle.appendMessage(m) } catch {}
    updateJobState(opts.jobShort, { state: 'failed', updatedAt: Date.now() })
  } finally {
    process.off('SIGTERM', onTerm)
    process.off('uncaughtException', onCrash)
    process.off('unhandledRejection', onCrash)
    await mcpCleanup()
  }
}
