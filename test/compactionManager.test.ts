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
})
