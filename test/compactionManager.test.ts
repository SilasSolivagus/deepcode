// test/compactionManager.test.ts —— 共享压缩单元的直接单测（不经 TUI）。
// 与 test/useChat.compact.test.ts 分工：那边钉的是 TUI 接线后的端到端语义（Task 4 的验收网），
// 这边只驱动 manager 本体，验证四条主干路由：不过阈值 / 全量 / mc 单独够压 / 3a 连续失败熔断。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCompactionManager } from '../src/compactionManager.js'

vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '摘要', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))
import { summarize } from '../src/compact.js'

const HUGE = 'x'.repeat(70000)
const tool = (c: string) => ({ role: 'tool', tool_call_id: 't', content: c })

/** 造一套最小注入：notice 落数组，其余 no-op。 */
function mkDeps(over: Partial<any> = {}) {
  const notices: Array<[string, string]> = []
  return {
    notices,
    deps: {
      client: {} as any,
      model: 'deepseek-v4-flash',
      settings: { compactTokens: 20000, precomputeCompactionEnabled: false } as any,
      abortSignal: new AbortController().signal,
      notice: (l: any, m: string) => { notices.push([l, m]) },
      onUsage: () => {},
      persistCompact: async () => {},
      sessionMemoryContent: () => undefined,
      runPreCompactHook: async () => {},
      runPostCompactHook: async () => {},
      activeFastModel: () => 'fast',
      ...over,
    },
  }
}

