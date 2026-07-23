import { describe, it, expect, vi } from 'vitest'
import { makeWebSearchTool } from '../src/tools/webSearchTool.js'

const SAMPLE = `## Search Results (1 results, 5ms)\n\n### 1. Foo\n- **URL**: https://foo/x\n- 正文内容`
const ctx: any = { signal: undefined }

describe('WebSearch anysearch 兜底', () => {
  it('无 bocha/tavily + enabled → 触发 anysearch，并首次附一次性告知', async () => {
    const fj: any = vi.fn(async () => ({ result: { content: [{ type: 'text', text: SAMPLE }] } }))
    const tool = makeWebSearchTool({ config: { anysearch: { enabled: true } }, fetchJson: fj })
    const r1 = await tool.call({ query: 'hello world' }, ctx)
    expect(r1).toContain('foo/x')
    expect(r1).toContain('内置匿名搜索') // R1 告知
    const r2 = await tool.call({ query: 'again' }, ctx)
    expect(r2).not.toContain('内置匿名搜索') // 二次不再告知
  })
  it('有 bocha → 不触发 anysearch', async () => {
    const anysearchFj: any = vi.fn(async () => { throw new Error('should not be called') })
    // bocha 也用同一 fetchJson mock，返回 bocha 形状；断言 anysearch 端点未被打
    const fj: any = vi.fn(async (url: string) => url.includes('bochaai')
      ? { data: { webPages: { value: [{ name: 'B', url: 'https://b/1', snippet: 's' }] } } }
      : (() => { throw new Error('anysearch should not fire') })())
    const tool = makeWebSearchTool({ config: { bocha: 'bk', anysearch: { enabled: true } }, fetchJson: fj })
    const r = await tool.call({ query: 'hello world' }, ctx)
    expect(r).toContain('b/1')
    expect(fj.mock.calls.every((c: any[]) => !String(c[0]).includes('anysearch'))).toBe(true)
  })
  it('anysearch 抛错 → 专属不可用文案 + 后续快返', async () => {
    const fj: any = vi.fn(async () => ({ error: { message: 'rate limited' } }))
    const tool = makeWebSearchTool({ config: { anysearch: { enabled: true } }, fetchJson: fj })
    const r1 = await tool.call({ query: 'hello world' }, ctx)
    expect(r1).toContain('暂时不可用')
    await tool.call({ query: 'again' }, ctx)
    expect(fj).toHaveBeenCalledTimes(1) // 粘滞：第二次不再打网络
  })
  it('禁用且无 key → 无源错误', async () => {
    const tool = makeWebSearchTool({ config: { anysearch: { enabled: false } } })
    const r = await tool.call({ query: 'hello world' }, ctx)
    expect(r).toContain('未配置')
  })
})
