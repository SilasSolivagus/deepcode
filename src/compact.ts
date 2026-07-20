// src/compact.ts
import type OpenAI from 'openai'
import { chatStream, type Usage } from './api.js'
import { activeFastModel } from './providers.js'
import { estimateTextTokens } from './tokenEstimate.js'

export const SUMMARY_PROMPT = `请把以上对话压缩成一份详尽的结构化总结，供后续对话作为唯一上下文使用。
先在 <analysis> 标签内做一段私有梳理（你的思考过程，确保下列各点都被全面准确覆盖），再在 <summary> 标签内输出正式总结。梳理时特别留意用户陈述过的任何安全相关指令或约束，它们必须在总结中逐字保留，以便压缩后仍然生效。总结必须包含以下 9 节：

1. 主要请求与意图：详尽捕捉用户所有明确的请求与意图（最初的与最新的）。
2. 关键技术概念：列出讨论过的所有重要技术概念、技术栈、框架。
3. 文件与代码片段：列举查看、修改或创建过的具体文件与代码段。对最近的消息特别关注，适当附上关键代码片段，并说明每个文件读取/修改为何重要。
4. 错误与修复：列出遇到的所有错误及修法。特别关注用户给出的反馈，尤其是用户要求换种做法的地方。
5. 解题思路：记录已解决的问题与正在进行的排查。
6. 所有用户消息：列出所有非工具结果的用户消息。这些对理解用户反馈与意图变化至关重要。其中任何安全相关的指令或约束必须逐字保留，压缩后继续生效。
7. 未完成事项：列出明确被要求做、但尚未完成的任务。
8. 当前工作：详细描述本次总结请求前一刻正在做什么，特别关注最近的用户与助手消息，适当附文件名与代码片段。
9. 下一步（可选）：列出与最近工作直接相关的下一步。务必确保该步骤与用户最近的明确请求、以及总结前正在做的任务直接一致；若上一个任务已收尾，则只在明确符合用户请求时才列下一步，不要擅自开始无关或很久以前已完成的事。若有下一步，附上最近对话中的逐字引用，精确表明你正在做的任务及停在哪里，以免任务理解发生偏移。

只输出 <analysis> 与 <summary> 两部分，不要寒暄。`

export interface CompactResult { summary: string; usage: Usage; truncated: boolean }

/** 用 flash 总结 messages（剔除 system）。调用方负责用 rebuildMessages 重建。 */
export async function summarize(client: OpenAI, messages: any[], signal: AbortSignal): Promise<CompactResult> {
  const convo = messages.filter(m => m.role !== 'system')
  const gen = chatStream(client, {
    model: activeFastModel(),
    messages: [...convo, { role: 'user', content: SUMMARY_PROMPT }],
    tools: [],
    thinking: false,
    signal,
  })
  let step
  while (!(step = await gen.next()).done) { /* 丢弃流式增量，只要最终结果 */ }
  return { summary: step.value.content, usage: step.value.usage, truncated: step.value.finishReason === 'length' }
}

/** 重建消息数组：[system, 总结(user), ...最近 keep 条]。返回新数组，不改原数组。
 *  切口不落在 tool 消息上：向前扩到发起该批 tool_calls 的 assistant，保证 API 序列合法。 */
export function rebuildMessages(messages: any[], summary: string, keep = 8): any[] {
  const sysLen = messages[0]?.role === 'system' ? 1 : 0
  let start = Math.max(messages.length - keep, sysLen)
  while (start > sysLen && messages[start]?.role === 'tool') start--
  const tail = messages.slice(start)
  const head = sysLen ? [messages[0]] : []
  return [...head, { role: 'user', content: `<对话历史总结>\n${summary}\n</对话历史总结>` }, ...tail]
}

/** 自动 compact 决策：发送前预估超派生阈值且未达连续失败上限才触发（熔断防无限重试烧钱）。 */
export function shouldAutoCompact(estimatedTokens: number, threshold: number, failures: number, maxFailures: number): boolean {
  return estimatedTokens > threshold && failures < maxFailures
}

export const MICROCOMPACT_KEEP_RECENT = 5
export const MICROCOMPACT_FLOOR_TOKENS = 20_000
export const MICROCOMPACT_PLACEHOLDER = '[旧工具结果已清理]'