describe('compactionManager', () => {
  // summarize 是模块级 mock，调用次数会跨用例累加（各用例都按「本例内第几次」断言），必须逐例清零。
  // 只清 calls 不清 implementation：末例的 mockRejectedValue 若泄漏到后续新增用例需自行复位（同 useChat.compact.test.ts 的约定）。
  beforeEach(() => { vi.clearAllMocks() })

  it('未过阈值 → 不压缩', async () => {
    const { deps } = mkDeps()
    const m = createCompactionManager(deps as any)
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    m.observeTurnEnd(1000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).not.toHaveBeenCalled()
  })

  it('过阈值且无可甩 → 全量压缩，messages 被原地替换', async () => {
    const { deps } = mkDeps()
    const m = createCompactionManager(deps as any)
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    const ref = messages
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(1)
    expect(messages).toBe(ref)            // 同一数组引用（原地）
    expect(messages.some(x => typeof x.content === 'string' && x.content.includes('摘要'))).toBe(true)
  })

  it('microcompact 单独够压 → 不调 summarize', async () => {
    const { deps, notices } = mkDeps()
    const m = createCompactionManager(deps as any)
    const messages = [
      { role: 'system', content: 's' }, { role: 'user', content: 'u' },
      tool(HUGE), ...Array.from({ length: 8 }, () => tool('ok')),
    ]
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).not.toHaveBeenCalled()
    expect(notices.some(([, msg]) => msg.includes('microcompact'))).toBe(true)
  })

  it('压缩失败连续 3 次后熔断，第 4 次不再调 summarize', async () => {
    ;(summarize as any).mockRejectedValue(new Error('boom'))
    const { deps, notices } = mkDeps()
    const m = createCompactionManager(deps as any)
    for (let i = 0; i < 3; i++) {
      const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
      m.observeTurnEnd(25000, messages.length)
      await m.maybeCompact(messages)
    }
    expect(summarize).toHaveBeenCalledTimes(3)
    expect(notices.some(([, msg]) => msg.includes('已暂停'))).toBe(true)
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(3)
  })

  it('abortInFlight 中断在途压缩：以 user-cancel 失败结束，不破坏现场也不留悬挂句柄', async () => {
    // summarize 挂住直到 signal abort——既验证 signal 真的被串到 summarize，也验证 abort 后能逃出
    ;(summarize as any).mockImplementation((_c: any, _m: any, signal: AbortSignal) =>
      new Promise((_res, rej) => {
        if (signal.aborted) return rej(signal.reason) // abort 早于 summarize 调用时（PreCompact hook 的 await 之后才调）
        signal.addEventListener('abort', () => rej(signal.reason), { once: true })
      }))
    const { deps } = mkDeps()
    const m = createCompactionManager(deps as any)
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]

    const p = m.compactNow(messages, 'auto')
    m.abortInFlight()
    await expect(p).rejects.toBe('user-cancel') // 是被 abortInFlight 中断的，不是 120s 超时
    expect(messages.length).toBe(2)             // 失败不破坏现场（messages 仅在成功后替换）

    // 不留悬挂：句柄已归 null（再 abort 是 no-op），下一次压缩能正常跑完
    expect(() => m.abortInFlight()).not.toThrow()
    ;(summarize as any).mockResolvedValue({
      summary: '摘要2', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
    })
    await m.compactNow(messages, 'auto')
    expect(messages.some(x => typeof x.content === 'string' && x.content.includes('摘要2'))).toBe(true)
  })

  it("compactNow(…, 'manual')：清 precompute 在途预算 + 成功后归零失败计数（熔断解除）", async () => {
    const { deps } = mkDeps()
    deps.settings.precomputeCompactionEnabled = false // 阶段一：先把 3a 熔断打跳闸（不掺 precompute）
    const m = createCompactionManager(deps as any)
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]

    ;(summarize as any).mockRejectedValue(new Error('boom'))
    for (let i = 0; i < 3; i++) {
      m.observeTurnEnd(25000, messages.length)
      await m.maybeCompact(messages)
    }
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(3) // 第 4 轮已被熔断挡住

    // 阶段二：开 precompute，arm 一次并把它挂在 pending（捕获它的 signal，用于验证 clear 真的 abort 了它）
    deps.settings.precomputeCompactionEnabled = true
    let armSignal: AbortSignal | undefined
    ;(summarize as any).mockImplementation((_c: any, _m: any, signal: AbortSignal) => {
      if (!armSignal) { armSignal = signal; return new Promise(() => {}) } // arm 那次永不 settle
      return Promise.resolve({
        summary: '摘要', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
      })
    })
    messages.push({ role: 'tool', tool_call_id: 't', content: 'ok' }, { role: 'tool', tool_call_id: 't', content: 'ok' })
    m.observeTurnEnd(18000, messages.length) // 落在 arm 带 [16000,20000)，未到压缩阈值
    await m.maybeCompact(messages)
    m.armPrecompute(messages)
    expect(summarize).toHaveBeenCalledTimes(4)
    expect(armSignal?.aborted).toBe(false)

    // 阶段三：手动 compact —— 清 precompute（在途预算被 abort）+ 压缩成功
    await m.compactNow(messages, 'manual')
    expect(armSignal?.aborted).toBe(true)
    expect(summarize).toHaveBeenCalledTimes(5)
    expect(messages.some(x => typeof x.content === 'string' && x.content.includes('摘要'))).toBe(true)

    // 阶段四：失败计数已归零 → 自动路径恢复（若没归零，这轮会被 3a 熔断静默跳过）
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(6)
  })

  it('clearPrecompute 只作废预热快照：token 基线与熔断计数原封不动（与 reset 的分界）', async () => {
    // /fork 的窄口。它把 messages 逐条拷进新会话、历史完整保留，所以压缩状态仍然适用——
    // 只有 precompute 快照因会话文件换了才必须弃用。若这里误用 reset()，一个正在 thrash 的会话
    // fork 之后熔断保护会从零开始，本用例即红。
    const { deps } = mkDeps()
    deps.settings.precomputeCompactionEnabled = false
    const m = createCompactionManager(deps as any)
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]

    // 阶段一：连 3 次失败把 3a 熔断打跳闸（计数非零的可观测代理）
    ;(summarize as any).mockRejectedValue(new Error('boom'))
    for (let i = 0; i < 3; i++) {
      m.observeTurnEnd(25000, messages.length)
      await m.maybeCompact(messages)
    }
    expect(summarize).toHaveBeenCalledTimes(3)

    // 阶段二：开 precompute 并 arm 一个永不 settle 的在途预算，捕获它的 signal
    deps.settings.precomputeCompactionEnabled = true
    let armSignal: AbortSignal | undefined
    ;(summarize as any).mockImplementation((_c: any, _m: any, signal: AbortSignal) => {
      if (!armSignal) { armSignal = signal; return new Promise(() => {}) }
      return Promise.resolve({
        summary: '摘要', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
      })
    })
    messages.push({ role: 'tool', tool_call_id: 't', content: 'ok' }, { role: 'tool', tool_call_id: 't', content: 'ok' })
    m.observeTurnEnd(18000, messages.length) // 落 arm 带 [16000,20000)，未到压缩阈值；armLen=4 达 PRECOMPUTE_MIN_ARM_LEN
    await m.maybeCompact(messages)
    m.armPrecompute(messages)
    expect(summarize).toHaveBeenCalledTimes(4)
    expect(armSignal?.aborted).toBe(false)
    expect(m.contextTokens).toBe(18000)

    // ——— 被测调用 ———
    m.clearPrecompute()

    // ① 预热快照确实被作废（在途那次被 abort）
    expect(armSignal?.aborted).toBe(true)
    // ② token 基线原封不动（reset() 会把它归零）
    expect(m.contextTokens).toBe(18000)
    // ③ 3a 熔断计数原封不动：仍跳闸，本轮静默跳过，不再调 summarize
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(4)

    // 对照：reset() 才归零计数——同样一轮立刻恢复压缩，证明上面第 ③ 条不是「压不动」而是「计数还在」
    m.reset()
    expect(m.contextTokens).toBe(0)
    m.observeTurnEnd(25000, messages.length)
    await m.maybeCompact(messages)
    expect(summarize).toHaveBeenCalledTimes(5)
  })
})
