import { describe, it, expect } from 'vitest'
import { parseAnysearchResults, anysearchSearch, AnysearchError } from '../src/webSearch.js'

const SAMPLE = `## Search Results (2 results, 1413ms)

### 1. Foo Title
- **URL**: https://foo.example/page
- Foo Title # Foo Header ## 目录 * [跳转](#x) 正文有用内容在这里 aaa bbb ccc [链接文字](https://x) 更多正文

### 2. Bar Title
- **URL**: https://bar.example/
- Bar body text here`

describe('parseAnysearchResults', () => {
  it('解析多结果为 title/url/snippet', () => {
    const r = parseAnysearchResults(SAMPLE)
    expect(r).toHaveLength(2)
    expect(r[0]).toMatchObject({ title: 'Foo Title', url: 'https://foo.example/page' })
    expect(r[0].snippet.length).toBeLessThanOrEqual(201) // 200 + 省略号
    expect(r[0].snippet).not.toContain('](') // markdown 链接语法已剥
  })
  it('整页 dump 自带 ### 章节标题 → 仍是 1 条（不按裸 ### split）', () => {
    const dump = `## Search Results (1 results, 10ms)

### 1. Wiki
- **URL**: https://w/x
- 正文 ### 开发 段落一 ### 性能 段落二 ### 参考`
    const r = parseAnysearchResults(dump)
    expect(r).toHaveLength(1)
    expect(r[0].url).toBe('https://w/x')
  })
  it('无 URL 的块丢弃', () => {
    expect(parseAnysearchResults(`### 1. NoUrl\n- 没有 url 行`)).toHaveLength(0)
  })
  it('空/畸形 → []', () => {
    expect(parseAnysearchResults('')).toHaveLength(0)
    expect(parseAnysearchResults('随便什么没有结果')).toHaveLength(0)
  })
})

describe('anysearchSearch', () => {
  const ok = (text: string): any => async () => ({ jsonrpc:'2.0', id:1, result:{ content:[{ type:'text', text }] } })
  it('正常返回解析结果', async () => {
    const r = await anysearchSearch('q', { count: 5 }, undefined, ok(SAMPLE) as any)
    expect(r.length).toBe(2)
  })
  it('JSON-RPC error body → 抛 AnysearchError', async () => {
    const fj: any = async () => ({ jsonrpc:'2.0', id:1, error:{ code:-32000, message:'rate limited' } })
    await expect(anysearchSearch('q', {}, undefined, fj)).rejects.toBeInstanceOf(AnysearchError)
  })
  it('无 key 不带 Authorization 头', async () => {
    let seenHeaders: any
    const fj: any = async (_url: string, init: any) => { seenHeaders = init.headers; return { result:{ content:[{type:'text',text:''}] } } }
    await anysearchSearch('q', {}, undefined, fj)
    expect(seenHeaders.Authorization).toBeUndefined()
    expect(seenHeaders['X-Anysearch-Client']).toMatch(/^deepcode\//) // 不冒充
  })
})
