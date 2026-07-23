// src/tui/useChat.ts
// 会话状态机的 React 实现。三层：
//  1. transcriptReducer：纯函数，LoopEvent/本地动作 → TranscriptItem[]（可独立测试）
//  2. createChatCore：与 React 无关的会话核心（session 持久化/compact/斜杠命令/usage，
//     权限 ask 通过 pendingAsk 状态暴露给 UI，UI 用 resolveAsk 回答）
//  3. useChat：薄 React 包装（useSyncExternalStore 订阅 core）
import { useSyncExternalStore } from 'react'
import fs from 'node:fs'
import path from 'node:path'
import { execSync, spawn, spawnSync } from 'node:child_process'
import type OpenAI from 'openai'
import { runLoop, toolOk, type LoopDeps, type LoopEvent } from '../loop.js'
import { allTools } from '../tools/index.js'
import { makeAgentTool } from '../tools/agent.js'
import { makeWorkflowTool } from '../tools/workflow.js'
import { runSubagent } from '../subagentRunner.js'
import { makeWebFetchTool } from '../tools/webfetch.js'
import { makeWebSearchTool, resolveWebSearchConfig } from '../tools/webSearchTool.js'
import { makeAskUserQuestionTool, type Question, type Answer } from '../tools/askUserQuestion.js'
import { makeExitPlanModeTool, type AllowedPrompt } from '../tools/exitPlanMode.js'
import { bgTaskListTool, taskOutputTool } from '../tools/taskTools.js'
import { taskCreateTool, taskGetTool, taskUpdateTool, taskListTool } from '../tools/taskListTools.js'
import { onNotification, drainNotifications, formatNotification, registerTask, updateTask, generateTaskId, listTasks } from '../tasks.js'
import { makeIdleNotifier, emitNotification, resolveNotifChannel } from '../notify.js'
import { runAutoDream } from '../services/memory/autoDream.js'
import { buildSystemPrompt, findMemoryFiles, PLAN_MODE_GUIDANCE } from '../prompt.js'
import { formatMemory, formatMemoryView } from '../memory.js'
import { scanMemoryFiles } from '../memdir/memoryScan.js'
import { listPromotionCandidates, promoteCandidate } from '../services/memory/promote.js'
import { parseFrontmatter } from '../agentsLoader.js'
import { loadSettings, loadRawUserSettings, saveRawUserSettings, saveOnboardingKeys, addUserAllowRule, removeUserAllowRuleByValue, removeUserDenyRuleByValue, removeUserAskRuleByValue, SETTINGS_FILE } from '../config.js'
import { isAuthError } from '../api.js'
import type { Settings, OnboardingKeys } from '../config.js'
import { loadAppState, saveAppState } from '../tipsState.js'
import { selectTip, recordTipShown } from './tips.js'
import { formatPermissionRules, resolveRuleRemoval } from '../permissionsView.js'
import { loadLayeredSettings } from '../settingsLayers.js'
import { runHooks } from '../hooks.js'
import { newFlushState, computeFlush, type FlushState } from './messageDisplayFlush.js'
import { makeHookRuntime } from '../hookRuntime.js'
import { isDangerous, type Decision, type PermissionMode, type PermissionDecisionReason } from '../permissions.js'
import { classify } from '../autoMode.js'
import { resolveDenyList, buildDenySourceMap } from '../deny.js'
import type { ToolContext, WorktreeSessionState } from '../tools/types.js'
import { newSession, openSession, listSessions, loadSession, sessionIdFromFile, stripBranchSuffix, nextBranchTitle, type SessionHandle, type UsageRecord } from '../session.js'
import { costCNY, cacheSavingsCNY } from '../pricing.js'
import {
  summarize, rebuildMessages, rebuildFromPrecompute,
  microcompact, checkRapidRefill, recordCompact, bumpTurnCounter, newCompactState,
  isContextOverflowError,
} from '../compact.js'
import { PrecomputeRegistry, PRECOMPUTE_BUFFER_FRACTION } from '../precompute.js'
import { estimateTextTokens, estimateMessagesTokens, effectiveThreshold, resolveContextWindow } from '../tokenEstimate.js'
import { TaskListStore } from '../taskList.js'
import { loadCustomCommands, expandCommand, INIT_PROMPT, formatContext, parseLoopCommand, LOOP_GUIDANCE } from '../commands.js'
import { generateRecap } from '../recap.js'
import { type ActiveGoal, GOAL_CLEAR_WORDS, MAX_GOAL_CONDITION_CHARS, MAX_GOAL_ITERATIONS, goalDirective, runGoalJudge } from '../goal.js'
import { SchedulerService, WAKEUP_TICK_LINE, genId } from '../services/scheduler/index.js'
import { setScheduler } from '../tools/scheduleWakeup.js'
import { resolveAgents } from '../agentsLoader.js'
import { exportTranscript } from '../export.js'
import os from 'node:os'
import { createCheckpointer, type Checkpointer } from '../checkpoint.js'
import { lastAssistantText, nthAssistantText, lastCodeBlock, copyToClipboard } from '../clipboard.js'
import { sessionStats, formatStats } from '../stats.js'
import { formatKeybindings } from '../keybindings.js'
import { startMcpConnections } from '../mcp.js'
import { createMcpRegistry } from '../mcpRegistry.js'
import { loadSkills, substituteSkillArgs } from '../skillsLoader.js'
import { makeSkillTool } from '../tools/skill.js'
import { detectEffortKeyword } from '../text.js'
import { detectUltracode, workflowUsageWarning } from '../workflow/trigger.js'
import { parseTokenBudget } from '../tokenBudget.js'
import { memdirFor, globalMemdirFor, sessionMemoryPathFor, findGitRoot, sanitizeProjectKey } from '../memdir/paths.js'
import { createActivityWriter } from '../memdir/activityLog.js'
import { DEFAULT_MEMORY_CONFIG } from '../memdir/memoryConfig.js'
import { createMemoryExtractor } from '../services/memory/extractMemories.js'
import { SteeringQueue, formatSteeringMessage, type SteeringItem } from '../steering.js'
import { type SessionMemoryState, shouldUpdateSessionMemory, runSessionMemoryUpdate } from '../services/memory/sessionMemory.js'
import { activeFastModel, activeModelMeta, activeProvider, allModelList, availablePresets, belongsToProvider, foreignProviderOf, providerKeyReady, providerLabel, resolveActiveProvider, resolveStartupModel, resolveSubModel, type ProviderId } from '../providers.js'
import { buildCarryFlags, buildResumeArgs, guardSwitch } from './tuiSwitch.js'
import { resolveResumeModel, rotateModel } from './resumeModel.js'
import { messagesToTranscript } from './restoreTranscript.js'
import { loadOutputStyles, resolveOutputStyle } from '../outputStyles.js'
import { createStatusLineRunner, execStatusLineCommand } from '../statusLine.js'
import { buildCommitGuidance, buildCommitPushPrGuidance, resolveAttribution, buildCommitContext, buildPrContext, isEmptyDiff, resolveBaseBranch, formatDiffView } from '../commitGuidance.js'
import { formatSkillsList, formatHooksConfig, formatMcpStatus, formatStatus, formatDoctor } from '../infoCommands.js'
import { VERSION } from '../version.js'
import { expandTextPlaceholders, type Attachment, type ImageEntry, type TextEntry, type DocEntry } from './pasteFold.js'
import { describeImage, GlmKeyMissingError } from '../imageDescribe.js'
import { parseDocument, DocParseTimeoutError } from '../docParse.js'
import { normalizeForVision } from '../imageResize.js'
import { buildBackgroundArgv, writeJobState, updateJobState, shortId, readJobState, formatJobList, reconcileJobs, isPidAlive } from '../backgroundSession.js'
import type { CollapsedCounts } from './focusFold.js'
import { resolveInitialFocus } from './viewMode.js'
import { collectFleet } from '../fleet.js'
import { loadWorkflowRuns } from './useFleet.js'

/** ! 直跑：同步执行，30s 超时，stdout+stderr 合并，超 20k 截断 */
export function runBang(cmd: string, cwd: string): { output: string; code: number } {
  try {
    const out = execSync(cmd, { cwd, timeout: 30_000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { output: out.slice(0, 20_000), code: 0 }
  } catch (e: any) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}` || String(e.message)
    return { output: out.slice(0, 20_000), code: e.status ?? 1 }
  }
}

/** /cd 路径解析：相对 cwd + 展开 ~/~/ → 校验存在且是目录。纯函数，供 /cd 命令与单测复用。 */
export function resolveCdTarget(cwd: string, arg: string, home: string = os.homedir()):
  { ok: true; path: string } | { ok: false; error: string } {
  const expanded = arg === '~' ? home : arg.startsWith('~/') ? path.join(home, arg.slice(2)) : arg
  const resolved = path.resolve(cwd, expanded)
  try {
    if (!fs.statSync(resolved).isDirectory()) return { ok: false, error: `不是目录：${resolved}` }
  } catch {
    return { ok: false, error: `目录不存在：${resolved}` }
  }
  return { ok: true, path: resolved }
}

/** @path 展开为 <file> 块（≤400 行/文件）。
 *  - 仅匹配词首 @token（前面必须是行首或空白），避免误伤 email/git remote/@scoped 包名。
 *  - 读取失败：原文保持不变，路径收集到 misses 数组供调用方决定是否提示。
 */
export function expandAtRefs(text: string, cwd: string): { text: string; misses: string[] } {
  const misses: string[] = []
  const result = text.replace(/(^|\s)@([^\s]+)/g, (m, sep, p) => {
    try {
      const lines = fs.readFileSync(path.resolve(cwd, p), 'utf8').split('\n')
      const body = lines.slice(0, 400).join('\n') + (lines.length > 400 ? '\n…（截断）' : '')
      return `${sep}\n<file path="${p}">\n${body}\n</file>\n`
    } catch {
      misses.push(p)
      return m  // 原文不动
    }
  })
  return { text: result, misses }
}

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; segments: { orig: string; shown?: string }[]; pending: string; messageId: string; done: boolean }
  | { kind: 'reasoning'; segments: { orig: string; shown?: string }[]; pending: string; messageId: string; done: boolean }
  | { kind: 'tool'; id: string; name: string; desc: string; running: boolean; ok?: boolean; preview?: string; previewExtra?: number; ms?: number }
  | { kind: 'usage'; in: number; hit: number; out: number; totalIn: number; totalOut: number; cost: number }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'bang'; cmd: string; output: string } // ! 直跑结果块（Task 9 填充）
  | { kind: 'collapsed'; id: string; counts: CollapsedCounts }

export type ReducerAction =
  | { type: 'delta'; delta: string; reasoning: boolean; messageId: string }
  | { type: 'close_segment'; messageId: string; orig: string }
  | { type: 'patch_segment'; messageId: string; index: number; shown: string }
  | LoopEvent & { type: 'tool_start' | 'tool_end' }
  | { type: 'turn_end'; usage: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens: number }; totals?: { in: number; out: number; cost: number } }
  | { type: 'push'; item: TranscriptItem }
  | { type: 'seal' }  // 关闭所有未完成的 assistant/reasoning 块（空文本块直接丢弃）
  | { type: 'clear' }

/** assistant/reasoning 显示串：各 segment 取 shown（被 MessageDisplay 替换）否则 orig，拼上未完成 pending。 */
export function displayTextOf(it: { segments: { orig: string; shown?: string }[]; pending: string }): string {
  return it.segments.map(s => s.shown ?? s.orig).join('') + it.pending
}

/** 纯函数：永远返回新数组（React 状态纪律） */
export function transcriptReducer(state: TranscriptItem[], a: ReducerAction): TranscriptItem[] {
  if (a.type === 'delta') {
    const kind = a.reasoning ? ('reasoning' as const) : ('assistant' as const)
    // 追加到进行中的同类块；没有则新开一块
    for (let i = state.length - 1; i >= 0; i--) {
      const it = state[i]
      if (it.kind === kind && !it.done) {
        const next = [...state]
        next[i] = { ...it, pending: it.pending + a.delta }
        return next
      }
    }
    return [...state, { kind, segments: [], pending: a.delta, messageId: a.messageId, done: false }]
  }
  if (a.type === 'close_segment') {
    for (let i = state.length - 1; i >= 0; i--) {
      const it = state[i]
      if ((it.kind === 'assistant' || it.kind === 'reasoning') && !it.done && it.messageId === a.messageId) {
        const next = [...state]
        next[i] = { ...it, segments: [...it.segments, { orig: a.orig }], pending: it.pending.slice(a.orig.length) }
        return next
      }
    }
    return state
  }
  if (a.type === 'patch_segment') {
    for (let i = state.length - 1; i >= 0; i--) {
      const it = state[i]
      if ((it.kind === 'assistant' || it.kind === 'reasoning') && it.messageId === a.messageId && a.index < it.segments.length && a.index >= 0) {
        const next = [...state]
        const segs = it.segments.slice()
        segs[a.index] = { ...segs[a.index], shown: a.shown }
        next[i] = { ...it, segments: segs }
        return next
      }
    }
    return state
  }
  if (a.type === 'tool_start') {
    // 工具调用开始前先封闭所有进行中的 assistant/reasoning 块（复用 seal 语义）。
    // 保证 done 列表严格追加：文本块在工具条目之前进入 done，过滤后的索引稳定，
    // ink <Static> 不会出现中间插入导致工具行重复渲染或文本块永久丢失的问题。
    const sealed = transcriptReducer(state, { type: 'seal' })
    return [...sealed, { kind: 'tool', id: a.id, name: a.name, desc: a.desc, running: true }]
  }
  if (a.type === 'tool_end') {
    return state.map(it =>
      it.kind === 'tool' && it.id === a.id
        ? { ...it, running: false, ok: a.ok, preview: a.preview, previewExtra: a.previewExtra, ms: a.ms }
        : it,
    )
  }
  if (a.type === 'seal') {
    // 关闭所有进行中的 assistant/reasoning 块；空文本块直接丢弃（避免跨 turn 合并残留）
    return state
      .map(it =>
        (it.kind === 'assistant' || it.kind === 'reasoning') && !it.done ? { ...it, done: true } : it,
      )
      .filter(it => (it.kind === 'assistant' || it.kind === 'reasoning') ? displayTextOf(it).length > 0 : true)
  }
  if (a.type === 'turn_end') {
    // 关闭所有进行中的 assistant/reasoning 块，并追加 usage 行（复用 seal 语义）
    const sealed = transcriptReducer(state, { type: 'seal' })
    const next: TranscriptItem[] = [...sealed]
    next.push({
      kind: 'usage',
      in: a.usage.prompt_tokens,
      hit: a.usage.prompt_cache_hit_tokens,
      out: a.usage.completion_tokens,
      totalIn: a.totals?.in ?? a.usage.prompt_tokens,
      totalOut: a.totals?.out ?? a.usage.completion_tokens,
      cost: a.totals?.cost ?? 0,
    })
    return next
  }
  if (a.type === 'push') return [...state, a.item]
  return [] // clear
}

export interface PendingAsk { toolName: string; desc: string; dangerous: boolean; reason?: PermissionDecisionReason; previewRule?: string; resolve: (d: Decision) => void }
export interface PendingQuestion { questions: Question[]; resolve: (a: Answer[] | null) => void }
export interface PendingPlanApproval { plan: string; allowedPrompts?: AllowedPrompt[]; resolve: (approved: boolean) => void }
/** /model 选中一个未配 key 的 provider 时挂起：UI 弹单 provider key 录入 overlay，core.resolveKeyEntry 回答。 */
export interface PendingKeyEntry { providerId: string; label: string; baseURL: string; model: string; modelId: string }

/** 启动时算一次 spinner tip：递增会话计数→按冷却选一条→记录历史→持久化。返回 tip 文案或 null。 */
export function computeSpinnerTip(
  settings: Pick<Settings, 'spinnerTips' | 'spinnerTipsOverride'>,
  stateFile?: string,
  rng?: () => number,
): string | null {
  if (settings.spinnerTips === false) return null
  const st = stateFile ? loadAppState(stateFile) : loadAppState()
  st.startupCount += 1
  const tip = selectTip({ startupCount: st.startupCount, tipsHistory: st.tipsHistory, override: settings.spinnerTipsOverride, rng })
  if (tip) st.tipsHistory = recordTipShown(tip.id, st.startupCount, st.tipsHistory)
  if (stateFile) saveAppState(st, stateFile); else saveAppState(st)
  return tip?.content ?? null
}

/** 同步展开文本占位符（不含图片）。send 与 steer 共用，保证「入队前展开」。 */
export function expandTextAttachments(text: string, attachments?: Attachment[]): string {
  if (!attachments?.length) return text
  const textMap = new Map(
    attachments.filter(a => a.type === 'text').map(a => [a.id, { content: (a as TextEntry).content }]),
  )
  return expandTextPlaceholders(text, textMap)
}

/** 把 displayText 里的附件占位符解析成最终文本。Phase 2：文本同步展开 + 图片异步 describeImage 注入。 */
export async function resolveAttachments(
  text: string,
  attachments?: Attachment[],
  deps: { describe?: typeof describeImage; onStep?: (id: number) => void; onError?: (msg: string) => void; onUsage?: (u: UsageRecord['usage'], model: string) => void } = {},
): Promise<string> {
  if (!attachments?.length) return text
  // 1) 展开文本占位符
  const textMap = new Map(
    attachments.filter(a => a.type === 'text').map(a => [a.id, { content: (a as TextEntry).content }]),
  )
  let out = expandTextPlaceholders(text, textMap)
  // 2) 图片占位符 → describeImage 注入
  const describe = deps.describe ?? describeImage
  const userText = out.replace(/\[Image #\d+\]/g, '').trim()
  for (const a of attachments) {
    if (a.type !== 'image') continue
    const img = a as ImageEntry
    deps.onStep?.(img.id)
    let injected: string
    try {
      const desc = await describe({ base64: img.base64, mime: img.mime }, userText, { onUsage: deps.onUsage })
      injected = `<图片#${img.id} 识别(glm-4.6v)>${desc}</图片#${img.id}>`
    } catch (e) {
      const reason = e instanceof GlmKeyMissingError ? '未配置 GLM key' : '识别失败'
      deps.onError?.(reason)
      injected = `<图片#${img.id} 无法识别：${reason}>`
    }
    out = out.replace(`[Image #${img.id}]`, () => injected)
  }
  return out
}

