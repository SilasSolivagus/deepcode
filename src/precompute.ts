// src/precompute.ts
import type { Usage } from './api.js'

export const PRECOMPUTE_BUFFER_FRACTION = 0.2
export const PRECOMPUTE_REARM_LIMIT = 3
export const PRECOMPUTE_MIN_ARM_LEN = 4 // too_few_groups：armLen 小于此不 arm（历史过短，不算失败）

export type SummarizeFn = (
  messages: any[], signal: AbortSignal,
) => Promise<{ summary: string; usage: Usage; truncated: boolean }>

export type ConsumeResult =
  | { kind: 'none' }
  | { kind: 'pending'; settled: Promise<void> }
  | { kind: 'ready'; summary: string; usage: Usage; truncated: boolean; armLen: number }
  | { kind: 'failed' }
  | { kind: 'stale' }

interface Entry {
  status: 'pending' | 'ready' | 'failed'
  armLen: number
  summary?: string
  usage?: Usage
  truncated?: boolean
  abort: AbortController
  settled: Promise<void>
}

/** 内存版 precompute：每轮末后台预算摘要，真到阈值消费-或-回退。单会话单 entry。 */
export class PrecomputeRegistry {
  private entry: Entry | null = null
  private _failures = 0

  get failures(): number { return this._failures }
  get busy(): boolean { return this.entry != null }

  /** 已在途、超 re-arm 上限、或 armLen 太短 → 不 arm。fire-and-forget 后台 summarize。 */
  arm(messages: any[], armLen: number, summarize: SummarizeFn): void {
    if (this.entry) return
    if (this._failures >= PRECOMPUTE_REARM_LIMIT) return
    if (armLen < PRECOMPUTE_MIN_ARM_LEN) return // too_few_groups：不算失败
    const abort = new AbortController()
    const snapshot = messages.slice(0, armLen)
    const e: Entry = { status: 'pending', armLen, abort, settled: Promise.resolve() }
    e.settled = (async () => {
      try {
        const r = await summarize(snapshot, abort.signal)
        if (abort.signal.aborted) { e.status = 'failed'; return } // aborted 不计
        e.status = 'ready'; e.summary = r.summary; e.usage = r.usage; e.truncated = r.truncated
        this._failures = 0 // 成功归零（consecutive）
      } catch {
        e.status = 'failed'
        if (!abort.signal.aborted) this._failures++ // A4：aborted 不计
      }
    })()
    this.entry = e
  }

  /** 消费决策。pending 不清空（供 await 后重读）；其余分支清空 entry。
   *  estimateTail 用于 grew_too_much（尾部 = messages.slice(armLen)）。 */
  consume(messages: any[], estimateTail: (tail: any[]) => number, thr: number): ConsumeResult {
    const e = this.entry
    if (!e) return { kind: 'none' }
    if (e.status === 'pending') return { kind: 'pending', settled: e.settled }
    if (e.status === 'failed') { this.entry = null; return { kind: 'failed' } }
    // ready:
    if (e.armLen > messages.length) { this.entry = null; return { kind: 'stale' } } // A1 rewind/截断
    const tailTokens = estimateTail(messages.slice(e.armLen))
    if (tailTokens >= thr) { this.entry = null; return { kind: 'stale' } } // grew_too_much
    const res: ConsumeResult = {
      kind: 'ready', summary: e.summary!, usage: e.usage!, truncated: e.truncated ?? false, armLen: e.armLen,
    }
    this.entry = null
    return res
  }

  /** /clear、/rewind、/fork、手动 /compact、session 末：abort 在途 + 清空。 */
  clear(): void { this.entry?.abort.abort(); this.entry = null }
}
