// test/precompute.test.ts
import { describe, it, expect, vi } from 'vitest'
import { PrecomputeRegistry, PRECOMPUTE_MIN_ARM_LEN } from '../src/precompute.js'

const U = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
const msgs = (n: number) => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i }))
const okSummarize = vi.fn(async () => ({ summary: 'S', usage: U, truncated: false }))
const zeroTail = () => 0

describe('PrecomputeRegistry', () => {
  it('arm 后 consume 先 pending，settle 后 ready 并清空', async () => {
    const reg = new PrecomputeRegistry()
    reg.arm(msgs(10), 10, okSummarize)
    const c1 = reg.consume(msgs(12), zeroTail, 100000)
    expect(c1.kind).toBe('pending')
    await (c1 as any).settled
    const c2 = reg.consume(msgs(12), zeroTail, 100000)
    expect(c2.kind).toBe('ready')
    expect((c2 as any).armLen).toBe(10)
    // 消费后清空
    expect(reg.consume(msgs(12), zeroTail, 100000).kind).toBe('none')
  })

  it('summarize 失败 → failed 且 failures++', async () => {
    const reg = new PrecomputeRegistry()
    const bad = vi.fn(async () => { throw new Error('boom') })
    reg.arm(msgs(10), 10, bad)
    await (reg.consume(msgs(10), zeroTail, 100000) as any).settled
    expect(reg.consume(msgs(10), zeroTail, 100000).kind).toBe('failed')
    expect(reg.failures).toBe(1)
  })

  it('连续失败达上限后不再 arm（3c）', async () => {
    const reg = new PrecomputeRegistry()
    const bad = vi.fn(async () => { throw new Error('boom') })
    for (let i = 0; i < 3; i++) { reg.arm(msgs(10), 10, bad); await (reg.consume(msgs(10), zeroTail, 1e5) as any).settled ?? Promise.resolve(); reg.consume(msgs(10), zeroTail, 1e5) }
    expect(reg.failures).toBe(3)
    reg.arm(msgs(10), 10, bad)      // 超上限
    expect(reg.busy).toBe(false)    // 没 arm
  })

  it('armLen 太短不 arm（too_few_groups，不算失败）', () => {
    const reg = new PrecomputeRegistry()
    reg.arm(msgs(3), PRECOMPUTE_MIN_ARM_LEN - 1, okSummarize)
    expect(reg.busy).toBe(false)
    expect(reg.failures).toBe(0)
  })

  it('aborted 不计入 failures（A4）', async () => {
    const reg = new PrecomputeRegistry()
    let sig: AbortSignal
    const slow = vi.fn((_m: any[], s: AbortSignal) => { sig = s; return new Promise<any>((_, rej) => s.addEventListener('abort', () => rej(new Error('aborted')))) })
    reg.arm(msgs(10), 10, slow as any)
    const c = reg.consume(msgs(10), zeroTail, 1e5)
    expect(c.kind).toBe('pending')
    reg.clear()                     // abort 在途
    await (c as any).settled
    expect(reg.failures).toBe(0)    // aborted 不计
  })

  it('ready 但 armLen > 当前长度 → stale（rewind）', async () => {
    const reg = new PrecomputeRegistry()
    reg.arm(msgs(10), 10, okSummarize)
    await (reg.consume(msgs(10), zeroTail, 1e5) as any).settled
    const c = reg.consume(msgs(6), zeroTail, 1e5) // 当前只剩 6 < armLen 10
    expect(c.kind).toBe('stale')
  })

  it('grew_too_much：尾部已 ≥ thr → stale', async () => {
    const reg = new PrecomputeRegistry()
    reg.arm(msgs(10), 10, okSummarize)
    await (reg.consume(msgs(10), zeroTail, 1e5) as any).settled
    const bigTail = () => 200000
    expect(reg.consume(msgs(14), bigTail, 100000).kind).toBe('stale')
  })
})