/** 把 displayText 里的 [Doc #N] 占位符解析成 GLM-OCR markdown 注入（镜像 resolveAttachments 的图片路径）。 */
export async function resolveDocPlaceholders(
  text: string,
  attachments?: Attachment[],
  deps: { parse?: typeof parseDocument; onStart?: (id: number) => void; onEnd?: (id: number, ok: boolean) => void; onError?: (msg: string) => void } = {},
): Promise<string> {
  if (!attachments?.length) return text
  const parse = deps.parse ?? parseDocument
  let out = text
  for (const a of attachments) {
    if (a.type !== 'doc') continue
    const doc = a as DocEntry
    deps.onStart?.(doc.id)
    let injected: string
    try {
      const { markdown } = await parse(doc.base64, doc.mime)
      injected = `<文档#${doc.id} 解析(glm-ocr)>\n${markdown}\n</文档#${doc.id}>`
      deps.onEnd?.(doc.id, true)
    } catch (e) {
      const reason = e instanceof GlmKeyMissingError ? '未配置 GLM key'
        : e instanceof DocParseTimeoutError ? '解析超时（PDF 页数可能过多）'
        : '解析失败'
      deps.onError?.(reason)
      injected = `<文档#${doc.id} 无法解析：${reason}>`
      deps.onEnd?.(doc.id, false)
    }
    out = out.replace(`[Doc #${doc.id}]`, () => injected)
  }
  return out
}

export interface ChatState {
  transcript: TranscriptItem[]
  busy: boolean
  model: string
  thinking: boolean
  effortLevel: 'low' | 'medium' | 'high'
  permMode: PermissionMode
  pendingAsk: PendingAsk | null
  pendingQuestion: PendingQuestion | null
  pendingPlanApproval: PendingPlanApproval | null
  pendingKeyEntry: PendingKeyEntry | null
  usageLog: UsageRecord[]
  lastTokPerSec: number | null
  turnStartAt: number | null // 当前轮开始时间戳（spinner 计算耗时秒数；空闲为 null）
  turnOutTokens: number      // 当前轮累计输出 token（spinner 实时显示；流式估算，turn 边界用真实值校准）
  hookProgress: string | null // 1.7 当前运行中的慢阶段 hook 文案（null=无）
  spinnerTip: string | null // 5.10 本会话固定显示的 tip（null=关闭/无合格）
  sessionCost(): number
  cacheHitRate(): number // usageLog 累计 hit/prompt，DeepSeek 状态行核心指标
  cacheSavings(): number // usageLog 累计缓存省下金额（CNY），DeepSeek 状态行
  contextPct(): number // 上下文占比：lastPromptTokens / 生效阈值（0-100），用于状态栏上下文条
  contextUsed(): number // 上次真实 prompt_tokens（状态栏上下文条分子）
  contextWindow(): number // 当前模型生效阈值（状态栏上下文条分母）
  tokenBudget(): number | null // 2.1 sticky token 预算目标（null=未设）
  budgetUsed(): number // 2.1 本次/上次 send 累计输出 token（状态栏 budget 段分子）
  statusLineOutput: string | null // 5.7 自定义状态栏命令输出缓存（null=无/未设）
}

export interface ChatCore {
  state: ChatState
  send(line: string, attachments?: Attachment[]): Promise<void> // 斜杠命令本地处理；其余走 runLoop（含边界 reminders、落盘、自动 compact）
  cycleMode(): void // Shift+Tab / /cycle-mode 共用：前进一档权限模式，不受 busy 门
  interrupt(): void // Esc
  steer(text: string, attachments?: Attachment[]): void // busy 时 Enter：入队 next；若 toolInFlight 则同时软中断
  steerPop(): string | undefined
  steerQueue(): readonly SteeringItem[]
  resolveAsk(d: Decision): void // 权限弹窗回答
  resolveQuestion(answers: Answer[] | null): void // AskUserQuestion 弹窗回答
  resolvePlanApproval(approved: boolean): void // ExitPlanMode 计划审批回答
  /** pendingKeyEntry 回答：传入 key → 存该 provider 的 key（不动 provider/model 字段）→ 重试 switchProvider；
   *  传 undefined（取消）→ 只清挂起状态，不切换。 */
  resolveKeyEntry(key: string | undefined): void
  resumeList(): { file: string; preview: string }[]
  resume(file: string): void
  customCommands: Map<string, { template: string; source: 'user' | 'project' }>
  skills: import('../skillsLoader.js').SkillDefinition[]
  /** 当前 skillOverrides 快照（/skills 四态编辑初始态）。 */
  skillOverrides(): Record<string, import('../config.js').SkillOverrideState>
  /** /skills 落盘：写 user 层 skillOverrides + 重载技能 + 重建系统提示。 */
  saveSkillOverrides(o: Record<string, import('../config.js').SkillOverrideState>): void
  /** React useSyncExternalStore 订阅口（onState 仍保留给非 React 消费者） */
  subscribe(listener: () => void): () => void
  rewindList(): { turnId: number; preview: string; fileCount: number }[]
  rewind(toTurnId: number, mode: 'conversation' | 'code' | 'both'): void
  /** 当前会话 cwd（EnterWorktree 切换后实时反映） */
  getCwd(): string
  /** 退订后台任务通知订阅，避免泄漏（core 生命周期 = 进程，App 无需调用；测试与正确性需要） */
  dispose(): void
  /** 有界 drain 记忆提取（最多等 EXTRACT_DRAIN_TIMEOUT_MS），供杀进程的退出路径 await——不 await 则后台提取子代理被杀、记忆没写成盘。幂等，可重复调。 */
  flushMemory(): Promise<void>
  modelList(): import('../providers.js').ModelListItem[]
  /** providerId 由选择器项透传（跨 provider 选中时据此切换）；命令行输入路径不传，由 model id 反推归属。 */
  applyModel(id: string, providerId?: string): void
  outputStyleList(): { name: string; description: string }[]
  applyOutputStyle(name: string): void
  /** fork 当前会话到新文件、写初始 working state、spawn detached 后台子进程（不 process.exit，退出由 App 层做） */
  backgroundSession(seed?: string): Promise<{ ok: boolean; message: string; spawned?: boolean }>
  /** 包装 questionAsk 的二选一确认弹窗；返回 true 当且仅当用户选中 yes */
  askConfirm(question: string, header: string, yes: string, no: string): Promise<boolean>
  /** 推 transcript notice（App/FullscreenApp 的 /tui、/focus 命令用） */
  notice(level: 'info' | 'warn' | 'error', text: string): void
  /** ink 卸载（/tui 切换 spawnSync 前调用） */
  unmount(): void
  /** 当前 focus 视图开关 */
  focusMode(): boolean
  /** 切换 focus 视图，返回切换后的值 */
  toggleFocus(): boolean
  /** focus 是否被 settings.json viewMode:focus 锁定（锁定则 /focus 不可关） */
  focusLocked(): boolean
  /** 记忆是否被 /pause-memory 会话级暂停（暂停时跳过 extract/sessionMemory/autoDream 三处门控 + 系统提示剔除已加载记忆） */
  memoryPaused(): boolean
  /** 当前会话文件路径（/tui 切换 --resume 用） */
  sessionFile(): string | undefined
  /** transcript 是否含 user 条目（/tui 切换判断是否带 --resume） */
  hasTranscript(): boolean
  /** 是否有后台工作正在运行（band==='working'）——/tui 切换门控 */
  anyRunningWork(): boolean
  /** 当前 provider 展示名（横幅用；展示组件不自己读磁盘）。 */
  providerName(): string
  /** /setup 向导 initial 预填：当前 provider + custom 后端定义（无遮罩 key，Setup 本身不回显 key）。 */
  existingKeysSummary(): Partial<OnboardingKeys>
  /** /setup 完成后调用：重读 webSearch key 到内存工具配置，使新加 key 免重启即时生效。
   *  主 provider 自身的 key/切换不在此路径（客户端已固化，仍需 /model 或重启）。 */
  reloadSettings(): void
  /** /tui 切换 carry-flags 用 getters */
  yolo(): boolean
  permMode(): PermissionMode
  model(): string
  addDirs(): string[]
}

/** 压缩（summarize LLM 调用）超时上限：到点自动 abort，防 provider 卡住流时 /compact 与自动压缩无限挂起。 */
export const COMPACT_TIMEOUT_MS = 120_000

/** Shift+Tab 五态循环的纯函数；disableAuto=true 时跳过 auto 态。可被测试直接 import。 */
export function nextPermMode(cur: PermissionMode, disableAuto: boolean): PermissionMode {
  if (cur === 'default') return disableAuto ? 'acceptEdits' : 'auto'
  if (cur === 'auto') return 'acceptEdits'
  if (cur === 'acceptEdits') return 'plan'
  if (cur === 'plan') return 'dontAsk'
  if (cur === 'dontAsk') return 'default'
  return 'default'
}

// 退出/清空时 drain 记忆提取的有界超时：真实两步法提取（含 MemWrite + MemEdit MEMORY.md）
// 冷启动实测最坏约 28s，给 30s 兜底；Promise.race 下提取先完成就提前返回，正常不会等满。
// 会话内每轮末已 fire-and-forget 跑提取，退出兜底只是保险，多数情况提取早已写完。
const EXTRACT_DRAIN_TIMEOUT_MS = 30000

const HELP_TEXT =
  '/model  无参打开模型选择器；/model <名> 直接切到指定模型\n/setup  重新配置 API key（LLM/搜索/图片识别，主 provider 切换仍用 /model）\n/think  thinking 模式开关\n/effort 思考档位 low/medium/high/off\n/accept acceptEdits 模式开关（Edit/Write 免确认，Bash 仍确认）\n/auto 或 Shift+Tab：auto 模式（分类器自动判 run/ask/block，只读免审）\n/plan   plan 模式开关（只读探索+写计划，ExitPlanMode 请用户审批）\n/dontask dontAsk 模式（读放行/写自动拒，不弹窗；Shift+Tab 循环含此档）\n/add-dir <路径> 添加工作目录白名单（plan 模式围栏扩展）\n/cd <路径> 迁移会话主工作目录（刷新环境/项目记忆/技能，与 /add-dir 互补）\n/cost   本会话花费明细\n/recap  一句话回顾当前会话（目标+下一步）\n/goal <条件> 设置会话级停止前自检目标；无参报告进行中目标；/goal clear 清除\n/context 上下文占比与上次 usage\n/stats  本会话统计（轮数/工具/token/缓存/花费）\n/copy   复制上条回复到剪贴板\n/memory 查看生效的指令文件与全局记忆抽屉；/memory rm <编号> <文件名> 删除某条全局记忆（文件名以列表为准，防止列表变化后删错）；/memory promote 列出可升格到全局的存量记忆；/memory promote <编号> <文件名> 升格某条\n/pause-memory（别名 /memory-pause、/toggle-memory）暂停/恢复本会话记忆读写\n/reload-skills 重扫并热加载本会话新增/改动的技能\n/compact 手动压缩对话历史\n/clear  清空对话（开新会话文件，花费累计保留）\n/resume 列出并恢复本目录历史会话\n/rewind 回退到某轮之前（仅对话/仅代码/两者）\n/fork   分叉当前对话到新会话继续（原会话冻结，新会话标题加 (Branch)）\n/rename <名> 给当前会话命名（显示在 /resume 列表）\n/export 导出对话到 markdown 文件\n/permissions 查看/删除已保存权限规则（rm/deny-rm/ask-rm <编号>）\n/init   分析项目生成 DEEPCODE.md\n/keybindings 查看快捷键\n/tui <inline|fullscreen> 切换渲染器（重启并恢复当前会话）\n/focus  切换 focus 视图（全屏下折叠工具结果，只在全屏渲染器可用）\n/output-style 选择输出风格（default/Explanatory/Learning/自定义）\n/background 或 /bg [prompt] 把会话送到后台并释放终端\n/stop [id] 列出/停止后台会话\n/commit 生成并创建 git commit（预跑 git 状态+遵循仓库风格，带 Co-Authored-By: deepcode）\n/commit-push-pr 提交+推送+创建或更新 PR（## Summary/## Test plan，需 gh CLI）\n/exit   退出\n自定义命令：~/.deepcode/commands/*.md 或 <项目>/.deepcode/commands/*.md（$ARGUMENTS 占位）'

