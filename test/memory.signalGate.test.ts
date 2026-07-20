import { describe, it, expect, vi, beforeEach } from 'vitest'

const activeModelMetaMock = vi.fn()
vi.mock('../src/providers.js', async orig => ({
  ...(await orig() as any),
  activeModelMeta: (id: string) => activeModelMetaMock(id),
}))

import { hasDurableSignal } from '../src/services/memory/signalGate.js'

const mkClient = (impl: any) => ({ chat: { completions: { create: impl } } }) as any
const sig = new AbortController().signal
const recent = [{ role: 'user', content: '我以后都用中文回复' }]

beforeEach(() => {
  activeModelMetaMock.mockReset()
  activeModelMetaMock.mockReturnValue({ supportsThinking: false, hit: 0, miss: 0, out: 0, contextWindow: 0 })
})

describe('hasDurableSignal', () => {
  it('明确 yes → true', async () => {
    const c = mkClient(async () => ({ choices: [{ message: { content: 'yes' } }] }))
    expect(await hasDurableSignal(c, 'fast', recent, sig)).toBe(true)
  })
  it('no → false（严格，减噪声）', async () => {
    const c = mkClient(async () => ({ choices: [{ message: { content: 'no' } }] }))
    expect(await hasDurableSignal(c, 'fast', recent, sig)).toBe(false)
  })
  it('空/歧义回复 → false（偏保守）', async () => {
    const c = mkClient(async () => ({ choices: [{ message: { content: '' } }] }))
    expect(await hasDurableSignal(c, 'fast', recent, sig)).toBe(false)
  })
  it('中文容错：回「是」→ true（防 fast 档中文回复被漏判成假阴性）', async () => {
    const c = mkClient(async () => ({ choices: [{ message: { content: '是' } }] }))
    expect(await hasDurableSignal(c, 'fast', recent, sig)).toBe(true)
  })
  it('中文容错：回「否」/「不是」→ false', async () => {
    const c1 = mkClient(async () => ({ choices: [{ message: { content: '否' } }] }))
    expect(await hasDurableSignal(c1, 'fast', recent, sig)).toBe(false)
    const c2 = mkClient(async () => ({ choices: [{ message: { content: '不是' } }] }))
    expect(await hasDurableSignal(c2, 'fast', recent, sig)).toBe(false)
  })
  it('抛错 → true（fail-open，绝不因门控故障丢记忆）', async () => {
    const c = mkClient(async () => { throw new Error('boom') })
    expect(await hasDurableSignal(c, 'fast', recent, sig)).toBe(true)
  })
  it('有 usage 时回调 onUsage', async () => {
    const c = mkClient(async () => ({ choices: [{ message: { content: 'yes' } }], usage: { prompt_tokens: 5 } }))
    const onUsage = vi.fn()
    await hasDurableSignal(c, 'fast', recent, sig, onUsage)
    expect(onUsage).toHaveBeenCalledWith({ prompt_tokens: 5 }, 'fast')
  })

  it('thinking 模型（glm 等 supportsThinking=true）→ 请求带 thinking:disabled，防 reasoning 吃光 max_tokens', async () => {
    activeModelMetaMock.mockReturnValue({ supportsThinking: true, hit: 0, miss: 0, out: 0, contextWindow: 0 })
    let seenParams: any
    const c = mkClient(async (params: any) => { seenParams = params; return { choices: [{ message: { content: 'yes' } }] } })
    await hasDurableSignal(c, 'glm-model', recent, sig)
    expect(seenParams.thinking).toEqual({ type: 'disabled' })
  })
  it('非 thinking 模型（deepseek 等 supportsThinking=false）→ 请求不带 thinking 字段，行为不变', async () => {
    activeModelMetaMock.mockReturnValue({ supportsThinking: false, hit: 0, miss: 0, out: 0, contextWindow: 0 })
    let seenParams: any
    const c = mkClient(async (params: any) => { seenParams = params; return { choices: [{ message: { content: 'yes' } }] } })
    await hasDurableSignal(c, 'deepseek-model', recent, sig)
    expect(seenParams.thinking).toBeUndefined()
  })
})