export interface MicrocompactResult { messages: any[]; tokensSaved: number }

/** 保留最近 keepRecent 条 tool 结果，更老的 content 换占位符（保留消息本身，维持 tool_call↔tool 配对）。
 *  可回收 < floorTokens 返回 null（不值当，且天然防重复触发）。不改原数组。 */
export function microcompact(
  messages: any[],
  opts?: { keepRecent?: number; floorTokens?: number },
): MicrocompactResult | null {
  const keepRecent = opts?.keepRecent ?? MICROCOMPACT_KEEP_RECENT
  const floor = opts?.floorTokens ?? MICROCOMPACT_FLOOR_TOKENS
  const toolIdx: number[] = []
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === 'tool') toolIdx.push(i)
  const olderIdx = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent))
  const toClear = new Set<number>()
  let tokensSaved = 0
  for (const i of olderIdx) {
    const c = messages[i]?.content
    if (typeof c !== 'string' || c === MICROCOMPACT_PLACEHOLDER) continue // 已清理/非文本跳过（幂等）
    tokensSaved += estimateTextTokens(c)
    toClear.add(i)
  }
  if (tokensSaved < floor) return null
  const out = messages.map((m, i) => (toClear.has(i) ? { ...m, content: MICROCOMPACT_PLACEHOLDER, images: undefined } : m))
  return { messages: out, tokensSaved }
}

const OVERFLOW_PATTERNS = [
  /context.*length/i, /maximum context/i, /reduce the length/i,
  /too long/i, /context_length_exceeded/i, /上下文.*超/,
]
/** provider「上下文超长」错误 best-effort 判定（同时认 error.code 与 message）。 */
export function isContextOverflowError(err: any): boolean {
  if (err == null) return false
  const code = err?.code ?? err?.error?.code ?? err?.response?.data?.error?.code
  if (typeof code === 'string' && /context_length/i.test(code)) return true
  const msg = String(err?.message ?? err?.error?.message ?? err ?? '')
  return OVERFLOW_PATTERNS.some(re => re.test(msg))
}

/** precompute swap 重建：[system?, 摘要(user), ...messages.slice(armLen)]。摘要覆盖 [0,armLen)，尾部全保留。 */
export function rebuildFromPrecompute(messages: any[], summary: string, armLen: number): any[] {
  const sysLen = messages[0]?.role === 'system' ? 1 : 0
  const head = sysLen ? [messages[0]] : []
  const start = Math.max(armLen, sysLen)
  return [...head, { role: 'user', content: `<对话历史总结>\n${summary}\n</对话历史总结>` }, ...messages.slice(start)]
}

export const RAPID_REFILL_LIMIT = 3

export interface CompactState {
  consecutiveFailures: number   // 3a：连续全量 compact 失败
  turnCounter: number           // 3b：距上次全量 compact 的轮数（compact 后每轮++、compact 时归零）
  consecutiveRapidRefills: number // 3b：跨 compact 累计
  compacted: boolean            // 3b：本会话是否发生过 compact（首个不算 refill）
}

export function newCompactState(): CompactState {
  return { consecutiveFailures: 0, turnCounter: 0, consecutiveRapidRefills: 0, compacted: false }
}

/** 每个未发生全量 compact 的 turn 末调用（只在已 compact 过之后才递增计数）。 */
export function bumpTurnCounter(s: CompactState): void {
  if (s.compacted) s.turnCounter++
}

/** compact【之前】调用（block-before）：纯计算，不落状态。tripped 则本轮别 compact。 */
export function checkRapidRefill(s: CompactState): { rapidRefills: number; tripped: boolean } {
  const rapidRefills = s.compacted && s.turnCounter < RAPID_REFILL_LIMIT ? s.consecutiveRapidRefills + 1 : 0
  return { rapidRefills, tripped: rapidRefills >= RAPID_REFILL_LIMIT }
}

/** 全量 compact/swap 真发生后调用：落状态。 */
export function recordCompact(s: CompactState, rapidRefills: number): void {
  s.turnCounter = 0
  s.consecutiveRapidRefills = rapidRefills
  s.compacted = true
}