export function createChatCore(opts: {
  client: OpenAI
  yolo: boolean
  cwd: string
  continueSession?: boolean
  sessionDir?: string  // 测试注入：隔离 session 落盘目录，避免污染 ~/.deepcode/sessions
  home?: string        // 测试注入：隔离 memdir 系（活动日志/召回/session-memory）落盘根目录，避免污染 ~/.deepcode
  flagSettingsPath?: string
  resumeFile?: string  // Task6：--resume <文件> 精确恢复（交互路径 + /tui 切换后回带）
  justSwitched?: string // Task6：DEEPCODE_TUI_JUST_SWITCHED（'inline'|'fullscreen'）→ 首帧横幅 notice
  unmount?: () => void  // Task6：ink instance.unmount，供 /tui 切换 spawnSync 前卸载
  onState: (s: ChatState) => void
  /** 测试注入：替换 extractMemories 内的 runSubagent，用 spy 验证触发 */
  runSubagent?: import('../services/memory/extractMemories.js').ExtractorDeps['runSubagent']
  /** 测试注入：替换 backgroundSession 内 spawn detached 子进程用的函数 */
  spawnFn?: typeof spawn
  /** 测试注入：替换 /stop 内杀进程用的函数 */
  killFn?: (pid: number, sig: string) => void
  /** 测试注入：替换跨 provider 切换重启用的 spawnSync */
  spawnSyncFn?: typeof spawnSync
  /** 测试注入：替换跨 provider 切换重启后的 process.exit */
  exitFn?: (code: number) => void
}): ChatCore {
  const spawnBg = opts.spawnFn ?? spawn
  const killProc = opts.killFn ?? ((p: number, s: string) => process.kill(p, s as any))
  const spawnSyncProc = opts.spawnSyncFn ?? spawnSync
  const exitProc = opts.exitFn ?? ((c: number) => process.exit(c))
  const layered = loadLayeredSettings(opts.cwd, opts.flagSettingsPath)
  const settings = layered.settings
  const ruleSources = layered.permissionSources.allow
  const askSources = layered.permissionSources.ask
  const denySources = buildDenySourceMap(layered.permissionSources.deny)
  let cwd = opts.cwd
  const home = opts.home ?? os.homedir() // memdir 系（活动日志/召回/session-memory）落盘根目录
  let abort = new AbortController()
  const steerQueue = new SteeringQueue()
  let toolsRunning = 0 // 并发 tool 计数；steer() 据此判定是否附带软中断
  // settings.model 归属校验：属于别家 provider 时回落 active fast（否则会被静默打到当前 provider 的端点）。
  // model 在 CONFIG_KEYS 白名单里、模型自己能写，故此处必须防。foreignStartupModel 供启动后告警。
  // activeProvider() 走 loadSettings()（不带 flagPath），与 createClient(flagSettingsPath) 会分叉；
  // 本闭包手里就有 layered settings，一律用它解析 preset，否则 --settings 里的 provider 会被判成"外来"。
  const activePreset = resolveActiveProvider(settings)
  const foreignStartupModel = settings.model
    ? foreignProviderOf(activePreset, settings.model, availablePresets(settings))
    : undefined
  let model = resolveStartupModel(settings.model, activePreset, availablePresets(settings))
  // Task6 focus 视图：由 settings.viewMode 初始化；locked（viewMode:focus）时 /focus 不可关
  const initialFocus = resolveInitialFocus(settings)
  let focusMode = initialFocus.focusMode
  const focusLocked = initialFocus.locked
  let activeGoal: ActiveGoal | null = null // /goal：会话级停止前自检目标（内存，跨 turn，不落 session）
  let tokenBudget: number | null = null // 2.1 sticky 预算（进程内，不落 session；+0k 清除）
  let budgetUsed = 0                     // 2.1 本次 send 累计输出 token（状态栏 budget 段分子）
  let thinking = false
  let effortLevel: 'low' | 'medium' | 'high' = 'medium'
  let permMode: PermissionMode = opts.yolo ? 'yolo'
    : settings.permissions.defaultMode === 'dontAsk' ? 'dontAsk'
    : (settings.permissions.defaultMode === 'auto' && !settings.disableAutoMode) ? 'auto'
    : 'default'
  let prePlanMode: PermissionMode = 'default'  // plan 模式进入前的模式，退出时恢复
  let additionalDirs: string[] = []            // /add-dir 会话内白名单（不落盘）
  let memoryPaused = false                     // /pause-memory：会话级运行时暂停记忆
  const taskList = new TaskListStore()
  let nextTurnId = 1
  let currentTurnId = 0
  const turnOf = new WeakMap<object, number>()  // user 消息对象 → turnId（跨 compact 存活：rebuildMessages 用 slice 保留引用）
  let checkpointer!: Checkpointer
  const checkpointStoreFor = (sessionFile: string) =>
    path.join(os.homedir(), '.deepcode', 'checkpoints', sessionIdFromFile(sessionFile))

  let worktreeState: WorktreeSessionState | null = null
  const ctx: ToolContext = {
    cwd: () => cwd,
    setCwd: d => { cwd = d },
    denyPatterns: () => resolveDenyList(settings.permissions.deny),
    get signal() { return abort.signal },
    fileState: new Map(),
    taskList,
    recordBeforeImage: (absPath: string) => { if (currentTurnId > 0) checkpointer.capture(absPath, currentTurnId) },
    hookDispatch: (event, payload) => runHooks(event, payload, settings.hooks, hookDeps),
    sessionId: () => (session ? sessionIdFromFile(session.file) : undefined),
    worktreeSession: { get: () => worktreeState, set: s => { worktreeState = s } },
    worktreeConfig: () => settings.worktree,
  }
  const customCommands = loadCustomCommands(cwd)
  const agents = resolveAgents(cwd) // 内建 + 自定义合并后的注册表
  // Skills 接线：加载本地 skill 清单，建 injection buffer（inline skill 正文由此流入下一轮 user 消息）
  let skills = loadSkills(cwd, undefined, settings.skills, settings.skillOverrides)
  const injectionBuffer: string[] = []
  ctx.injectUserMessage = (c: string) => injectionBuffer.push(c)
  ctx.resetSignal = () => { abort = new AbortController() }
  const mem = settings.memory ?? DEFAULT_MEMORY_CONFIG
  let memdir = mem.enabled ? memdirFor(cwd, home) : undefined
  // 全局抽屉：它是永远在场的红线偏好，性质同 DEEPCODE.md，只受 memory.global.enabled 门控
  const globalMemdir = mem.enabled && mem.global.enabled ? globalMemdirFor(home) : undefined
  const originKey = () => sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
  const outputStyleCache = loadOutputStyles()
  let outputStyleName = settings.outputStyle ?? 'default'
  const messages: any[] = [{ role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, resolveOutputStyle(outputStyleName, outputStyleCache), focusMode, undefined, settings.language, globalMemdir, mem.global.maxBytes) }]
  const usageLog: UsageRecord[] = []
  let session!: SessionHandle
  let hookProgress: string | null = null
  const spinnerTip: string | null = computeSpinnerTip(settings)
  const hookDeps = {
    ...makeHookRuntime({
      client: opts.client,
      getModel: () => model,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      cwd: () => cwd,
      onProgress: (label?: string) => { hookProgress = label ?? null; setState() },
    }),
    allowedHttpHookUrls: settings.allowedHttpHookUrls,
    httpHookAllowedEnvVars: settings.httpHookAllowedEnvVars,
  }
  let compactAbort: AbortController | null = null // 进行中压缩的中止句柄（超时 + interrupt/ESC 用；空闲为 null）
  let compacted = false       // compact 后首条用户消息的一次性提醒
  let lastPromptTokens = 0    // 自动 compact 触发依据
  let baselineLen = 0         // 与 lastPromptTokens 原子配对：lastPromptTokens 覆盖的 messages 前缀长度（发送前预估只估超出此前缀的新消息）
  let costWarned = false      // $阈值提醒只发一次
  let compactWarned = false   // 上下文≥90% 一次性提示
  let workflowWarnShown = false // ultracode 消费门：首次弹一次
  const MAX_AUTO_COMPACT_FAILURES = 3
  let consecutiveCompactFailures = 0
  const precomputeReg = new PrecomputeRegistry() // ② 后台预算摘要注册表（内存版）
  const compactState = newCompactState()         // 3b 快速回填熔断状态（turnCounter/rapidRefills）
  const COMPACT_KEEP = 8 // rebuildMessages 默认保留条数，C1 prefix-overflow 守卫用

  // —— UI 状态 ——
  let currentTitle: string | null = null
  let transcript: TranscriptItem[] = []
  let pendingPlanApproval: PendingPlanApproval | null = null
  let busy = false
  let pendingAsk: PendingAsk | null = null
  let pendingQuestion: PendingQuestion | null = null
  let pendingKeyEntry: PendingKeyEntry | null = null
  let lastTokPerSec: number | null = null
  let turnStartAt: number | null = null
  let turnOutTokens = 0

  const sessionCost = () =>
    usageLog.reduce((s, u) => s + costCNY(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
  // memory fork 使用记录回调：带 kind:'memory' 标签，仅驻内存不落盘
  // （appendUsage 无 kind 字段，落盘后 resume 读回会变普通 usage 绕过过滤，破坏闭合）
  const memoryOnUsage = (u: UsageRecord['usage'], m: string) => {
    usageLog.push({ usage: u, model: m, kind: 'memory' })
  }
  // 操作性开销（权限分类器、图片识别）：计入 sessionCost 总额，但排除在主对话缓存/token 指标外。
  // 与 memoryOnUsage 一样仅驻内存不落盘（appendUsage 无 kind 字段，resume 读回会丢标签污染主指标）。
  const auxOnUsage = (u: UsageRecord['usage'], m: string) => {
    usageLog.push({ usage: u, model: m, kind: 'aux' })
  }
  const cacheHitRate = () => {
    const main = usageLog.filter(u => !u.kind)
    const prompt = main.reduce((s, u) => s + u.usage.prompt_tokens, 0)
    return prompt ? main.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0) / prompt : 0
  }
  const cacheSavings = () =>
    usageLog.filter(u => !u.kind).reduce((s, u) => s + cacheSavingsCNY(u.model, u.usage.prompt_cache_hit_tokens), 0)
  const contextPct = () => {
    const thr = effectiveThreshold(model, settings.compactTokens)
    return thr ? Math.min(100, Math.round((lastPromptTokens / thr) * 100)) : 0
  }
  const contextUsed = () => lastPromptTokens
  const contextWindow = () => resolveContextWindow(model)
  const tokenBudgetGet = () => tokenBudget
  const budgetUsedGet = () => budgetUsed

  // 所有状态变更走 setState：换新快照对象 → onState 回调 + 订阅者通知
  const listeners = new Set<() => void>()
  // 5.7 statusLine 输出（onChange 闭包按引用捕获 setState，运行期才调用，无 TDZ）
  let statusLineOutput: string | null = null
  const snap = (): ChatState => ({
    transcript, busy, model, thinking, effortLevel, permMode, pendingAsk, pendingQuestion, pendingPlanApproval, pendingKeyEntry, usageLog, lastTokPerSec, turnStartAt, turnOutTokens, hookProgress, spinnerTip, sessionCost, cacheHitRate, cacheSavings, contextPct, contextUsed, contextWindow, tokenBudget: tokenBudgetGet, budgetUsed: budgetUsedGet, statusLineOutput,
  })
  let state = snap()
  const setState = (): void => {
    state = snap()
    opts.onState(state)
    for (const l of listeners) l()
  }
  // 5.7 statusLine runner：仅当配置了命令才建
  const statusLineRunner = settings.statusLineCommand
    ? createStatusLineRunner({
        exec: () => execStatusLineCommand(settings.statusLineCommand!, {
          model, cwd, permission_mode: permMode, session_id: ctx.sessionId?.(),
        }),
        onChange: text => { statusLineOutput = text ?? null; setState() },
      })
    : undefined
  const refreshStatusLine = (): void => { statusLineRunner?.schedule() }
  // steering 队列变化驱动 React 重渲染（steer/steerPop → subscribe → setState）
  const unsubSteer = steerQueue.subscribe(setState)
  const dispatch = (a: ReducerAction): void => {
    transcript = transcriptReducer(transcript, a)
    setState()
  }
  const notice = (level: 'info' | 'warn' | 'error', text: string): void =>
    dispatch({ type: 'push', item: { kind: 'notice', level, text } })

  // —— 会话活动日志（dream 跨会话挖掘的语料源）——
  /** 该轮用户消息在日志里记什么（userMsg → 文本）。侧信道：不给消息加字段，否则会进 API payload。
   *  反向 fail-closed：默认记 displayLine（用户敲的那行），只有真正的用户输入路径记展开后的 userText。 */
  const activityDisplay = new WeakMap<object, string>()
  // isReadOnly 闭包不能直接捕获 `tools`（const，声明在本工厂之后，两处构造点都在其前）——
  // 直接引用会在 TDZ 期 ReferenceError，被 onMessage 外层 try/catch 吞掉 → writer 整个 dead，
  // 该会话一行日志都不写且毫无报错。改闭包捕获这个先声明的 ref，`tools` 赋值后回填（同
  // backgroundRunner.ts:78 的 `toolset` 写法）；TDZ 期最坏查空表退化成「按只读跳过」。
  let toolsRef: any[] = []
  /** 建 writer。三个构造点（newSession/openSession/派生会话）走工厂形式——先有 file 才推得出 sessionId。 */
  const makeActivityWriter = (file: string, o: { parent?: string; slug?: string } = {}) => createActivityWriter({
    memdir: () => memdirFor(cwd, home),   // 懒求值：/cd 之后 memdir 可能变
    sessionId: sessionIdFromFile(file),
    meta: { cwd, model, parent: o.parent },
    enabled: () => mem.enabled && !memoryPaused,   // 每次查（memoryPaused 可变）
    toolOk: m => toolOk.get(m),
    isReadOnly: name => toolsRef.find(t => t.name === name)?.isReadOnly ?? true,
    displayText: m => activityDisplay.get(m),
    slug: o.slug,
  })

  /** 恢复会话到内存：消息、模型设置、fileState（mtime 校验）、usage，并续写该文件。返回恢复的 user 轮数。（恢复会话逻辑） */
  const restoreSession = (file: string): number => {
    const loaded = loadSession(file)
    messages.length = 0
    messages.push(...loaded.messages)
    // 界面也要看得见：messages 只喂模型，transcript 才是 UI 渲染的那份。不重建就是「模型记得、界面空白」。
    transcript = messagesToTranscript(loaded.messages)
    model = resolveResumeModel(loaded.meta.model, activeProvider())
    thinking = loaded.meta.thinking
    effortLevel = loaded.meta.effortLevel ?? 'medium'
    // yolo 必须每次启动显式 --yolo，恢复的模式只允许 default/acceptEdits（含篡改文件兜底）
    if (!opts.yolo) permMode = loaded.meta.permMode === 'acceptEdits' ? 'acceptEdits' : 'default'
    // fileState 按 mtime 校验：文件已变则丢弃该条（自动失效，迫使模型重读）
    ctx.fileState.clear()
    for (const [p, mtime] of loaded.fileState) {
      try { if (fs.statSync(p).mtimeMs === mtime) ctx.fileState.set(p, mtime) } catch { /* 文件没了，跳过 */ }
    }
    usageLog.length = 0
    usageLog.push(...loaded.usages)
    // slug 必须由这里给：writer 自己推的话会拿「resume 后用户新说的话」算出另一个 slug，
    // 同一会话被写进两个日志文件（writer 内还有按 sessionId 前缀复用的兜底，这里是契约层）。
    const firstUser = loaded.messages.find(m => m.role === 'user' && typeof m.content === 'string')
    const slug = loaded.meta.title ?? (typeof firstUser?.content === 'string' ? firstUser.content : undefined)
    session = openSession(file, f => makeActivityWriter(f, { slug }))
    // 恢复后重置会话内状态，防止旧 todo/compact 标记/token 计数泄漏到新对话
    taskList.bind(sessionIdFromFile(session.file)); compacted = false; lastPromptTokens = 0; baselineLen = 0; consecutiveCompactFailures = 0; compactWarned = false
    precomputeReg.clear(); Object.assign(compactState, newCompactState()) // A1：/resume 切换到不同会话历史线，旧 precompute 快照与新历史不同源必须弃用
    // 强制重建 system prompt（不管落盘的 messages[0] 是不是 system）：全局记忆红线/项目记忆/skills/CLAUDE.md/
    // 环境信息(日期/cwd) 必须刷新到「现在」，否则 /resume 一个旧会话会永远缺席今天才记下的红线（opus 评审 gap）。
    // 用户拍板接受代价：内存态 system prompt 可能与落盘记录不一致；doCompact 崩溃兜底（原无 system 消息）合并到同一处，不再重复实现。
    memoryPaused = false // 恢复会话按新会话的初始状态起步，不沿用上一会话遗留的 /pause-memory 状态
    const rebuiltSystem = { role: 'system', content: buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, resolveOutputStyle(outputStyleName, outputStyleCache), focusMode, memoryPaused, settings.language, globalMemdir, mem.global.maxBytes) }
    if (messages.length === 0 || messages[0]?.role !== 'system') {
      messages.unshift(rebuiltSystem) // 落盘从未有过 system 消息（崩溃兜底）：这条要写回，否则下次恢复仍然没有
      session.appendMessage(messages[0])
    } else {
      messages[0] = rebuiltSystem // 正常路径：只替换内存态，不重复落盘
    }
    nextTurnId = loaded.maxTurnId + 1
    loaded.messages.forEach((m, i) => { if (loaded.messageTurnIds[i] !== undefined) turnOf.set(m, loaded.messageTurnIds[i]!) })
    checkpointer = createCheckpointer(checkpointStoreFor(file))
    currentTitle = loaded.meta.title ?? null
    return loaded.messages.filter(m => m.role === 'user').length
  }

  // —— SessionStart：会话开始事件。构造同步 → fire-and-forget；additionalContext 缓冲到下一轮 runTurn 起始 flush。 ——
  let pendingSessionContext: string | null = null
  const fireSessionStart = (source: 'startup' | 'resume' | 'clear'): void => {
    if (!settings.hooks) return
    void runHooks('SessionStart', {
      hook_event_name: 'SessionStart', cwd, session_id: ctx.sessionId?.(), source,
    }, settings.hooks, hookDeps).then(out => {
      if (out.additionalContext) {
        pendingSessionContext = pendingSessionContext ? `${pendingSessionContext}\n\n${out.additionalContext}` : out.additionalContext
      }
      if (out.systemMessage) notice('info', out.systemMessage)
    }).catch(() => { /* SessionStart hook 失败不影响会话启动 */ })
  }

  // —— 记忆 flush：有界 drain（超时兜底，绝不挂住退出），杀进程前的退出路径必须 await 这个，
  // 否则 fire-and-forget 的后台提取子代理会被杀进程带走、记忆没写成盘（真机冒烟实测的丢失根因）。幂等：
  // 无在飞提取时 extractor.drain() 立即 resolve。 ——
  const flushMemory = (): Promise<void> =>
    Promise.race([extractor.drain(), new Promise<void>(r => setTimeout(r, EXTRACT_DRAIN_TIMEOUT_MS))])

  // —— SessionEnd：会话结束事件。drain 部分返回给调用方可 await；SessionEnd hook 仍 fire-and-forget，失败不阻断退出/清空。 ——
  const fireSessionEnd = (reason: 'clear' | 'exit'): Promise<void> => {
    const drainP = flushMemory()
    if (settings.hooks) {
      void runHooks('SessionEnd', {
        hook_event_name: 'SessionEnd', cwd, session_id: ctx.sessionId?.(), reason,
      }, settings.hooks, hookDeps).catch(() => { /* SessionEnd hook 失败不阻断退出/清空 */ })
    }
    return drainP
  }

  // —— ConfigChange：会话内配置（权限规则）变更事件。fire-and-forget；失败不阻断保存。 ——
  const fireConfigChange = (): void => {
    if (!settings.hooks) return
    void runHooks('ConfigChange', {
      hook_event_name: 'ConfigChange', cwd, session_id: ctx.sessionId?.(),
      source: 'permissions', file_path: SETTINGS_FILE,
    }, settings.hooks, hookDeps).catch(() => { /* ConfigChange hook 失败不阻断保存 */ })
  }

  // 恢复（--resume <文件> 精确 / --continue 最近）或新建会话
  const sessionDir = opts.sessionDir  // undefined → newSession/listSessions 使用默认路径
  // Task6：--resume 精确恢复优先（/tui 切换回带同一会话文件）；文件不存在则回落 continue/新建
  let recovered: { file: string } | undefined
  if (foreignStartupModel) {
    notice('warn', `settings.model=${settings.model} 属于 ${foreignStartupModel} provider，当前 provider 是 ${activePreset.id}，已回落到 ${model}`)
  }
  if (opts.resumeFile) {
    try { fs.accessSync(opts.resumeFile); recovered = { file: opts.resumeFile } }
    catch { recovered = undefined }
  }
  if (!recovered && opts.continueSession) recovered = listSessions(cwd, sessionDir)[0]
  if (recovered) {
    const turns = restoreSession(recovered.file)
    notice('info', `已恢复会话（${turns} 轮对话），继续写入 ${recovered.file}`)
    fireSessionStart('resume')
  } else {
    session = newSession({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id }, sessionDir, makeActivityWriter)
    session.appendMessage(messages[0]) // 持久化 system 消息
    checkpointer = createCheckpointer(checkpointStoreFor(session.file))
    taskList.bind(sessionIdFromFile(session.file))
    currentTitle = null
    fireSessionStart('startup')
  }

  // —— 记忆提取器：每轮末 fire-and-forget onTurnEnd，退出/清空时 drain ——
  let extractor = createMemoryExtractor({
    client: opts.client, memdir: memdirFor(cwd, home), globalMemdir, originKey: originKey(), config: mem, ctx,
    runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
  })

  // —— SessionMemory 状态：跨轮持久，resume/clear 时重置 ——
  let smState: SessionMemoryState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }

  // —— autoDream：记录上次触发时间，每轮末门控后 fire-and-forget ——
  let dreamLastScanAt = 0

  // InstructionsLoaded：记忆文件加载记录（DEEPCODE.md/CLAUDE.md/全局）。fire-and-forget。
  if (settings.hooks) {
    const home = os.homedir()
    const globalMem = path.join(home, '.deepcode', 'DEEPCODE.md')
    for (const f of findMemoryFiles(cwd)) {
      void runHooks('InstructionsLoaded', {
        hook_event_name: 'InstructionsLoaded', cwd, session_id: ctx.sessionId?.(),
        file_path: f, memory_type: f === globalMem ? 'user' : 'project', load_reason: 'startup',
      }, settings.hooks, hookDeps).catch(() => {})
    }
  }

  // AskUserQuestion 桥：挂起 Promise + pendingQuestion 状态，UI 用 resolveQuestion 回答
  const questionAsk = (questions: Question[]): Promise<Answer[] | null> =>
    new Promise<Answer[] | null>(res => {
      pendingQuestion = { questions, resolve: res }
      setState()
    })

  // 7.3：二选一确认弹窗，复用 questionAsk（同 AskUserQuestion UI，无新组件）
  const askConfirm = async (question: string, header: string, yes: string, no: string): Promise<boolean> => {
    const ans = await questionAsk([{ question, header, multiSelect: false, options: [{ label: yes, description: '' }, { label: no, description: '' }] }])
    return !!ans && ans[0]?.selected?.[0] === yes
  }

  // ExitPlanMode 审批桥：挂起 Promise + pendingPlanApproval 状态，UI 用 resolvePlanApproval 回答
  const approvePlan = (plan: string, allowedPrompts?: AllowedPrompt[]): Promise<{ approved: boolean }> =>
    new Promise<{ approved: boolean }>(res => {
      pendingPlanApproval = { plan, allowedPrompts, resolve: (approved: boolean) => res({ approved }) }
      setState()
    })

  // /setup 加改搜索 key 后即时生效：webSearchConfig 保持同一对象引用，reloadSettings 原地 Object.assign 更新。
  const webSearchConfig = resolveWebSearchConfig(settings)
  const tools = [
    // allTools 中的静态 exitPlanModeTool 替换为工厂版（含审批回调）
    ...allTools.filter(t => t.name !== 'ExitPlanMode'),
    makeExitPlanModeTool({ approvePlan }),
    taskCreateTool,
    taskGetTool,
    taskUpdateTool,
    taskListTool,
    makeAgentTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      getModel: () => model,
      agents,
      worktree: settings.worktree,
    }),
    makeWorkflowTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      sessionModel: model,
      agents,
      runSubagent,
      journalDir: path.join(cwd, '.deepcode', 'workflows'),
      resolveModelAlias: (m: string) => resolveSubModel(m, model),
      worktree: settings.worktree,
      getSkipWorkflowWarning: () => loadSettings(cwd).skipWorkflowUsageWarning === true,
    }),
    makeWebFetchTool({
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
    }),
    makeWebSearchTool({ config: webSearchConfig }),
    makeAskUserQuestionTool({ ask: questionAsk }),
    makeSkillTool(() => skills, {
      client: opts.client,
      onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) },
      getModel: () => model, agents,
      skillPool: [...allTools, makeWebFetchTool({ client: opts.client, onUsage: (u, m) => { usageLog.push({ usage: u, model: m }); session.appendUsage(u, m) } })],
      listingBudgetChars: settings.skills?.listingBudgetChars,
    }),
    bgTaskListTool,
    taskOutputTool,
  ]
  toolsRef = tools // 回填：activityWriter 的 isReadOnly 闭包（声明早于此）拿到真实工具表

  const mcpRegistry = createMcpRegistry()
  // MCP 异步连接：立即返回，不阻断 TUI；每 server 独立并行，连上热插工具到同一 tools 引用。
  const mcpCleanup: (() => Promise<void>) = startMcpConnections(tools, settings.mcpServers, mcpRegistry, {
    onWarn: msg => notice('warn', msg),
    onChange: () => setState(),
  })

  /** compact 结果落地：替换 messages + 落盘 compact 记录与新前缀 + 状态重置 + PostCompact hook。
   *  全量 doCompact 与 precompute swap 共用，避免两处漂移。 */
  const applyCompactResult = async (
    rebuilt: any[],
    meta: { trigger: 'auto' | 'manual'; summary: string; truncated: boolean },
  ): Promise<void> => {
    const before = messages.length
    messages.length = 0
    messages.push(...rebuilt)
    // compact 把整段尾部历史重新 append 一遍（precompute 路径下可能几十条）。不 suppress 的话，
    // 这段活动会被写进日志第二遍 → dream 重复摘要。事件标记要在 suppress 之外补（让 dream 看得见这里压缩过）。
    session.suppressActivity(() => {
      session.appendCompact()
      for (const m of messages) session.appendMessage(m)
    })
    session.appendActivityEvent('compact')
    compacted = true
    lastPromptTokens = 0
    baselineLen = 0
    compactWarned = false
    if (settings.hooks) {
      await runHooks('PostCompact', {
        hook_event_name: 'PostCompact', cwd, trigger: meta.trigger,
        summary: meta.summary, truncated: meta.truncated,
        messages_before: before, messages_after: messages.length,
      }, settings.hooks, hookDeps)
    }
    notice('info', 'compact 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）')
    if (meta.truncated) notice('warn', '[compact 警告] 总结被长度截断，信息可能有损')
  }

  /** precompute 命中：用预算好的摘要 + arm 后尾部重建，无 LLM 等待。 */
  const swapPrecomputed = async (summary: string, truncated: boolean, armLen: number): Promise<void> => {
    const rebuilt = rebuildFromPrecompute(messages, summary, armLen)
    await applyCompactResult(rebuilt, { trigger: 'auto', summary, truncated })
    notice('info', '[precompute] 已换入预算摘要（无阻塞等待）')
  }

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。 */
  const doCompact = async (trigger: 'auto' | 'manual' = 'auto'): Promise<void> => {
    notice('info', '[compact 总结中…]')
    // ac 须可被中止：① 超时定时器（防 provider 卡住流无限挂起）② interrupt()/ESC（compactAbort 引用）。
    const ac = new AbortController()
    compactAbort = ac
    const timeoutTimer = setTimeout(() => ac.abort(new Error(`compact 超时（${COMPACT_TIMEOUT_MS / 1000}s 内 provider 无响应）`)), COMPACT_TIMEOUT_MS)
    try {
      if (settings.hooks) {
        await runHooks('PreCompact', {
          hook_event_name: 'PreCompact', cwd, trigger, messages_count: messages.length,
        }, settings.hooks, hookDeps)
      }
      // SessionMemory 并入：若 summary.md 存在，将其内容作为 user 前置消息注入 summarize 输入，保留会话状态
      let messagesForSummarize = messages
      const sid = ctx.sessionId?.()
      if (mem.enabled && mem.sessionMemory.enabled && sid) {
        const smPath = sessionMemoryPathFor(cwd, sid, home)
        try {
          const smContent = fs.readFileSync(smPath, 'utf8')
          messagesForSummarize = [
            ...messages.slice(0, 1), // system
            { role: 'user', content: `<会话记忆>\n${smContent}\n</会话记忆>` },
            ...messages.slice(1),
          ]
        } catch { /* summary.md 不存在则跳过 */ }
      }
      const { summary, usage: u, truncated } = await summarize(opts.client, messagesForSummarize, ac.signal)
      const sub = activeFastModel()
      usageLog.push({ usage: u, model: sub })
      session.appendUsage(u, sub)
      const rebuilt = rebuildMessages(messages, summary)
      await applyCompactResult(rebuilt, { trigger, summary, truncated })
    } finally {
      clearTimeout(timeoutTimer)
      compactAbort = null
    }
  }

  // 权限确认桥：挂起 Promise + pendingAsk 状态，UI 用 resolveAsk 回答
  const ask = (toolName: string, desc: string, reason?: PermissionDecisionReason, previewRule?: string): Promise<Decision> =>
    new Promise<Decision>(res => {
      // Notification hook：权限弹窗浮现给用户时通知（桌面通知转发等）。fire-and-forget。
      if (settings.hooks) {
        void runHooks('Notification', {
          hook_event_name: 'Notification', cwd, session_id: ctx.sessionId?.(),
          notification_type: 'permission', title: 'deepcode 需要确认', message: `${toolName}: ${desc}`,
        }, settings.hooks, hookDeps).catch(() => {})
      }
      emitNotification(`deepcode 需要你确认：${toolName}`, notifChannel())
      pendingAsk = { toolName, desc, dangerous: isDangerous(desc), reason, previewRule, resolve: res }
      setState()
    })

  /** 非斜杠输入：边界 reminders → user 消息落盘 → runLoop 驱动 →落盘 + 自动 compact
   *  @param activityText 本轮记进活动日志的「用户原话」。默认 displayLine——反向 fail-closed：
   *    9 个 runTurn 调用点里 8 个的 userText 是指导语（COMMIT_GUIDANCE/goalDirective/LOOP_GUIDANCE/
   *    技能正文…），几百字灌进 `>` 行就是拿指导语冒充用户诉求喂 dream。将来新增命令忘了传，
   *    最多只记命令名（安全），而不是污染语料。只有真正的用户输入路径显式传展开后的 userText。 */
  const runTurn = async (displayLine: string, userText: string, images?: { base64: string; mime: string }[], activityText: string = displayLine): Promise<void> => {
    // 动态 /loop 标志：displayLine 为这些值时，本轮属于动态/自主循环，turn 末需检查是否已续跑。
    const loopActive =
      displayLine === '（/loop 自起步）' ||
      displayLine === '（/loop 自主）' ||
      displayLine === WAKEUP_TICK_LINE
    scheduler.consumeScheduled() // 重置跨 turn 遗留标志（本轮终点 consumeScheduled 会再读正确值）
    // UserPromptSubmit hook：用户输入提交前。block/preventContinuation→拦截不发；additionalContext→附到 user 文本。
    // 守卫与 loop.ts 的 `if (deps.hooks)` 一致：未配 hooks 时不引入额外 await（保持 idle 唤醒时序）。
    if (settings.hooks) {
      const ups = await runHooks('UserPromptSubmit', {
        hook_event_name: 'UserPromptSubmit', cwd, prompt: userText,
      }, settings.hooks, hookDeps)
      if (ups.block || ups.preventContinuation) {
        dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
        notice('warn', `输入被 hook 拦截：${ups.blockReason ?? '（无原因）'}`)
        return
      }
      if (ups.additionalContext) userText = `${userText}\n\n<hook-context>\n${ups.additionalContext}\n</hook-context>`
    }
    // SessionStart 注入的上下文（若有）于本轮起始一次性并入用户文本（落在用户消息之前）。
    if (pendingSessionContext) {
      userText = `<hook-context>\n${pendingSessionContext}\n</hook-context>\n\n${userText}`
      pendingSessionContext = null
    }
    busy = true
    idleNotifier.cancel() // 用户回来了/新回合：清空闲计时
    turnStartAt = Date.now()
    turnOutTokens = 0
    let sendOutTokens = 0 // 本次 send 累计真实输出 token（每个 turn_end 校准 turnOutTokens）
    // 用户消息边界提醒：compact 一次性提示 + plan 模式指引 + fileState 外部修改检测
    const boundary: string[] = []
    if (compacted) {
      boundary.push('以上对话历史为有损总结，修改任何关键文件前请先 Read 重新确认其当前内容。')
      compacted = false
    }
    // plan 模式：每轮注入指引，确保模型始终感知约束（system-reminder 式注入）
    if (permMode === 'plan') boundary.push(PLAN_MODE_GUIDANCE)
    // ultracode 关键字触发：注入 Workflow 工具引导 + 首次消费门警告
    if (settings.workflowKeywordTriggerEnabled !== false && detectUltracode(displayLine)) {
      boundary.push('<ultracode>Use the Workflow tool to orchestrate this as a multi-agent workflow. Break the task into parallel steps and invoke Workflow with a plan.</ultracode>')
      const warn = workflowUsageWarning(workflowWarnShown || (settings.skipWorkflowUsageWarning ?? false))
      if (warn) { workflowWarnShown = true; notice('warn', warn) }
    }
    for (const [p, mtime] of ctx.fileState) {
      try {
        if (fs.statSync(p).mtimeMs !== mtime) {
          boundary.push(`文件 ${p} 在你上次读取后被外部修改，使用前请重新 Read。`)
          ctx.fileState.delete(p)
        }
      } catch {
        boundary.push(`文件 ${p} 已被删除。`)
        ctx.fileState.delete(p)
      }
    }
    dispatch({ type: 'push', item: { kind: 'user', text: displayLine } })
    const turnId = nextTurnId++
    currentTurnId = turnId
    const userMsg = {
      role: 'user',
      content: boundary.length ? `${userText}\n\n<system-reminder>\n${boundary.join('\n')}\n</system-reminder>` : userText,
      ...(images?.length ? { images } : {}),
    }
    turnOf.set(userMsg, turnId)
    activityDisplay.set(userMsg, activityText) // 活动日志记这行（默认 displayLine，见 runTurn 注释）
    messages.push(userMsg)
    session.appendMessage(userMsg, turnId) // user 输入即时落盘
    const lenBefore = messages.length
    abort = new AbortController()
    let overflowRetried = false // Task 8：反应式 overflow 兜底单发守卫（防死循环）
    let drive!: () => Promise<any> // runLoop 消费循环抽成可重入函数：overflow 时 microcompact 后重跑一次
    // 批B Task4：MessageDisplay flush 状态提升到 send 作用域（drive 内 delta/tool_start 与 send 的 finally 都要访问）。
    const mdEnabled = !!settings.hooks?.MessageDisplay
    let mdBlockCounter = 0
    let mdFlush: FlushState | null = null
    let mdTimer: ReturnType<typeof setTimeout> | null = null
    const mdClearTimer = () => { if (mdTimer) { clearTimeout(mdTimer); mdTimer = null } }
    // 立即或延时 flush 一批：dispatch close_segment 封段 + 异步 fire hook（不 await）+ resolve 后 patch_segment
    const mdDoFlush = (final: boolean) => {
      if (!mdFlush) return
      const r = computeFlush(mdFlush, Date.now(), final)
      if (r === null) return
      if ('defer' in r) { mdClearTimer(); mdTimer = setTimeout(() => mdDoFlush(false), r.defer); return }
      const st = mdFlush
      const { deltaText, index, end } = r
      st.flushedOffset = end; st.index++; st.lastFlushAt = Date.now()
      dispatch({ type: 'close_segment', messageId: st.messageId, orig: deltaText })
      void runHooks('MessageDisplay', {
        hook_event_name: 'MessageDisplay', cwd,
        turn_id: currentTurnId, message_id: st.messageId, index, final, delta: deltaText,
      }, settings.hooks, hookDeps).then(out => {
        if (out.displayContent !== undefined) dispatch({ type: 'patch_segment', messageId: st.messageId, index, shown: out.displayContent })
      }).catch(() => { /* display-only，失败静默 */ })
    }
    // 结束当前 assistant 块：final flush 后清状态（tool_start / drive 重入 / finally-seal 前调用）
    const mdEndBlock = () => { if (mdFlush) { mdClearTimer(); mdDoFlush(true); mdFlush = null } }
    try {
      // 关键词本轮临时升档（不改持久状态）
      const kw = detectEffortKeyword(userText)
      const turnThinking = kw ? true : thinking
      const turnEffort = kw ?? effortLevel
      // 2.1 Token budget：解析输入更新 sticky（+0k 清除/显式新值覆盖/无指令沿用），重置本 send 用量
      const parsedBudget = parseTokenBudget(userText)
      if (parsedBudget !== null) tokenBudget = parsedBudget === 0 ? null : parsedBudget
      budgetUsed = 0
      const deps: LoopDeps = {
        client: opts.client,
        tools,
        model,
        thinking: turnThinking,
        effortLevel: turnEffort,
        maxToolResultChars: settings.maxToolResultChars,
        ctx,
        permission: {
          get mode() { return permMode },
          rules: settings.permissions.allow,
          deny: resolveDenyList(settings.permissions.deny),
          cwd,
          additionalDirs,
          saveRule: r => {
            addUserAllowRule(r)        // 持久化到 user scope（raw RMW）
            if (!settings.permissions.allow.includes(r)) settings.permissions.allow.push(r) // 内存合并即时生效
            ruleSources[r] = 'user'
            fireConfigChange()
          },
          ask,
          ruleSources,
          askRules: settings.permissions.ask ?? [],
          askSources,
          denySources,
          classify: (t: string, d: string, s: string) => classify(t, d, s, { onUsage: auxOnUsage }),
          autoDenials: { consecutive: 0, total: 0 }, // S1 熔断器计数（会话级）
          setSkipWorkflowWarning: () => {
            try { const raw = loadRawUserSettings(); raw.skipWorkflowUsageWarning = true; saveRawUserSettings(raw); settings.skipWorkflowUsageWarning = true } catch { /* 持久化失败不阻断 */ }
          },
        },
        reminders: () => {
          taskList.tick()
          const notes: string[] = []
          const note = taskList.staleReminder()
          if (note) notes.push(note)
          const pend = mcpRegistry.pending().map(s => s.name)
          if (pend.length) notes.push(`以下 MCP server 仍在连接、其工具暂不可用：${pend.join(', ')}。需要它们时可调用 WaitForMcpServers 等待就绪。`)
          return notes
        },
        pendingMcpServers: () => mcpRegistry.pending().map(s => s.name),
        injectTaskNotifications: true, // 主会话：runLoop 终止点 drain 后台完成通知续跑
        hooks: settings.hooks,
        hookDeps,
        drainInjections: () => injectionBuffer.splice(0),
        drainSteering: () => steerQueue.drainAll().map(i => formatSteeringMessage(i.value)),
        goalGate: async (msgs: any[]) => {
          try {
            if (!activeGoal) return { continue: false as const }
            if (activeGoal.iterations >= MAX_GOAL_ITERATIONS) {
              activeGoal = null
              notice('warn', `目标续跑达上限（${MAX_GOAL_ITERATIONS} 轮），已放行停止。可重设 /goal 继续。`)
              return { continue: false as const }
            }
            const v = await runGoalJudge(opts.client, msgs, activeGoal.condition, activeFastModel(), abort.signal)
            if (!activeGoal) return { continue: false as const } // 判断期间目标被清除（如 /goal clear）：放行，不再解引用
            if (v === 'error') {
              // 用户 ESC 会一并 abort judge → 'error'：此时显「已中断」而非「校验失败」（区分主动中断与真故障）。
              if (abort.signal.aborted) notice('info', '已中断；目标仍生效，下次仍会检查（/goal clear 可清除）。')
              else notice('warn', '目标校验失败，本次已放行停止；目标仍生效，下次仍会检查（/goal clear 可清除）。')
              return { continue: false as const }
            }
            if (v.ok) {
              const cond = activeGoal.condition; activeGoal = null
              notice('info', `✅ 目标达成：${cond}`)
              return { continue: false as const }
            }
            if (v.impossible) {
              activeGoal = null
              notice('warn', `目标判定为无法达成，已放行停止：${v.reason ?? ''}`)
              return { continue: false as const }
            }
            activeGoal.iterations++
            activeGoal.lastReason = v.reason
            return { continue: true as const, inject: `<goal-check>\n目标尚未达成，继续朝条件推进，不要停下来问用户。\n未达成原因：${v.reason ?? '证据不足'}\n条件：${activeGoal.condition}\n</goal-check>` }
          } catch {
            return { continue: false as const }
          }
        },
        ...(tokenBudget ? { tokenBudget } : {}), // 2.1 sticky 预算（有值才传）
      }
      drive = async () => {
      // overflow 重试会二次调用 drive()：若上次调用残留未封闭的 assistant 块，先 final flush + 清空，防止跨重试串块。
      if (mdEnabled && mdFlush) mdEndBlock()
      const gen = runLoop(messages, deps)
      let firstDeltaAt: number | null = null // 本 turn 首个流式分片时间戳（tok/s 计算）
      let turnToolCalls = 0 // 本次内层 turn 工具调用数（维护 smState.toolCallsSinceUpdate）
      let atTurnStart = true // 每个内层 turn 开始时归零 turnToolCalls（防中断路径带入上轮脏值）
      let step
      while (!(step = await gen.next()).done) {
        if (atTurnStart) { turnToolCalls = 0; atTurnStart = false }
        const ev = step.value
        if (ev.type === 'text') {
          if (firstDeltaAt === null) firstDeltaAt = Date.now()
          // spinner 实时输出 token 估算（非思考流；CJK 感知加权，仅作动态观感）
          if (!ev.reasoning) turnOutTokens += estimateTextTokens(ev.delta)
          // 批B Task4：assistant 文本块（非 reasoning）每块 mint 唯一 messageId（mdEnabled 时靠 mdFlush 累积驱动 flush；
          // 关闭时 mdEnabled=false 机制零开销，仅走稳定占位 id，delta reducer 按 kind+!done 匹配不依赖 messageId 稳定）。
          if (!ev.reasoning && mdEnabled) {
            if (!mdFlush) mdFlush = newFlushState(`${currentTurnId}:${mdBlockCounter++}`, Date.now())
            mdFlush.rawText += ev.delta
          }
          const messageId = (!ev.reasoning && mdFlush) ? mdFlush.messageId : `${currentTurnId}:r${mdBlockCounter}`
          dispatch({ type: 'delta', delta: ev.delta, reasoning: !!ev.reasoning, messageId })
          if (!ev.reasoning && mdEnabled) mdDoFlush(false)
        } else if (ev.type === 'tool_start') {
          if (mdEnabled) mdEndBlock() // 当前 assistant 块被 tool_start 封闭 → final flush，防止跨 tool 边界串块
          turnToolCalls++
          toolsRunning++
          dispatch(ev)
        } else if (ev.type === 'tool_end') {
          toolsRunning = Math.max(0, toolsRunning - 1)
          dispatch(ev)
        } else if (ev.type === 'turn_end') {
          if (mdEnabled) mdEndBlock() // 悬空 assistant 块在 seal（turn_end 复用 seal 语义）前先 final flush，防止段已 done 后 close_segment 因 !it.done 守卫 no-op 丢失 patch
          usageLog.push({ usage: ev.usage, model })
          session.appendUsage(ev.usage, model)
          lastPromptTokens = ev.usage.prompt_tokens
          // baselineLen 原子配对：lastPromptTokens 覆盖发送时的 messages 前缀（sentLen，含本轮 user，但不含本轮 assistant 产出）
          baselineLen = ev.sentLen
          // turn 边界用真实累计输出 token 校准估算值（覆盖本 turn 期间的粗估）
          sendOutTokens += ev.usage.completion_tokens
          turnOutTokens = sendOutTokens
          budgetUsed = sendOutTokens // 2.1 状态栏 budget 段分子（与本 send 输出累计同步）
          if (firstDeltaAt !== null) {
            lastTokPerSec = ev.usage.completion_tokens / Math.max((Date.now() - firstDeltaAt) / 1000, 0.001)
            firstDeltaAt = null
          }
          const totIn = usageLog.filter(u => !u.kind).reduce((s, u) => s + u.usage.prompt_tokens, 0)
          const totOut = usageLog.filter(u => !u.kind).reduce((s, u) => s + u.usage.completion_tokens, 0)
          dispatch({ type: 'turn_end', usage: ev.usage, totals: { in: totIn, out: totOut, cost: sessionCost() } })
          if (!costWarned && sessionCost() > settings.costWarnCNY) {
            costWarned = true
            notice('warn', `[花费提醒] 本会话已超 ¥${settings.costWarnCNY}（/cost 查看明细，阈值在 settings.json 的 costWarnCNY）`)
          }
          const warnThr = effectiveThreshold(model, settings.compactTokens)
          const ctxPct = warnThr ? (lastPromptTokens / warnThr) * 100 : 0
          if (!compactWarned && ctxPct >= 90) {
            compactWarned = true
            notice('warn', `上下文已用 ${Math.round(ctxPct)}%，接近自动压缩阈值`)
          }
          // smState 每轮更新（turn_end 是本 inner-turn 的边界）
          smState.promptTokens = ev.usage.prompt_tokens
          smState.toolCallsSinceUpdate += turnToolCalls
          smState.lastTurnHadToolCalls = turnToolCalls > 0
          turnToolCalls = 0
          atTurnStart = true // 内层 turn 结束，下一内层 turn 开始前归零
        }
      }
      return step
      }
      const step = await drive()
      if (step.value === 'aborted') notice('warn', '[已中断]')
      if (step.value === 'max_turns') notice('error', '[达到最大轮数熔断]')
    } catch (e: any) {
      // Task 7：鉴权失效（401/invalid_api_key 等）优雅失败——不当普通错误报，弹当前 provider 的就地 key 重录 overlay。
      // 非鉴权错误（含 429/5xx/网络超时）维持原有 notice 报错不变。
      const reportTurnError = (err: any): void => {
        if (isAuthError(err)) {
          const label = providerLabel(activePreset.id)
          notice('error', `当前 ${label} 的 API key 失效或无效，请重新配置`)
          pendingKeyEntry = { providerId: activePreset.id, label, baseURL: activePreset.baseURL, model: activePreset.models.smart, modelId: model }
        } else {
          notice('error', `[错误] ${err?.message ?? err}`)
        }
      }
      // Task 8 反应式兜底：send 期间抛「上下文超长」
      // 且本轮尚未重试过 → microcompact 甩掉旧工具输出后重跑一次（单发，防死循环）。
      if (isContextOverflowError(e) && !overflowRetried) {
        const mc = microcompact(messages)
        if (mc) {
          overflowRetried = true
          messages.length = 0; messages.push(...mc.messages)
          lastPromptTokens = 0; baselineLen = 0
          notice('warn', `[context 超长] microcompact 甩掉 ~${mc.tokensSaved} tok 后重试`)
          try { const step2 = await drive(); if (step2.value === 'aborted') notice('warn', '[已中断]') }
          catch (e2: any) { reportTurnError(e2) } // mc 后仍超 → 报错（下轮主动 mc 兜）
        } else reportTurnError(e) // 无可甩 → 照常报错，不重试
      } else {
        reportTurnError(e)
      }
    } finally {
      // 悬空 assistant 块 final flush（seal 前，保证 close_segment 先于 seal，避免 flush 的 patch 落在已 seal 块外的时序问题）
      if (mdEnabled) mdEndBlock()
      // 中断或异常后封闭所有悬空的 assistant/reasoning 块，防止下一轮 delta 追加进旧块（跨 turn 合并 bug）
      dispatch({ type: 'seal' })
      // 本轮 loop 内部新增的 assistant/tool 消息补落盘 + fileState 快照
      for (const m of messages.slice(lenBefore)) session.appendMessage(m)
      session.appendFileState([...ctx.fileState])
    }

    // 记忆提取：每轮末 fire-and-forget（不等待，不阻断 UI）
    if (!memoryPaused) extractor.onTurnEnd({ messages, turnIds: messages.map(m => turnOf.get(m)), maxTurnId: currentTurnId })

    // SessionMemory：达阈值时 fire-and-forget 更新 summary.md（不阻断 UI）
    if (!memoryPaused && mem.enabled && mem.sessionMemory.enabled && shouldUpdateSessionMemory(smState, mem.sessionMemory)) {
      const sid = ctx.sessionId?.()
      if (sid) {
        const smPath = sessionMemoryPathFor(cwd, sid, home)
        void runSessionMemoryUpdate({ client: opts.client, model, absPath: smPath, ctx, runSubagent: opts.runSubagent, onUsage: memoryOnUsage })
        smState.tokensAtLastUpdate = smState.promptTokens
        smState.initialized = true
        smState.toolCallsSinceUpdate = 0
      }
    }

    // autoDream：满门控（24h/5会话/锁）时后台合并记忆，作后台任务带通知
    if (!memoryPaused && mem.enabled && mem.dream.enabled) {
      const now = Date.now()
      const sessionsDir = path.join(os.homedir(), '.deepcode', 'sessions')
      const dreamProjectKey = sanitizeProjectKey(findGitRoot(cwd) ?? path.resolve(cwd))
      let dreamTaskId: string | undefined
      void runAutoDream({
        client: opts.client, model, memdir: memdirFor(cwd, home),
        sessionsDir, currentSessionFile: session.file,
        projectKey: dreamProjectKey,
        cfg: mem.dream, ctx, now, lastScanAt: dreamLastScanAt,
        globalMemdir,
        indexConsolidation: mem.indexConsolidation.enabled,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
        onStart: () => {
          const taskId = generateTaskId('local_agent')
          dreamTaskId = taskId
          registerTask({
            id: taskId, type: 'local_agent', status: 'running',
            description: '记忆整理（dream）',
            startTime: now, outputFile: '', outputOffset: 0, notified: false,
          })
        },
        onDone: (changed) => {
          if (!dreamTaskId) return
          // dream 是静默内务：完成只更新任务状态（/fleet 可见），不注入通知、不唤醒会话（去噪）。
          updateTask(dreamTaskId, { status: changed ? 'completed' : 'failed', endTime: Date.now() })
        },
      })
      dreamLastScanAt = now
    }

    // 自动 compact（落盘之后；busy 保持 true 直到 compact 结束）
    // 发送前预估：上次真实 prompt_tokens + 自 baseline 以来新增消息的估算（含本轮 assistant 产出）。
    // clamp Math.min 守 rewind/截断（baselineLen 可能 > 当前 messages.length）。
    // ===== Compact 演进：mc 互斥 + prefix 守卫 + 3b block-before + consume-or-fallback + precompute arm =====
    let estimated = lastPromptTokens + estimateMessagesTokens(messages.slice(Math.min(baselineLen, messages.length)))
    const thr = effectiveThreshold(model, settings.compactTokens)
    let compactedThisTurn = false

    if (estimated >= thr) {
      // C1 prefix-overflow 守卫：不可压前缀（system + 最近 COMPACT_KEEP 条）本身 ≥ thr → compaction 帮不上
      // slice 从 max(1, …) 起，短对话下也不把 system(messages[0]) 重复计入
      const keepTail = messages.slice(Math.max(1, messages.length - COMPACT_KEEP))
      const incompressible = estimateMessagesTokens([messages[0], ...keepTail])
      if (incompressible >= thr) {
        notice('warn', 'compaction 帮不上：固定前缀（system + 最近消息）已超阈值，请 /clear 重开或分块读大文件')
      } else {
        // A2 互斥：先算 microcompact，仅当它单独就能压回阈值下才 apply
        const mc = microcompact(messages)
        if (mc && estimated - mc.tokensSaved < thr) {
          messages.length = 0
          messages.push(...mc.messages)
          lastPromptTokens = 0
          baselineLen = 0
          estimated = estimateMessagesTokens(messages)
          notice('info', `[microcompact] 甩掉 ~${mc.tokensSaved} tok 旧工具输出`)
          // 本轮不 compact（原始 tool 结果仍在转录，仅内存瘦身，不 appendCompact）
        } else {
          // A3 block-before：先查快速回填熔断
          const rr = checkRapidRefill(compactState)
          if (rr.tripped) {
            notice('warn', '上下文在 3 轮内反复填满 3 次，某文件或工具输出可能过大，请分块读或用 /clear 重开')
            messages.push({ role: 'user', content: '<system-reminder>\n上下文反复被填满（thrashing）。请停止重复读取大文件/大工具输出，改为分块读取，或提示用户用 /clear。\n</system-reminder>' })
            // 本轮不 compact；turnCounter 由下方统一 ++，≥3 时 checkRapidRefill 归零自愈（无永久 latch）
          } else if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) {
            // 3a 熔断已跳闸：停本会话自动全量 compact（直到 /compact 手动重置计数或会话重置），本轮不再尝试。
            // 首次达阈时 catch 分支已告警「已暂停」，此处静默跳过，不重复告警、不再烧 API。
          } else {
            try {
              const c = precomputeReg.consume(messages, estimateMessagesTokens, thr)
              if (c.kind === 'ready') {
                await swapPrecomputed(c.summary, c.truncated, c.armLen)
                compactedThisTurn = true
              } else if (c.kind === 'pending') {
                const aborted = await Promise.race([
                  c.settled.then(() => false),
                  new Promise<boolean>(res => abort.signal.addEventListener('abort', () => res(true), { once: true })),
                ])
                if (!aborted) {
                  const c2 = precomputeReg.consume(messages, estimateMessagesTokens, thr)
                  if (c2.kind === 'ready') { await swapPrecomputed(c2.summary, c2.truncated, c2.armLen); compactedThisTurn = true }
                  else { await doCompact('auto'); compactedThisTurn = true } // C4：settled 后仍非 ready → 全量
                }
                // aborted：本轮不 compact，entry 留待下轮
              } else {
                // none/failed/stale → 阻塞全量
                await doCompact('auto')
                compactedThisTurn = true
              }
              if (compactedThisTurn) {
                recordCompact(compactState, rr.rapidRefills)
                consecutiveCompactFailures = 0
                estimated = lastPromptTokens + estimateMessagesTokens(messages.slice(Math.min(baselineLen, messages.length))) // C3 重估
              }
            } catch (e: any) {
              consecutiveCompactFailures++
              if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) notice('warn', '自动压缩连续失败 3 次，已暂停（用 /compact 手动重试）')
              else notice('error', `[自动 compact 失败，将在下轮重试] ${e?.message ?? e}`)
            }
          }
        }
      }
    }

    if (!compactedThisTurn) bumpTurnCounter(compactState) // 本轮无全量 compact/swap 才 ++

    // precompute arm（下一轮预热）：过 arm 带且启用且空闲
    if (settings.precomputeCompactionEnabled !== false
        && estimated >= thr - PRECOMPUTE_BUFFER_FRACTION * thr
        && !precomputeReg.busy) {
      precomputeReg.arm(messages, messages.length, (m, sig) => summarize(opts.client, m, sig))
    }

    busy = false
    turnStartAt = null
    setState()
    refreshStatusLine() // 5.7 turn 结束触发 statusLine 刷新
    idleNotifier.arm() // 回合结束等用户：起空闲计时
    // keepalive：动态/自主循环 turn 末，若模型未调用 ScheduleWakeup，武装兜底 wakeup（budget 守卫在 service 内）。
    if (loopActive && !scheduler.consumeScheduled()) scheduler.onTurnEndedWithoutReschedule()
    // 收尾自检：若某后台任务在本轮终止点 drain 之后、busy 复位之前完成入队，会滞留队列；
    // 此处 busy 已 false，重新唤醒一次把滞留通知补上（无则即返），避免拖到下次用户输入。
    wakeOnNotification()
  }

  /** 空闲唤醒：后台任务完成通知到达且当前 idle 时，drain 通知作为 user 消息自动跑一轮，
   *  让模型据完成情况决策。busy 时不抢——此刻 runLoop 终止点（injectTaskNotifications）会 drain 注入。
   *  busy 守卫天然防重入：唤醒触发的 runTurn 会置 busy，期间再来的通知不重复触发。 */
  const wakeOnNotification = (): void => {
    if (busy) return
    const notes = drainNotifications()
    if (notes.length === 0) return
    for (const n of notes) emitNotification(n.summary, notifChannel())
    const text = notes.map(formatNotification).join('\n')
    void runTurn('（后台任务完成通知）', text)
  }
  const unsubNotification = onNotification(wakeOnNotification)

  const scheduler = new SchedulerService({
    isIdle: () => !busy,
    fire: (displayLine, prompt) => { void runTurn(displayLine, prompt) },
    cwd: () => cwd,
    doneMeansMerged: () => loadSettings(cwd).doneMeansMerged === true,
  })
  setScheduler(scheduler)
  scheduler.start()
  scheduler.reload(cwd)

  const notifChannel = () => resolveNotifChannel(settings.preferredNotifChannel)
  const idleNotifier = makeIdleNotifier({
    thresholdMs: settings.messageIdleNotifThresholdMs ?? 60000,
    isIdle: () => !busy,
    hasActiveLoop: () => scheduler.list().length > 0, // 有待触发 wakeup/cron = 自主 loop 活跃（不在等用户）
    emit: () => emitNotification('deepcode 正在等你输入', notifChannel()),
  })

  const hasTranscript = (): boolean => transcript.some(i => i.kind === 'user')
  const anyRunningWork = (): boolean => {
    const now = Date.now()
    const fleet = collectFleet({ jobs: reconcileJobs(now), tasks: listTasks(), workflowRuns: loadWorkflowRuns(cwd), overlay: {}, cwd, now })
    return fleet.some(w => w.band === 'working')
  }

  /**
   * 跨 provider 切换：active provider 在进程内锁定（memoize 的 _cachedProvider + 启动时按 preset 建好的 client
   * 已注入到 20+ 个持有点），运行时热切会留下半途不一致（计价/contextWindow/agents alias）。故走重启式——
   * 与 /tui 同一范式：写用户设置 → session 记新 model+providerId（--resume 回来时 resolveResumeModel 才会保留它）
   * → unmount → spawnSync 重开（带 --resume）→ exit。
   * key 预检是硬前置：api.ts createClient 无 key 直接 throw 退进程，若先写坏 settings 再崩会变成开机即崩的死循环。
   */
  const switchProvider = (targetId: string, id: string): void => {
    const preset = availablePresets(settings).find(p => p.id === targetId)
    if (!preset) { notice('error', `未知 provider ${targetId}`); return }
    // 全局 baseURL 盖住所有 preset 的端点（api.ts createClient），带着它切 provider = 新 key 打旧端点。
    // 这是配置级死结（配对 key 也没用），故先于 key 预检报，省用户一轮。不静默替他清掉——那是他显式配的逃生口。
    if (settings.baseURL) {
      notice('error', `检测到全局 baseURL（${settings.baseURL}），它会覆盖 provider 的端点，切换后仍会打到该地址。请先在 ${SETTINGS_FILE} 移除 baseURL 再切换。`)
      return
    }
    if (!providerKeyReady(preset, settings)) {
      // 不再硬报错——挂起 pendingKeyEntry，UI 弹该 provider 的单步 key 录入 overlay；
      // 录好后 resolveKeyEntry 存 key + 重试本函数（targetId/id 不变，此时 providerKeyReady 已为 true）。
      pendingKeyEntry = { providerId: preset.id, label: providerLabel(targetId), baseURL: preset.baseURL, model: preset.models.smart, modelId: id }
      setState()
      return
    }
    if (!opts.unmount) { notice('error', `切换到 ${providerLabel(targetId)} 需要重启，当前环境不支持。`); return }
    const g = guardSwitch({ bg: process.env.DEEPCODE_SESSION_KIND === 'bg', anyRunningWork: anyRunningWork() })
    if (!g.ok) { notice('warn', g.message); return }
    try {
      const raw = loadRawUserSettings()
      raw.provider = preset.id as ProviderId // availablePresets 保证 id ∈ deepseek|glm|kimi|custom
      raw.model = id
      saveRawUserSettings(raw)
    } catch (e: any) {
      notice('error', `保存设置失败：${e?.message ?? e}`)
      return
    }
    // 落到 session meta：--resume 回来后 restoreSession 用 meta.model，否则会被 resolveResumeModel 回落到新 provider 的 fast 档
    session.appendMeta({ cwd, model: id, providerId: targetId, thinking, effortLevel, permMode })
    const args = [
      ...buildResumeArgs({ sessionFile: session.file, hasTranscript: hasTranscript() }),
      ...buildCarryFlags({ yolo: opts.yolo, settingsPath: opts.flagSettingsPath }),
    ]
    // unmount 之后 ink 树已卸载，notice() 用户看不见 → 失败一律写 stderr 并非零退出，
    // 否则会留下「settings 已指向新 provider、内存 client 还是老的、UI 已死」的僵尸进程。
    try {
      opts.unmount()
      const child = spawnSyncProc(process.execPath, [process.argv[1], ...args], { stdio: 'inherit', env: process.env })
      if (child.error) {
        console.error(`[deepcode] 无法切换 provider——${child.error.message}。设置已保存，重启 deepcode 生效。`)
        exitProc(1)
        return
      }
      exitProc(child.status ?? 1) // status===null = 被信号杀死，不能谎报成功
    } catch (e: any) {
      console.error(`[deepcode] 无法切换 provider——${e?.message ?? e}。设置已保存，重启 deepcode 生效。`)
      exitProc(1)
    }
  }

  const applyModel = (id: string, providerId?: string): void => {
    const target = providerId ?? foreignProviderOf(activePreset, id, availablePresets(settings))
    if (target && target !== activePreset.id) { switchProvider(target, id); return }
    model = id
    const known = belongsToProvider(activeProvider(), id)
    const suffix = known ? '' : '（非当前 provider 档，计价/上下文按兜底估算）'
    session.appendMeta({ cwd, model, providerId: activeProvider().id, thinking, effortLevel, permMode })
    notice('info', `已切换到 ${model}${suffix}`)
    setState()
  }

  // Shift+Tab / /cycle-mode 共用：前进一档权限模式。不受 busy 门（跑动 turn 中亦可切，配合 deps.permission.mode 活读即时生效）。
  function cycleMode(): void {
    if (opts.yolo) return // yolo 仅 --yolo 启动，不参与循环
    const nextMode = nextPermMode(permMode, settings.disableAutoMode ?? false)
    if (nextMode === 'plan') prePlanMode = permMode
    permMode = nextMode
    session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
    // 模式切换绝不 push transcript 通知（无论 busy/idle）：Shift+Tab 可长按连发，每条 notice 增长 transcript，
    // 每帧 render 都 clone/map 整个数组 → O(N²) 分配 → 堆爆 OOM（真机冒烟两次证实，含空闲长按）。
    // 模式已在状态栏页脚 [model | mode] 实时显示；这里只 setState 刷新页脚。照 CC（切模式不刷屏）。
    setState()
    refreshStatusLine()
  }

  /** 斜杠命令本地处理（/resume 由 UI 走 resumeList/resume，/exit 归 UI） */
  const send = async (line: string, attachments?: Attachment[]): Promise<void> => {
    line = line.trim()
    if (!line || busy) return
    if (attachments?.some(a => a.type === 'doc')) {
      line = await resolveDocPlaceholders(line, attachments, {
        onStart: (id) => dispatch({ type: 'tool_start', id: `doc-${id}`, name: '解析文档', desc: `#${id} · glm-ocr` }),
        onEnd: (id, ok) => dispatch({ type: 'tool_end', id: `doc-${id}`, ok, preview: '', previewExtra: 0, ms: 0 }),
        onError: (msg) => notice('warn', msg),
      })
    }
    let pendingImages: { base64: string; mime: string }[] | undefined
    const hasImages = attachments?.some(a => a.type === 'image')
    if (hasImages && activeModelMeta(model).supportsVision) {
      // 原生视觉：保留 [Image #N] 占位（只展开文本占位），图片规范化后旁挂
      line = expandTextAttachments(line, attachments)
      const collected: { base64: string; mime: string }[] = []
      for (const a of attachments!) {
        if (a.type !== 'image') continue
        const img = a as ImageEntry
        dispatch({ type: 'push', item: { kind: 'tool', id: `img-${img.id}`, name: '附加图片', desc: `#${img.id} · 原生视觉`, running: false, ok: true } })
        try {
          collected.push(await normalizeForVision(img.base64, img.mime))
        } catch {
          notice('warn', `图片 #${img.id} 过大无法处理，已忽略`)
        }
      }
      pendingImages = collected.length ? collected : undefined
    } else {
      line = hasImages
        ? await resolveAttachments(line, attachments, {
            onStep: (id) => dispatch({ type: 'push', item: { kind: 'tool', id: `img-${id}`, name: '识别图片', desc: `#${id} · glm-4.6v`, running: false, ok: true } }),
            onError: (msg) => notice('warn', msg),
            onUsage: auxOnUsage,
          })
        : expandTextAttachments(line, attachments)
    }
    // ! 直跑：执行 shell 命令，结果作为 bang transcript 块，同时以 XML 格式入上下文（不触发模型回复）
    if (line.startsWith('!')) {
      const cmd = line.slice(1).trim()
      const { output, code } = runBang(cmd, cwd)
      dispatch({ type: 'push', item: { kind: 'bang', cmd, output } })
      // 进入消息上下文（模型下次提问时可引用）
      const bangMsg = {
        role: 'user' as const,
        content: `<bash-input>${cmd}</bash-input>\n<bash-output>\n${output}\n</bash-output>`,
      }
      messages.push(bangMsg)
      session.appendMessage(bangMsg)
      if (code !== 0) notice('warn', `命令退出码 ${code}`)
      return
    }
    if (line === '/help') {
      notice('info', HELP_TEXT)
      return
    }
    if (line === '/keybindings') {
      notice('info', formatKeybindings())
      return
    }
    if (line === '/pause-memory' || line === '/memory-pause' || line === '/toggle-memory') {
      memoryPaused = !memoryPaused
      rebuildSystemPrompt()
      notice('info', memoryPaused ? '记忆已暂停（本会话不读写不引用）' : '记忆已恢复')
      setState()
      return
    }
    if (line === '/model' || line.startsWith('/model ')) {
      const arg = line.slice('/model'.length).trim()
      if (arg) {
        applyModel(arg)
      } else {
        // /model 无参：TUI 经 App.submit 拦截走 picker；此处为 headless/兜底，保留 fast↔smart 轮换
        model = rotateModel(model, activeProvider())
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `已切换到 ${model}`)
      }
      refreshStatusLine() // 5.7 模型变化触发 statusLine 刷新
      return
    }
    if (line === '/setup') {
      // 向导需要交互式 ink render，TUI 里由 App/FullscreenApp 拦截打开 overlay；此处仅兜底不误发模型。
      notice('info', '/setup 需要交互式 TUI 界面，请在前台 TUI 会话中运行')
      return
    }
    if (line === '/think') {
      thinking = !thinking
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', `thinking 模式：${thinking ? '开' : '关'}`)
      return
    }
    if (line.startsWith('/effort')) {
      const arg = line.slice('/effort'.length).trim().toLowerCase()
      if (arg === 'off') {
        thinking = false
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', 'thinking 模式：关')
      } else if (arg === 'low' || arg === 'medium' || arg === 'high') {
        effortLevel = arg
        thinking = true
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `思考档位：${arg}（thinking 开）`)
      } else {
        notice('info', `当前思考档位：${thinking ? effortLevel : 'off'}。用法：/effort low|medium|high|off`)
      }
      setState()
      return
    }
    if (line === '/accept') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行'); return }
      permMode = permMode === 'acceptEdits' ? 'default' : 'acceptEdits'
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', `acceptEdits 模式：${permMode === 'acceptEdits' ? '开（Edit/Write 免确认，Bash 仍需确认）' : '关'}`)
      refreshStatusLine() // 5.7 权限模式变化触发 statusLine 刷新
      return
    }
    if (line === '/dontask') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行'); return }
      permMode = permMode === 'dontAsk' ? 'default' : 'dontAsk'
      session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
      notice('info', `dontAsk 模式：${permMode === 'dontAsk' ? '开（读放行，任何需确认的写操作自动拒绝，不弹窗）' : '关'}`)
      refreshStatusLine()
      return
    }
    if (line === '/cycle-mode') {
      cycleMode()
      return
    }
    if (line === '/plan') {
      if (opts.yolo) { notice('info', '当前是 yolo 模式，所有操作均已放行，无需 plan 模式'); return }
      if (permMode === 'plan') {
        // 退出 plan 模式：恢复进入前的模式
        permMode = prePlanMode
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', `plan 模式已关闭，已恢复 ${permMode} 模式`)
      } else {
        // 进入 plan 模式：记录当前模式供退出时恢复
        prePlanMode = permMode
        permMode = 'plan'
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        notice('info', 'plan 模式已开启：只读探索 + 写计划，完成后调用 ExitPlanMode 请用户审批（/plan 可退出）')
      }
      setState()
      refreshStatusLine() // 5.7 plan 模式变化触发 statusLine 刷新
      return
    }
    if (line.startsWith('/add-dir')) {
      const arg = line.slice('/add-dir'.length).trim()
      if (!arg) {
        notice('info', `当前附加目录：${additionalDirs.length ? additionalDirs.join(', ') : '（无）'}\n用法：/add-dir <路径>`)
        return
      }
      const resolved = path.resolve(cwd, arg)
      try {
        const stat = fs.statSync(resolved)
        if (!stat.isDirectory()) { notice('warn', `路径不是目录：${resolved}`); return }
      } catch {
        notice('warn', `路径不存在：${resolved}`)
        return
      }
      if (!additionalDirs.includes(resolved)) {
        additionalDirs = [...additionalDirs, resolved]
        notice('info', `已添加工作目录白名单：${resolved}`)
      } else {
        notice('info', `已在白名单中：${resolved}`)
      }
      return
    }
    if (line === '/cd' || line.startsWith('/cd ')) {
      const arg = line.slice('/cd'.length).trim()
      if (!arg) { notice('info', `当前工作目录：${cwd}\n用法：/cd <路径>`); return }
      const r = resolveCdTarget(cwd, arg)
      if (!r.ok) { notice('warn', r.error); return }
      cwd = r.path
      memdir = mem.enabled ? memdirFor(cwd, home) : undefined
      // 重建 extractor 使提取落到新目录（对齐 /clear·/fork·/resume；此前遗漏，导致提取误写旧目录 memdir）
      extractor = createMemoryExtractor({
        client: opts.client, memdir: memdirFor(cwd, home), globalMemdir, originKey: originKey(), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      reloadSkills()
      rebuildSystemPrompt()
      notice('info', `已迁移工作目录到 ${cwd}`)
      setState()
      return
    }
    if (line === '/cost') {
      const mainLog = usageLog.filter(u => !u.kind)
      const inTok = mainLog.reduce((s, u) => s + u.usage.prompt_tokens, 0)
      const hitTok = mainLog.reduce((s, u) => s + u.usage.prompt_cache_hit_tokens, 0)
      const outTok = mainLog.reduce((s, u) => s + u.usage.completion_tokens, 0)
      const totalCost = sessionCost()
      const costOf = (kind: 'memory' | 'aux') => usageLog.filter(u => u.kind === kind).reduce(
        (s, u) => s + costCNY(u.model, u.usage.prompt_tokens, u.usage.prompt_cache_hit_tokens, u.usage.completion_tokens), 0)
      const memCost = costOf('memory')
      const auxCost = costOf('aux')
      const parts = [
        memCost > 0 ? `记忆 fork ¥${memCost.toFixed(6)}` : '',
        auxCost > 0 ? `辅助(分类器/识图) ¥${auxCost.toFixed(6)}` : '',
      ].filter(Boolean)
      const memLine = parts.length ? `（其中 ${parts.join('，')}）` : ''
      notice('info', `本会话：输入 ${inTok}（缓存命中 ${hitTok}）出 ${outTok} | 估算花费 ¥${totalCost.toFixed(6)} ${memLine}`.trimEnd())
      return
    }
    if (line === '/recap') {
      busy = true; idleNotifier.cancel(); setState()
      try {
        const text = await generateRecap(opts.client, messages, model, abort.signal)
        if (text === null) notice('info', '还没有可回顾的内容 —— 先发条消息吧。')
        else if (text === '') notice('warn', '无法生成回顾。')
        else notice('info', text)
      } catch {
        if (abort.signal.aborted) notice('info', '已取消回顾。')
        else notice('warn', '无法生成回顾。')
      } finally {
        busy = false; idleNotifier.arm(); setState()
      }
      return
    }
    if (line === '/goal' || line.startsWith('/goal ')) {
      const arg = line.slice('/goal'.length).trim()
      if (!arg) {
        notice('info', activeGoal
          ? `目标进行中：${activeGoal.condition}（${activeGoal.iterations} 轮）\n上次检查：${activeGoal.lastReason ?? '尚未检查'}`
          : '未设目标。用法：/goal <条件>')
        return
      }
      if (GOAL_CLEAR_WORDS.has(arg.toLowerCase())) {
        activeGoal = null
        notice('info', '已清除目标。')
        return
      }
      const condition = arg.slice(0, MAX_GOAL_CONDITION_CHARS)
      activeGoal = { condition, iterations: 0, setAt: Date.now() }
      notice('info', `目标已设置：${condition}`)
      await runTurn(line, goalDirective(condition))
      return
    }
    if (line === '/compact') {
      busy = true
      idleNotifier.cancel()
      setState()
      precomputeReg.clear() // 避免与在途 precompute 竞争
      try {
        await doCompact('manual')
        consecutiveCompactFailures = 0
        recordCompact(compactState, checkRapidRefill(compactState).rapidRefills) // 手动也是一次 compact，3b 计数保持一致
      } catch (e: any) { notice('error', `[compact 失败] ${e?.message ?? e}`) }
      busy = false
      idleNotifier.arm()
      setState()
      return
    }
    if (line === '/clear') {
      void fireSessionEnd('clear') // 旧会话结束，先于新会话 SessionStart；进程不退出，drain 后台跑完即可，不 await
      messages.length = 1 // 保留 system
      ctx.fileState.clear()
      compacted = false
      lastPromptTokens = 0
      baselineLen = 0
      compactWarned = false
      consecutiveCompactFailures = 0
      precomputeReg.clear(); Object.assign(compactState, newCompactState()) // A1：新会话历史线与旧 precompute 快照不同源，作废
      pendingSessionContext = null
      // /clear 是「从头开始」：不带 parent（历史一条不留），新会话新日志。
      session = newSession({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id }, sessionDir, makeActivityWriter)
      session.appendMessage(messages[0])
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      taskList.bind(sessionIdFromFile(session.file))
      currentTitle = null
      nextTurnId = 1; currentTurnId = 0
      // 重建 extractor，重置游标（旧会话游标对新会话无效，防新会话首轮被静默跳过）
      extractor = createMemoryExtractor({
        client: opts.client, memdir: memdirFor(cwd, home), globalMemdir, originKey: originKey(), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      dispatch({ type: 'clear' })
      notice('info', '对话已清空，已开新会话文件（本会话花费累计保留）')
      fireSessionStart('clear')
      return
    }
    if (line === '/rename' || line.startsWith('/rename ')) {
      const name = line.slice('/rename'.length).trim()
      if (!name) { notice('info', `当前标题：${currentTitle ?? '（未命名）'}\n用法：/rename <名称>`); return }
      currentTitle = name
      session.appendTitle(name)
      notice('info', `会话已重命名为「${name}」`)
      return
    }
    if (line === '/fork') {
      const base = stripBranchSuffix(currentTitle ?? (() => {
        const fu = messages.find(m => m.role === 'user' && typeof m.content === 'string')
        return typeof fu?.content === 'string' ? fu.content.slice(0, 40) : '会话'
      })())
      const existingTitles = listSessions(cwd, sessionDir).map(s => s.preview)
      const forkTitle = nextBranchTitle(base, existingTitles)
      const forkMeta = { cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id, title: forkTitle }
      const parentId = sessionIdFromFile(session.file)
      const newS = newSession(forkMeta, sessionDir, f => makeActivityWriter(f, { parent: parentId }))
      // 全量重放老历史进新 handle：必须 suppress，否则这段活动被写进第二份日志重复摘要，污染 dream 语料。
      newS.suppressActivity(() => {
        for (const m of messages) newS.appendMessage(m, turnOf.get(m))
      })
      session = newS
      currentTitle = forkTitle
      precomputeReg.clear() // 新会话上下文不同，旧 precompute 快照作废
      checkpointer = createCheckpointer(checkpointStoreFor(session.file))
      taskList.bind(sessionIdFromFile(session.file))
      extractor = createMemoryExtractor({
        client: opts.client, memdir: memdirFor(cwd, home), globalMemdir, originKey: originKey(), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      notice('info', `已分叉到新会话「${forkTitle}」（原会话保持不变；对话与花费继续，任务清单与文件检查点不随分叉带过）`)
      fireSessionStart('startup')
      return
    }
    if (line === '/context') {
      notice('info', formatContext(messages, usageLog[usageLog.length - 1]?.usage))
      return
    }
    if (line === '/export' || line.startsWith('/export ')) {
      const arg = line.slice('/export'.length).trim()
      const base = sessionIdFromFile(session.file ?? '')
      const defaultName = base ? `deepcode-export-${base}.md` : 'deepcode-export.md'
      const dest = arg ? path.resolve(cwd, arg) : path.resolve(cwd, defaultName)
      const md = exportTranscript(messages, { model, cwd, exportedAt: new Date().toISOString() })
      try {
        fs.writeFileSync(dest, md)
        notice('info', `已导出到 ${dest}`)
      } catch (e: any) {
        notice('error', `[导出失败] ${e?.message ?? e}`)
      }
      return
    }
    if (line === '/copy' || line.startsWith('/copy ')) {
      const arg = line.slice('/copy'.length).trim()
      let t: string | null
      let label: string
      if (arg === 'code') {
        t = lastCodeBlock(lastAssistantText(messages))
        label = '最后一个代码块'
      } else if (/^\d+$/.test(arg)) {
        t = nthAssistantText(messages, parseInt(arg, 10))
        label = `倒数第 ${arg} 条回复`
      } else {
        t = lastAssistantText(messages)
        label = '上条回复'
      }
      if (!t) { notice('warn', '没有可复制的内容'); return }
      try {
        copyToClipboard(t)
        notice('info', `已复制${label}到剪贴板（${t.length} 字）`)
      } catch (e: any) {
        notice('error', `复制失败：${e?.message ?? e}`)
      }
      return
    }
    if (line === '/stats') {
      notice('info', formatStats(sessionStats(messages, usageLog), sessionCost(), cacheHitRate()))
      return
    }
    if (line.split(/\s+/)[0] === '/workflows') {
      const workflowDir = path.join(cwd, '.deepcode', 'workflows')
      try {
        const runIds = fs.readdirSync(workflowDir)
        if (runIds.length === 0) { notice('info', '（无 workflow 运行记录）'); return }
        const { formatWorkflowProgress } = await import('./WorkflowView.js')
        const lines: string[] = []
        for (const runId of runIds) {
          try {
            const raw = fs.readFileSync(path.join(workflowDir, runId, 'journal.jsonl'), 'utf8')
            const records = raw.split('\n').filter(Boolean).map(l => JSON.parse(l))
            const isDone = records.some((r: any) => r.type === 'workflow_complete')
            const s = formatWorkflowProgress(records, { id: runId, status: isDone ? 'completed' : 'running' })
            const phaseLine = s.phases.map(p => `  ${s.done ? '✓' : '⟳'} ${p.title} · ${p.agents} agents`).join('\n')
            const footer = s.done ? `Completed in ${(s.ms / 1000).toFixed(1)}s · ${s.agents} agents` : '（进行中）'
            lines.push([s.name || s.runId || runId, phaseLine, footer].filter(Boolean).join('\n'))
          } catch { /* skip */ }
        }
        notice('info', lines.length ? lines.join('\n\n') : '（无有效 workflow 记录）')
      } catch { notice('info', '（无 workflow 运行记录）') }
      return
    }
    if (line === '/memory' || line.startsWith('/memory ')) {
      const arg = line.slice('/memory'.length).trim()
      const heads = globalMemdir ? await scanMemoryFiles(globalMemdir, 'global') : []
      const entries = heads.map((h, i) => {
        let origin: string | undefined, created: string | undefined
        try {
          const { data } = parseFrontmatter(fs.readFileSync(h.filePath, 'utf8'))
          origin = typeof data.origin === 'string' ? data.origin : undefined
          created = typeof data.created === 'string' ? data.created : undefined
        } catch { /* 元数据缺失不影响展示 */ }
        return { index: i + 1, filename: h.filename, filePath: h.filePath, type: h.type, description: h.description ?? undefined, origin, created }
      })

      if (arg === 'promote' || arg.startsWith('promote ')) {
        const promoteArg = arg.slice('promote'.length).trim()
        if (!promoteArg) {
          const cs = await listPromotionCandidates(home)
          if (!cs.length) { notice('info', '没有可升格的存量记忆（只看 user/feedback 两类）。'); return }
          const lines = ['以下存量记忆可能该进全局抽屉（它们写于系统还不会分抽屉的年代，请逐条过目）：', '']
          for (const c of cs) lines.push(`  [${c.index}] [${c.type}] ${c.filename} — ${c.description ?? '(无描述)'}  （来自 ${c.projectKey}）`)
          lines.push('', '用 /memory promote <编号> <文件名> 升格某条（复制到全局，原文件保留；文件名以列表为准，防止列表变化后错升）。')
          notice('info', lines.join('\n'))
          return
        }
        const parts = promoteArg.split(/\s+/).filter(Boolean)
        const n = parts[0] !== undefined ? parseInt(parts[0], 10) : NaN
        const filenameArg = parts.slice(1).join(' ')
        if (!Number.isFinite(n) || !filenameArg) {
          notice('warn', '用法：/memory promote <编号> <文件名>（例如 /memory promote 1 pref.md；先跑 /memory promote 确认编号与文件名）')
          return
        }
        const cs = await listPromotionCandidates(home)
        const target = cs.find(c => c.index === n)
        if (!target) { notice('warn', `没有编号 ${n} 的候选。先跑 /memory promote 看清单。`); return }
        // 与 /memory rm 同理：候选列表跨所有项目扫描，位置随后台提取器落盘新记忆而改变。
        // 用文件名兜底校验，不匹配就中止——升格是复制到全局的单向门，绝不猜着升格。
        if (target.filename !== filenameArg) {
          notice('warn', `编号 [${n}] 对应的是 ${target.filename}，与你给的文件名 ${filenameArg} 不符——未升格任何内容。请重新跑 /memory promote 确认。`)
          return
        }
        notice('info', promoteCandidate(target, globalMemdirFor(home)))
        return
      }
      if (arg === 'rm' || arg.startsWith('rm ')) {
        const parts = arg.slice(2).trim().split(/\s+/).filter(Boolean)
        const n = parts[0] !== undefined ? parseInt(parts[0], 10) : NaN
        const filenameArg = parts.slice(1).join(' ')
        if (!Number.isFinite(n) || !filenameArg) {
          notice('warn', '用法：/memory rm <编号> <文件名>（例如 /memory rm 1 tw.md；先跑 /memory 确认编号与文件名）')
          return
        }
        const target = entries.find(e => e.index === n)
        if (!target) { notice('warn', `没有编号 ${n} 的全局记忆。先跑 /memory 看编号。`); return }
        // 编号绑定的是列表位置，位置易变（后台提取子代理可能在两次 /memory 之间落盘新记忆，
        // 重排了 mtime 顺序）。用文件名兜底校验：不匹配就中止，绝不猜着删。
        if (target.filename !== filenameArg) {
          notice('warn', `编号 [${n}] 对应的是 ${target.filename}，与你给的文件名 ${filenameArg} 不符——未删除任何内容。请重新跑 /memory 确认。`)
          return
        }
        try { fs.rmSync(target.filePath, { force: true }) }
        catch (e: any) { notice('warn', `删除失败：${e?.message ?? e}`); return }
        notice('info', `已删除全局记忆 ${target.filename}。（它不会再出现在任何项目里；下次开新会话生效）`)
        return
      }

      notice('info', formatMemoryView(findMemoryFiles(cwd, home), entries, home))
      return
    }
    if (line === '/diff') {
      if (runBang('git rev-parse --is-inside-work-tree', cwd).code !== 0) { notice('warn', '当前目录不是 git 仓库'); return }
      if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) { notice('info', '没有未提交的改动'); return }
      const status = runBang('git status --short', cwd).output
      // 无 commit 的新仓库没有 HEAD，`git diff HEAD` 会报 bad revision → 回退到工作区 diff（避免把报错当 diff 显示）
      const hasHead = runBang('git rev-parse --verify HEAD', cwd).code === 0
      const diff = runBang(hasHead ? 'git diff HEAD' : 'git diff', cwd).output
      notice('info', formatDiffView(status, diff))
      return
    }
    if (line === '/skills') {
      notice('info', formatSkillsList(skills))
      return
    }
    if (line === '/hooks') {
      const { loadLayeredSettings } = await import('../settingsLayers.js')
      notice('info', formatHooksConfig(loadLayeredSettings(cwd, opts.flagSettingsPath).hookLayers))
      return
    }
    if (line === '/mcp') {
      notice('info', formatMcpStatus(
        mcpRegistry.list().map(s => ({ name: s.name, status: s.status, error: s.error })),
        tools.map(t => t.name),
      ))
      return
    }
    if (line === '/doctor') {
      const prov = activeProvider()
      const hasKey = !!(process.env[prov.apiKeyEnv] || settings.apiKey)
      const git = runBang('git --version', cwd)
      let cwdWritable = true
      try { fs.accessSync(cwd, fs.constants.W_OK) } catch { cwdWritable = false }
      notice('info', formatDoctor([
        { name: `API key（${prov.apiKeyEnv}）`, ok: hasKey, detail: hasKey ? '已配置' : `未配置——设环境变量 ${prov.apiKeyEnv} 或 settings.apiKey` },
        { name: 'provider', ok: true, detail: `${prov.id} · ${model}` },
        { name: 'git', ok: git.code === 0, detail: git.output.trim() || '未找到 git' },
        { name: 'Node', ok: true, detail: process.version },
        { name: '工作目录可写', ok: cwdWritable, detail: cwd },
        { name: 'settings 解析', ok: true, detail: '正常' },
      ]))
      return
    }
    if (line === '/status') {
      const br = runBang('git rev-parse --abbrev-ref HEAD', cwd)
      notice('info', formatStatus({
        version: VERSION, model, mode: permMode, cwd,
        branch: br.code === 0 && br.output.trim() ? br.output.trim() : undefined,
        memoryCount: findMemoryFiles(cwd).length,
        skillsCount: skills.length,
        mcpServerCount: Object.keys(settings.mcpServers ?? {}).length,
        toolCount: tools.length,
      }))
      return
    }
    if (line === '/reload-skills') {
      reloadSkills()
      rebuildSystemPrompt()
      notice('info', `已重载技能：${skills.length} 个`)
      setState()
      return
    }
    if (line === '/config') {
      const { loadLayeredSettings } = await import('../settingsLayers.js')
      const { formatConfigReport } = await import('../configReport.js')
      notice('info', formatConfigReport(loadLayeredSettings(cwd, opts.flagSettingsPath)))
      return
    }
    if (line === '/permissions' || line.startsWith('/permissions ')) {
      const arg = line.slice('/permissions'.length).trim()
      const allowList = settings.permissions.allow
      const denyList = resolveDenyList(settings.permissions.deny)
      const askList = settings.permissions.ask ?? []
      const rmMatch = arg.match(/^rm\s+(\d+)$/)
      const denyRmMatch = arg.match(/^deny-rm\s+(\d+)$/)
      const askRmMatch = arg.match(/^ask-rm\s+(\d+)$/)
      if (rmMatch) {
        const r = resolveRuleRemoval(allowList, Number(rmMatch[1]), ruleSources, 'user')
        if (r.ok) {
          removeUserAllowRuleByValue(r.value)
          const mem = settings.permissions.allow.indexOf(r.value)
          if (mem >= 0) settings.permissions.allow.splice(mem, 1)
          notice('info', `已删除：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else if (denyRmMatch) {
        const r = resolveRuleRemoval(denyList, Number(denyRmMatch[1]), denySources, 'builtin')
        if (r.ok) {
          removeUserDenyRuleByValue(r.value)
          if (settings.permissions.deny) {
            const mem = settings.permissions.deny.indexOf(r.value)
            if (mem >= 0) settings.permissions.deny.splice(mem, 1)
          }
          notice('info', `已删除 Deny：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else if (askRmMatch) {
        const r = resolveRuleRemoval(askList, Number(askRmMatch[1]), askSources, 'user')
        if (r.ok) {
          removeUserAskRuleByValue(r.value)
          if (settings.permissions.ask) {
            const mem = settings.permissions.ask.indexOf(r.value)
            if (mem >= 0) settings.permissions.ask.splice(mem, 1)
          }
          notice('info', `已删除 ask 规则：${r.value}`)
          fireConfigChange()
        } else notice('warn', r.reason)
      } else {
        notice('info', formatPermissionRules(allowList, ruleSources, denyList, denySources, askList, askSources))
      }
      return
    }

    if (line === '/commit') {
      if (runBang('git rev-parse --is-inside-work-tree', cwd).code !== 0) {
        notice('warn', '当前目录不是 git 仓库')
        return
      }
      if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
        notice('info', '没有可提交的改动')
        return
      }
      const status = runBang('git status', cwd).output
      const diff = runBang('git diff HEAD', cwd).output
      const branch = runBang('git branch --show-current', cwd).output
      const log = runBang('git log --oneline -10', cwd).output
      const ctxMsg = { role: 'user' as const, content: buildCommitContext({ status, diff, branch, log }) }
      messages.push(ctxMsg)
      session.appendMessage(ctxMsg)
      await runTurn(line, buildCommitGuidance(resolveAttribution(settings)))
      return
    }

    if (line === '/commit-push-pr') {
      if (runBang('git rev-parse --is-inside-work-tree', cwd).code !== 0) {
        notice('warn', '当前目录不是 git 仓库')
        return
      }
      if (isEmptyDiff(runBang('git status --porcelain', cwd).output)) {
        notice('info', '没有可提交的改动')
        return
      }
      const status = runBang('git status', cwd).output
      const diff = runBang('git diff HEAD', cwd).output
      const branch = runBang('git branch --show-current', cwd).output
      const base = resolveBaseBranch(cwd)
      const baseDiff = runBang(`git diff ${base}...HEAD`, cwd).output
      const existingPr = runBang('gh pr view --json number 2>/dev/null || true', cwd).output
      const ctxMsg = { role: 'user' as const, content: buildPrContext({ status, diff, branch, baseDiff, existingPr }) }
      messages.push(ctxMsg)
      session.appendMessage(ctxMsg)
      await runTurn(line, buildCommitPushPrGuidance(resolveAttribution(settings)))
      return
    }

    if (line === '/loop' || line.startsWith('/loop ')) {
      const p = parseLoopCommand(line)
      if (p.mode === 'fixed') {
        scheduler.addCron({ id: genId('c'), kind: 'cron', cron: p.cron, prompt: p.prompt, recurring: true, durable: false, createdAt: Date.now(), nextFireAt: 0 })
        notice('info', `已建循环：每 ${line.split(' ')[1]} 跑一次。立即跑首轮。`)
        await runTurn('（/loop 首轮）', p.prompt, undefined, p.prompt)
      } else if (p.mode === 'dynamic') {
        scheduler.resetLoopPreamble('dynamic')
        await runTurn('（/loop 自起步）', LOOP_GUIDANCE.dynamic(p.prompt))
      } else {
        scheduler.resetLoopPreamble('dynamic')
        await runTurn('（/loop 自主）', LOOP_GUIDANCE.autonomous())
      }
      return
    }

    if (line === '/stop' || line.startsWith('/stop ')) {
      const id = line.slice('/stop'.length).trim()
      if (!id) {
        const running = reconcileJobs(Date.now()).filter(j => j.state === 'working')
        notice('info', running.length ? `运行中的后台会话：\n${formatJobList(running, Date.now())}\n用 /stop <id> 停止` : '（无运行中的后台会话）')
        return
      }
      const job = readJobState(id)
      if (!job) { notice('warn', `找不到后台会话 ${id}`); return }
      if (job.state !== 'working') { notice('info', `${id} 已是 ${job.state}`); return }
      if (!job.pid || !isPidAlive(job.pid)) {
        updateJobState(id, { state: 'failed', updatedAt: Date.now() })
        notice('info', `后台会话 ${id} 的进程已不在，已标记为 failed`)
        return
      }
      try { killProc(job.pid, 'SIGTERM') } catch (e: any) { notice('warn', `杀进程失败：${e?.message ?? e}`) }
      updateJobState(id, { state: 'stopped', updatedAt: Date.now() })
      notice('info', `已停止后台会话 ${id}（transcript 保留，可 /resume 回看）`)
      return
    }

    // 斜杠命令：/init、skill 命令、自定义命令；未知则报错
    let userText = line
    // UserPromptExpansion 元信息：name/rest 只在下方 else-if 块内有作用域，故用 expMeta 携带出去供 dispatch 用
    let expMeta: { expansion_type: 'skill' | 'command'; command_name: string; command_args: string; command_source: 'user' | 'project' | 'skill' } | null = null
    if (line === '/init') {
      userText = INIT_PROMPT
    } else if (line.startsWith('/')) {
      const [name, ...rest] = line.slice(1).split(' ')
      const skill = skills.find(s => s.name === name && s.userInvocable)
      if (skill) {
        // skill 命中：填充参数后作为 user 指令发送（forked/inline 统一走 user 路径，无 tool_call 上下文）
        // forked 用户技能简化：斜杠路径无法注入 tool_call 上下文，inline 化（注偏离：forked 不隔离子 agent）
        if (skill.context === 'fork') {
          notice('info', `技能 /${name} 为 fork 类型，斜杠调用按 inline 处理（不隔离子代理）`)
        }
        const args = rest.join(' ')
        const filled = substituteSkillArgs(skill.body, args, {
          argNames: skill.argNames, skillDir: skill.skillDir, sessionId: ctx.sessionId?.(),
        })
        userText = filled
        expMeta = { expansion_type: 'skill', command_name: name, command_args: args, command_source: 'skill' }
      } else {
        const entry = customCommands.get(name)
        if (!entry) { notice('warn', `未知命令 /${name}，/help 查看可用命令`); return }
        userText = expandCommand(entry.template, rest.join(' '))
        expMeta = { expansion_type: 'command', command_name: name, command_args: rest.join(' '), command_source: entry.source }
      }
    } else {
      // 非斜杠输入：展开 @文件引用再发送
      const { text: expanded, misses } = expandAtRefs(line, cwd)
      userText = expanded
      // 仅对路径形态的 miss（含 / 或 .）推送提示，邮箱/域名静默跳过
      for (const p of misses) {
        if (p.includes('/') || p.includes('.')) {
          notice('info', `（@路径未找到，按原文发送：@${p}）`)
        }
      }
    }
    // UserPromptExpansion hook：斜杠命令展开成 prompt 时。additionalContext 并入展开后文本。
    if (expMeta && settings.hooks) {
      const upe = await runHooks('UserPromptExpansion', {
        hook_event_name: 'UserPromptExpansion',
        cwd,
        expansion_type: expMeta.expansion_type,
        command_name: expMeta.command_name,
        command_args: expMeta.command_args,
        command_source: expMeta.command_source,
        original: line,
      }, settings.hooks, hookDeps)
      if (upe.additionalContext) userText = `${userText}\n\n<hook-context>\n${upe.additionalContext}\n</hook-context>`
    }
    // 唯一记「展开后 userText」的调用点：非斜杠输入才是用户真说的话（@引用/粘贴折叠展开后的长简报正是
    // 最有价值的语料）。/init 与技能/自定义命令走的是同一个 send，但 userText 已被换成指令正文 → 只记命令名。
    await runTurn(line, userText, pendingImages, line.startsWith('/') ? line : userText)
  }

  // 7.3 /background：门控（非空会话）+ fork 到新会话文件 + 写初始 working state + spawn detached 子进程。
  // 不 process.exit——退出由 App/FullscreenApp 层做（保持可测）。
  const backgroundSession = async (seed?: string): Promise<{ ok: boolean; message: string; spawned?: boolean }> => {
    // 快照一次：mid-busy 触发时并发的 turn-end append 可能在 fork 拷贝途中修改 messages，
    // 快照后 hasContent 判断与拷贝循环都读同一份，避免撕裂。
    const snapshot = [...messages]
    const hasContent = snapshot.some(m => m.role === 'user' || m.role === 'assistant')
    if (!hasContent) {
      const message = '还没内容可后台化——先发一条消息。'
      notice('warn', message)
      return { ok: false, message }
    }

    // fork 当前会话到新文件（同 /fork 逻辑：拷消息，标题加 (Branch)），不切换当前活跃 session
    const base = stripBranchSuffix(currentTitle ?? (() => {
      const fu = snapshot.find(m => m.role === 'user' && typeof m.content === 'string')
      return typeof fu?.content === 'string' ? fu.content.slice(0, 40) : '会话'
    })())
    const existingTitles = listSessions(cwd, sessionDir).map(s => s.preview)
    const forkTitle = nextBranchTitle(base, existingTitles)
    const forkMeta = { cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id, title: forkTitle }
    const parentId = sessionIdFromFile(session.file)
    const forkS = newSession(forkMeta, sessionDir, f => makeActivityWriter(f, { parent: parentId }))
    // 同 /fork：快照全量重放必须 suppress（后台子进程随后 openSession 同一文件，续写它自己的活动）。
    forkS.suppressActivity(() => {
      for (const m of snapshot) forkS.appendMessage(m, turnOf.get(m))
    })
    const forkedId = sessionIdFromFile(forkS.file)
    const short = shortId(forkedId)

    // 写初始 working state（pid 待回填）
    const now = Date.now()
    writeJobState({
      sessionId: forkedId, short, state: 'working', cwd, name: seed?.slice(0, 40) || forkTitle,
      initialPrompt: seed, pid: 0, model, permMode, sessionFile: forkS.file, backend: 'detached',
      createdAt: now, updatedAt: now,
    })

    // spawn detached 子进程（buildBackgroundArgv 首元素是 entry，spawn 第二参用 slice(1)）
    const argv = buildBackgroundArgv({ entry: process.argv[1], resumeFile: forkS.file, short, seed, permMode, model })
    const child = spawnBg(process.execPath, argv.slice(1), { detached: true, stdio: 'ignore' })
    child.unref()
    if (child.pid) updateJobState(short, { pid: child.pid })

    return { ok: true, spawned: true, message: `已送到后台（${short}）。终端已释放。用 /resume 回看，/stop ${short} 停止。` }
  }

  // 收口闭包：读当前 cwd/skills/memdir/outputStyleName/focusMode/memoryPaused 重建系统提示并替换 messages[0]
  const rebuildSystemPrompt = (): void => {
    const content = buildSystemPrompt(cwd, undefined, skills, settings.skills?.listingBudgetChars, memdir, resolveOutputStyle(outputStyleName, outputStyleCache), focusMode, memoryPaused, settings.language, globalMemdir, mem.global.maxBytes)
    if (messages[0]?.role === 'system') messages[0] = { role: 'system', content }
    else messages.unshift({ role: 'system', content })
  }

  // 重扫本地 skill 清单（仅重赋值，不重建系统提示/不通知；供 /reload-skills 与 /cd 复用）
  const reloadSkills = (): void => { skills = loadSkills(cwd, undefined, settings.skills, settings.skillOverrides) }

  const applyOutputStyle = (name: string): void => {
    outputStyleName = name
    rebuildSystemPrompt()
    try { const raw = loadRawUserSettings(); raw.outputStyle = name; saveRawUserSettings(raw) } catch { /* 持久化失败不阻断热切 */ }
    notice('info', `输出风格：${name}`)
    setState()
  }

  const outputStyleList = (): { name: string; description: string }[] => [
    { name: 'default', description: '默认（不额外注入风格）' },
    ...outputStyleCache.map(s => ({ name: s.name, description: s.description })),
  ]

  // 5.7 会话建立后跑一次 statusLine（recovered 与新建两条路径都到这里）
  refreshStatusLine()

  // Task6：/tui 切换重启后的首帧横幅（子进程 env DEEPCODE_TUI_JUST_SWITCHED）
  if (opts.justSwitched === 'fullscreen') {
    notice('info', '使用全屏渲染 · 点击移动光标 · 点击展开折叠的工具结果 · 想切回请用 /tui inline')
  } else if (opts.justSwitched === 'inline') {
    notice('info', '已切回内联渲染。想再全屏请用 /tui fullscreen')
  }

  return {
    get state() { return state },
    send,
    cycleMode,
    interrupt: () => {
      // 若权限弹窗挂起（pendingAsk），checkPermission 内的 ask Promise 永不 resolve，
      // generator 永不返回，busy 永远 true——必须先拒绝掉再 abort，否则死锁。
      if (pendingAsk) { const p = pendingAsk; pendingAsk = null; setState(); p.resolve('no') }
      if (pendingQuestion) { const p = pendingQuestion; pendingQuestion = null; setState(); p.resolve(null) }
      if (pendingPlanApproval) { const p = pendingPlanApproval; pendingPlanApproval = null; setState(); p.resolve(false) }
      compactAbort?.abort('user-cancel') // 压缩进行中：ESC 也能中断（否则卡在 doCompact 的 ac，永远逃不出）
      abort.abort('user-cancel')
    },
    steer: (text: string, attachments?: Attachment[]) => {
      if (!text.trim()) return
      const resolved = expandTextAttachments(text, attachments)  // 入队前展开（队列存完整文本；图片在 steer 路径不做识别）
      steerQueue.enqueue(resolved, 'next') // 用户路径恒 next（toolInFlight 时自动软中断）
      if (toolsRunning > 0) abort.abort('interrupt') // 有 tool 在跑：软中断当前 turn，loop 据 reason 续跑
    },
    steerPop: () => steerQueue.popLast()?.value,
    steerQueue: () => steerQueue.peek(),
    resolveAsk: (d: Decision) => {
      if (!pendingAsk) return
      const p = pendingAsk
      pendingAsk = null
      setState()
      p.resolve(d)
    },
    resolveQuestion: (answers: Answer[] | null) => {
      if (!pendingQuestion) return
      const p = pendingQuestion
      pendingQuestion = null
      setState()
      p.resolve(answers)
    },
    resolvePlanApproval: (approved: boolean) => {
      if (!pendingPlanApproval) return
      const p = pendingPlanApproval
      pendingPlanApproval = null
      if (approved) {
        // 退出 plan 模式，恢复进入前的模式
        permMode = prePlanMode
        session.appendMeta({ cwd, model, thinking, effortLevel, permMode, providerId: activeProvider().id })
        // allowedPrompts → Bash 规则（仿 saveRule 机制，前缀形式 Bash(<prompt>:*)）
        for (const ap of (p.allowedPrompts ?? [])) {
          const rule = `Bash(${ap.prompt}:*)`
          addUserAllowRule(rule)
          if (!settings.permissions.allow.includes(rule)) settings.permissions.allow.push(rule)
          ruleSources[rule] = 'user'
        }
        if ((p.allowedPrompts ?? []).length > 0) fireConfigChange()
        notice('info', `计划已批准，已退出 plan 模式（恢复 ${permMode} 模式）`)
      }
      setState()
      p.resolve(approved)
    },
    resolveKeyEntry: (key: string | undefined) => {
      if (!pendingKeyEntry) return
      const target = pendingKeyEntry
      pendingKeyEntry = null
      if (!key) { setState(); return } // 取消：只清挂起，不切换
      try {
        saveOnboardingKeys({ providerKeys: { [target.providerId]: key } }) // 只存 key，不碰 provider/model——那是 switchProvider 的职责
      } catch (e: any) {
        notice('error', `保存 key 失败：${e?.message ?? e}`)
        return
      }
      // Task 7：当前 provider 就地鉴权恢复（运行中 401/invalid_api_key 触发），provider 未变——不走 switchProvider 的
      // 重启式切换，直接热改已建好的 client.apiKey（OpenAI SDK 每次请求读取该字段），下次发送即用新 key，无需重启。
      if (target.providerId === activePreset.id) {
        opts.client.apiKey = key
        notice('info', `${target.label} 的 API key 已更新，可重新发送`)
        setState()
        return
      }
      try {
        const fresh = loadSettings(cwd, opts.flagSettingsPath)
        if (fresh.providers) settings.providers = fresh.providers // 内存 settings 即时见新 key，下面重试才能通过 providerKeyReady
      } catch { /* 读取失败沿用旧值，尽力而为 */ }
      switchProvider(target.providerId, target.modelId)
    },
    resumeList: () => {
      // 后台会话按文件建标签索引；fork 出的会话文件通常也在 listSessions 里，
      // 故对同一文件优先显示 [bg <state>] 标签（覆盖普通预览），不再被去重吞掉。
      const bgByFile = new Map(reconcileJobs(Date.now()).filter(j => j.cwd === cwd).map(j => [j.sessionFile, `[bg ${j.state}] ${j.name}`] as const))
      const sessions = listSessions(cwd, sessionDir).slice(0, 10).map(s => ({ file: s.file, preview: bgByFile.get(s.file) ?? s.preview }))
      const seen = new Set(sessions.map(s => s.file))
      const extraBg = [...bgByFile].filter(([f]) => !seen.has(f)).map(([file, preview]) => ({ file, preview }))
      return [...extraBg, ...sessions].slice(0, 15)
    },
    resume: (file: string) => {
      if (busy) return
      const turns = restoreSession(file)
      // 换会话时重建 extractor，重置游标（上一会话的游标对新会话无效）
      extractor = createMemoryExtractor({
        client: opts.client, memdir: memdirFor(cwd, home), globalMemdir, originKey: originKey(), config: mem, ctx,
        runSubagent: opts.runSubagent, onUsage: memoryOnUsage,
      })
      smState = { promptTokens: 0, tokensAtLastUpdate: 0, initialized: false, toolCallsSinceUpdate: 0, lastTurnHadToolCalls: false }
      dispatch({ type: 'clear' }) // 换了会话，旧 transcript 不再对应当前 messages
      notice('info', `已恢复会话（${turns} 轮对话）`)
      fireSessionStart('resume')
    },
    customCommands,
    get skills() { return skills },
    skillOverrides: () => settings.skillOverrides ?? {},
    saveSkillOverrides: (o: Record<string, import('../config.js').SkillOverrideState>) => {
      const before = JSON.stringify(settings.skillOverrides ?? {})
      const next = Object.keys(o).length ? o : undefined
      const changed = before !== JSON.stringify(next ?? {})
      try { const raw = loadRawUserSettings(); if (next) raw.skillOverrides = next; else delete raw.skillOverrides; saveRawUserSettings(raw) }
      catch { /* 持久化失败不阻断内存热切 */ }
      settings.skillOverrides = next          // 更新内存快照供 reloadSkills 读取
      reloadSkills()                          // 重新按新 overrides 加载技能
      rebuildSystemPrompt()                   // 技能清单变化 → 重建系统提示
      setState()
      notice('info', changed ? `已更新技能覆盖（${Object.keys(next ?? {}).length} 个非默认）` : '技能覆盖无变化')
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    rewindList: () => {
      const out: { turnId: number; preview: string; fileCount: number }[] = []
      for (const m of messages) {
        if (m.role !== 'user') continue
        const t = turnOf.get(m)
        if (t === undefined) continue
        const raw = typeof m.content === 'string' ? m.content.split('\n\n<system-reminder>')[0].replace(/\n/g, ' ') : ''
        out.push({ turnId: t, preview: raw.slice(0, 60), fileCount: checkpointer.fileCountAt(t) })
      }
      return out.reverse()
    },
    rewind: (toTurnId, mode) => {
      if (busy) return
      // 先做对话截断（会 slice transcript），再发各通知——否则 both 模式下代码还原通知会被一并切掉
      if (mode === 'conversation' || mode === 'both') {
        const mi = messages.findIndex(m => turnOf.get(m) === toTurnId)
        if (mi >= 0) {
          messages.length = mi
          const liveTurnIds = messages.filter(m => m.role === 'user' && turnOf.has(m)).map(m => turnOf.get(m)!)
          const pos = liveTurnIds.length
          let seen = 0, cut = transcript.length
          for (let i = 0; i < transcript.length; i++) {
            if (transcript[i].kind === 'user') { if (seen === pos) { cut = i; break } seen++ }
          }
          transcript = transcript.slice(0, cut)
          session.appendRewind(toTurnId)
          precomputeReg.clear(); Object.assign(compactState, newCompactState()) // A1：rewind 改写历史线，precompute 快照与新历史不同源必须弃用
          setState()
          notice('info', `[rewind] 对话已回退到第 ${toTurnId} 轮之前`)
        } else {
          // turnId 不在当前内存（多半已被 compact 压走）——不谎报成功
          notice('warn', `[rewind] 第 ${toTurnId} 轮已不在当前上下文（可能已被 compact），无法回退对话`)
        }
      }
      if (mode === 'code' || mode === 'both') {
        const r = checkpointer.restoreFiles(toTurnId)
        for (const p of [...r.restored, ...r.deleted]) ctx.fileState.delete(p)
        const parts = [`还原 ${r.restored.length} 文件`, r.deleted.length ? `删除 ${r.deleted.length} 新建` : '', r.failed.length ? `失败 ${r.failed.length}` : ''].filter(Boolean)
        notice('info', `[rewind] 代码：${parts.join('、')}`)
      }
    },
    getCwd: () => cwd,
    dispose: () => { void fireSessionEnd('exit'); unsubNotification(); unsubSteer(); steerQueue.clear(); statusLineRunner?.dispose(); scheduler.stop(); setScheduler(null); idleNotifier.cancel(); void mcpCleanup() },
    flushMemory,
    modelList: () => allModelList(settings, model),
    applyModel,
    outputStyleList,
    applyOutputStyle,
    backgroundSession,
    askConfirm,
    notice,
    unmount: () => opts.unmount?.(),
    focusMode: () => focusMode,
    toggleFocus: () => { focusMode = !focusMode; setState(); return focusMode },
    focusLocked: () => focusLocked,
    memoryPaused: () => memoryPaused,
    sessionFile: () => session?.file,
    hasTranscript,
    anyRunningWork,
    providerName: () => providerLabel(activePreset.id),
    existingKeysSummary: () => {
      const out: Partial<OnboardingKeys> = { provider: activePreset.id as ProviderId }
      const custom = settings.providers?.custom
      if (activePreset.id === 'custom' && custom?.baseURL && custom.models) {
        out.custom = { baseURL: custom.baseURL, models: custom.models }
      }
      return out
    },
    reloadSettings: () => {
      try {
        const fresh = loadSettings(cwd, opts.flagSettingsPath)
        Object.assign(webSearchConfig, resolveWebSearchConfig(fresh))
        if (fresh.providers) settings.providers = fresh.providers
      } catch { /* 读取失败保留旧值，不阻断 */ }
    },
    yolo: () => opts.yolo,
    permMode: () => permMode,
    model: () => model,
    addDirs: () => additionalDirs,
  }
}

export function useChat(core: ChatCore): ChatState {
  return useSyncExternalStore(core.subscribe, () => core.state)
}
