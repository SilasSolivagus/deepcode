// src/compactionManager.ts
// 主动压缩的「会话级共享单元」：把 TUI(useChat) 里长在 runTurn 末尾的那套压缩决策与状态搬出来，
// 供 TUI 与 headless 两侧共用。为什么要抽：headless 全程没有主动压缩，长跑上下文无界累积；
// 而这套决策（C1 前缀守卫 / A2 mc 互斥 / 3a 失败熔断 / 3b 快速回填熔断 / precompute 预热）
// 依赖一组必须原子演进的会话状态，复制一份到 headless 迟早分叉。
//
// 边界：状态（lastPromptTokens/baselineLen/compactState/连续失败计数/precompute 注册表）由本模块持有；
// 环境差异（告警展示、用量记账、会话落盘、会话记忆、hooks）靠 deps 注入。
// 特别地：messages 的原地替换与 lastPromptTokens/baselineLen 归零【必须】留在这里——
// 它们是压缩语义的一部分，放进注入回调就等于让两侧各写一份。
import type OpenAI from 'openai'
import type { Usage } from './api.js'
import type { Settings } from './config.js'
import {
  summarize, rebuildMessages, rebuildFromPrecompute,
  microcompact, checkRapidRefill, recordCompact, bumpTurnCounter, newCompactState,
} from './compact.js'
import { PrecomputeRegistry, PRECOMPUTE_BUFFER_FRACTION } from './precompute.js'
import { estimateMessagesTokens, effectiveThreshold } from './tokenEstimate.js'

/** 压缩（summarize LLM 调用）超时上限：到点自动 abort，防 provider 卡住流时压缩无限挂起。 */
export const COMPACT_TIMEOUT_MS = 120_000
const MAX_AUTO_COMPACT_FAILURES = 3
const COMPACT_KEEP = 8 // rebuildMessages 默认保留条数，C1 prefix-overflow 守卫用

/** messagesBefore/After 只服务 PostCompact hook 的载荷（原实现里 hook 要报压缩前后的消息条数），
 *  条数只有 manager 自己知道，故随 meta 一起交给注入方，避免注入方去猜。 */
export type CompactMeta = {
  trigger: 'auto' | 'manual'
  summary: string
  truncated: boolean
  messagesBefore: number
  messagesAfter: number
}

export interface CompactionDeps {
  client: OpenAI
  model: string
  settings: Settings
  abortSignal: AbortSignal
  notice(level: 'info' | 'warn' | 'error', msg: string): void
  onUsage(usage: Usage, model: string): void
  persistCompact(messages: any[], meta: CompactMeta): Promise<void>
  sessionMemoryContent(): string | undefined
  runPreCompactHook(trigger: 'auto' | 'manual', messagesCount: number): Promise<void>
  runPostCompactHook(meta: CompactMeta): Promise<void>
  activeFastModel(): string
}

export interface CompactionManager {
  /** 上次真实 prompt_tokens（状态栏上下文占比的分子）。只读暴露的理由：它同时是压缩触发依据，
   *  且在 compact/microcompact/reset 三处被归零——注入方另存一份必然在这三处漂移。 */
  readonly contextTokens: number
  observeTurnEnd(promptTokens: number, messagesLen: number): void
  maybeCompact(messages: any[]): Promise<void>   // 原地改 messages
  armPrecompute(messages: any[]): void
  /** 供 /compact 手动路径复用；本计划不改 TUI 的手动入口，但 manager 提供它以免将来两处分叉。
   *  trigger='manual' 时连带做手动路径的三件事：清 precompute（避免与在途预算竞争）、
   *  成功后归零连续失败计数、recordCompact 保持 3b 计数一致。'auto' 不做——自动路径的
   *  计数更新在 maybeCompact 内另有时机（用的是本轮算出的 rr），两条路径不能合并。 */
  compactNow(messages: any[], trigger: 'auto' | 'manual'): Promise<void>
  /** ESC/中断：abort 在途压缩（空闲时是 no-op）。没有它，压缩期间的中断只能等 120s 超时。 */
  abortInFlight(): void
  /** 只作废 precompute 快照，不动 token 基线与两个熔断计数。
   *  /fork 用：它把 messages 逐条拷进新会话、历史完整保留，压缩状态仍然适用，
   *  只有 precompute 快照因会话文件换了而必须弃用。与 reset() 的区别正在于此——
   *  用 reset() 会把一个正在 thrash 的会话 fork 之后的快速回填保护清零重来。 */
  clearPrecompute(): void
  /** 作废 precompute 快照并重置 3b 快速回填计数，但保留 token 基线与 3a 失败计数。
   *  /rewind 用：它改写历史线故 precompute 快照与 3b 计数必须弃用，
   *  但 token 基线由 maybeCompact 里的 Math.min clamp 负责兜（rewind 后 baselineLen 可能大于 messages.length），
   *  归零反而抹掉这个设计意图；3a 失败计数是 provider 侧的健康信号，与历史线无关，跨 rewind 应保留。 */
  clearForRewind(): void
  /** /resume、/clear 后全清（TUI 现有语义：token 对 + 两个熔断计数 + precompute 快照）。 */
  reset(): void
}

export function createCompactionManager(deps: CompactionDeps): CompactionManager {
  let lastPromptTokens = 0    // 自动 compact 触发依据
  let baselineLen = 0         // 与 lastPromptTokens 原子配对：lastPromptTokens 覆盖的 messages 前缀长度（发送前预估只估超出此前缀的新消息）
  let consecutiveCompactFailures = 0
  const precomputeReg = new PrecomputeRegistry() // ② 后台预算摘要注册表（内存版）
  const compactState = newCompactState()         // 3b 快速回填熔断状态（turnCounter/rapidRefills）
  // maybeCompact 末尾的估算值，供紧随其后的 armPrecompute 读——C3 同轮重估的唯一读者就是 arm 门，
  // 两者必须共用同一个数，重算会把 3b 注入的 thrashing reminder 一并算进去（与原实现不同源）。
  let lastEstimated = 0
  let compactAbort: AbortController | null = null // 进行中压缩的中止句柄（超时 + interrupt/ESC 用；空闲为 null）

  const threshold = (): number => effectiveThreshold(deps.model, deps.settings.compactTokens)

  /** compact 结果落地：替换 messages + 落盘 compact 记录与新前缀 + 状态重置 + PostCompact hook。
   *  全量 compactNow 与 precompute swap 共用，避免两处漂移。 */
  const applyCompactResult = async (
    messages: any[],
    rebuilt: any[],
    meta: { trigger: 'auto' | 'manual'; summary: string; truncated: boolean },
  ): Promise<void> => {
    const before = messages.length
    messages.length = 0
    messages.push(...rebuilt)
    const full: CompactMeta = { ...meta, messagesBefore: before, messagesAfter: messages.length }
    await deps.persistCompact(messages, full)
    lastPromptTokens = 0
    baselineLen = 0
    await deps.runPostCompactHook(full)
    deps.notice('info', 'compact 完成：历史已压缩为总结 + 最近 8 条（fileState 保留）')
    if (meta.truncated) deps.notice('warn', '[compact 警告] 总结被长度截断，信息可能有损')
  }

  /** precompute 命中：用预算好的摘要 + arm 后尾部重建，无 LLM 等待。 */
  const swapPrecomputed = async (messages: any[], summary: string, truncated: boolean, armLen: number): Promise<void> => {
    const rebuilt = rebuildFromPrecompute(messages, summary, armLen)
    await applyCompactResult(messages, rebuilt, { trigger: 'auto', summary, truncated })
    deps.notice('info', '[precompute] 已换入预算摘要（无阻塞等待）')
  }

  /** compact：总结→重建消息→落盘 compact 记录与新前缀。失败不破坏现场（messages 仅在成功后替换）。 */
  const compactNow = async (messages: any[], trigger: 'auto' | 'manual' = 'auto'): Promise<void> => {
    if (trigger === 'manual') precomputeReg.clear() // 避免与在途 precompute 竞争
    deps.notice('info', '[compact 总结中…]')
    // ac 须可被中止：① 超时定时器（防 provider 卡住流无限挂起）② interrupt()/ESC（abortInFlight）。
    const ac = new AbortController()
    compactAbort = ac
    const timeoutTimer = setTimeout(() => ac.abort(new Error(`compact 超时（${COMPACT_TIMEOUT_MS / 1000}s 内 provider 无响应）`)), COMPACT_TIMEOUT_MS)
    try {
      await deps.runPreCompactHook(trigger, messages.length)
      // SessionMemory 并入：若会话记忆存在，将其内容作为 user 前置消息注入 summarize 输入，保留会话状态
      let messagesForSummarize = messages
      const smContent = deps.sessionMemoryContent()
      if (smContent !== undefined) {
        messagesForSummarize = [
          ...messages.slice(0, 1), // system
          { role: 'user', content: `<会话记忆>\n${smContent}\n</会话记忆>` },
          ...messages.slice(1),
        ]
      }
      const { summary, usage: u, truncated } = await summarize(deps.client, messagesForSummarize, ac.signal)
      deps.onUsage(u, deps.activeFastModel())
      const rebuilt = rebuildMessages(messages, summary)
      await applyCompactResult(messages, rebuilt, { trigger, summary, truncated })
      // 手动也是一次 compact：失败计数归零 + 3b 计数保持一致。抛错则跳过（与原 /compact 的 try 内落点一致）。
      // 自动路径不走这里——它在 maybeCompact 内用本轮算出的 rr 落 recordCompact，两条路径不可合并。
      if (trigger === 'manual') {
        consecutiveCompactFailures = 0
        recordCompact(compactState, checkRapidRefill(compactState).rapidRefills)
      }
    } finally {
      clearTimeout(timeoutTimer)
      compactAbort = null
    }
  }

  return {
    get contextTokens(): number { return lastPromptTokens },

    observeTurnEnd(promptTokens: number, messagesLen: number): void {
      lastPromptTokens = promptTokens
      // baselineLen 原子配对：lastPromptTokens 覆盖发送时的 messages 前缀（sentLen，含本轮 user，但不含本轮 assistant 产出）
      baselineLen = messagesLen
    },

    async maybeCompact(messages: any[]): Promise<void> {
      // 发送前预估：上次真实 prompt_tokens + 自 baseline 以来新增消息的估算（含本轮 assistant 产出）。
      // clamp Math.min 守 rewind/截断（baselineLen 可能 > 当前 messages.length）。
      // ===== mc 互斥 + prefix 守卫 + 3b block-before + consume-or-fallback =====
      let estimated = lastPromptTokens + estimateMessagesTokens(messages.slice(Math.min(baselineLen, messages.length)))
      const thr = threshold()
      let compactedThisTurn = false

      if (estimated >= thr) {
        // C1 prefix-overflow 守卫：不可压前缀（system + 最近 COMPACT_KEEP 条）本身 ≥ thr → compaction 帮不上
        // slice 从 max(1, …) 起，短对话下也不把 system(messages[0]) 重复计入
        const keepTail = messages.slice(Math.max(1, messages.length - COMPACT_KEEP))
        const incompressible = estimateMessagesTokens([messages[0], ...keepTail])
        if (incompressible >= thr) {
          deps.notice('warn', 'compaction 帮不上：固定前缀（system + 最近消息）已超阈值，请 /clear 重开或分块读大文件')
        } else {
          // A2 互斥：先算 microcompact，仅当它单独就能压回阈值下才 apply
          const mc = microcompact(messages)
          if (mc && estimated - mc.tokensSaved < thr) {
            messages.length = 0
            messages.push(...mc.messages)
            lastPromptTokens = 0
            baselineLen = 0
            estimated = estimateMessagesTokens(messages)
            deps.notice('info', `[microcompact] 甩掉 ~${mc.tokensSaved} tok 旧工具输出`)
            // 本轮不 compact（原始 tool 结果仍在转录，仅内存瘦身，不 appendCompact）
          } else {
            // A3 block-before：先查快速回填熔断
            const rr = checkRapidRefill(compactState)
            if (rr.tripped) {
              deps.notice('warn', '上下文在 3 轮内反复填满 3 次，某文件或工具输出可能过大，请分块读或用 /clear 重开')
              messages.push({ role: 'user', content: '<system-reminder>\n上下文反复被填满（thrashing）。请停止重复读取大文件/大工具输出，改为分块读取，或提示用户用 /clear。\n</system-reminder>' })
              // 本轮不 compact；turnCounter 由下方统一 ++，≥3 时 checkRapidRefill 归零自愈（无永久 latch）
            } else if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) {
              // 3a 熔断已跳闸：停本会话自动全量 compact（直到手动 /compact 重置计数或会话重置），本轮不再尝试。
              // 首次达阈时 catch 分支已告警「已暂停」，此处静默跳过，不重复告警、不再烧 API。
            } else {
              try {
                const c = precomputeReg.consume(messages, estimateMessagesTokens, thr)
                if (c.kind === 'ready') {
                  await swapPrecomputed(messages, c.summary, c.truncated, c.armLen)
                  compactedThisTurn = true
                } else if (c.kind === 'pending') {
                  const signal = deps.abortSignal // 每次现取：注入方可能按 turn 换 AbortController
                  const aborted = await Promise.race([
                    c.settled.then(() => false),
                    new Promise<boolean>(res => signal.addEventListener('abort', () => res(true), { once: true })),
                  ])
                  if (!aborted) {
                    const c2 = precomputeReg.consume(messages, estimateMessagesTokens, thr)
                    if (c2.kind === 'ready') { await swapPrecomputed(messages, c2.summary, c2.truncated, c2.armLen); compactedThisTurn = true }
                    else { await compactNow(messages, 'auto'); compactedThisTurn = true } // C4：settled 后仍非 ready → 全量
                  }
                  // aborted：本轮不 compact，entry 留待下轮
                } else {
                  // none/failed/stale → 阻塞全量
                  await compactNow(messages, 'auto')
                  compactedThisTurn = true
                }
                if (compactedThisTurn) {
                  recordCompact(compactState, rr.rapidRefills)
                  consecutiveCompactFailures = 0
                  estimated = lastPromptTokens + estimateMessagesTokens(messages.slice(Math.min(baselineLen, messages.length))) // C3 重估
                }
              } catch (e: any) {
                // 用户中断（ESC / steering 软中断）不是 provider 故障，不推进 3a 熔断——
                // 逐轮压缩后触发频次高一个数量级，计入的话连按三次 ESC 就把本会话自动压缩停掉。
                //
                // 判 deps.abortSignal 而非 compactNow 内部那个 ac：ac 是 compactNow 的局部变量、
                // finally 已把 compactAbort 置 null，此处访问不到。两者可分靠的是中止源差异——
                // useChat.ts 的 interrupt() 里 abortInFlight() 与 abort.abort('user-cancel') 紧挨两行，
                // ESC 必然让外层 signal 也 aborted；而本文件 compactNow 的超时定时器只中止内部 ac、不碰外层。
                // 不判 reason：steering 软中断用的是 'interrupt'，同样是用户动作，同样不算故障。
                // （这里刻意只写符号名不写行号：本批修过一次行号漂移，而那次修复在同一个 commit 内
                //  又被另一处编辑顶偏了 4 行——行号注释是会自我打脸的，符号名不会。）
                if (!deps.abortSignal.aborted) {
                  consecutiveCompactFailures++
                  if (consecutiveCompactFailures >= MAX_AUTO_COMPACT_FAILURES) deps.notice('warn', '自动压缩连续失败 3 次，已暂停（用 /compact 手动重试）')
                  else deps.notice('error', `[自动 compact 失败，将在下轮重试] ${e?.message ?? e}`)
                }
              }
            }
          }
        }
      }

      if (!compactedThisTurn) bumpTurnCounter(compactState) // 本轮无全量 compact/swap 才 ++

      lastEstimated = estimated
    },

    armPrecompute(messages: any[]): void {
      const thr = threshold()
      // precompute arm（下一轮预热）：过 arm 带且启用且空闲（armLen 太短的门在 registry.arm 内）
      if (deps.settings.precomputeCompactionEnabled !== false
          && lastEstimated >= thr - PRECOMPUTE_BUFFER_FRACTION * thr
          && !precomputeReg.busy) {
        precomputeReg.arm(messages, messages.length, (m, sig) => summarize(deps.client, m, sig))
      }
    },

    compactNow,

    abortInFlight(): void {
      compactAbort?.abort('user-cancel') // 压缩进行中：ESC 也能中断（否则卡在 compactNow 的 ac，只能等超时）
    },

    clearPrecompute(): void {
      precomputeReg.clear()
    },

    clearForRewind(): void {
      precomputeReg.clear()
      Object.assign(compactState, newCompactState())
    },

    reset(): void {
      // A1：/resume 切到别的历史线、/rewind 改写历史线，旧 precompute 快照与新历史不同源必须弃用；
      // token 计数与两个熔断计数同属旧历史线，一并归零。
      lastPromptTokens = 0
      baselineLen = 0
      consecutiveCompactFailures = 0
      lastEstimated = 0
      precomputeReg.clear()
      Object.assign(compactState, newCompactState())
    },
  }
}
