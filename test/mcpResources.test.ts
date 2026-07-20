import { describe, it, expect } from 'vitest'
import { makeListMcpResourcesTool, makeReadMcpResourceTool, makeWaitForMcpServersTool, makeMcpResourceTools } from '../src/mcpResources.js'
import { createMcpRegistry } from '../src/mcpRegistry.js'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ctx = { signal: new AbortController().signal } as any

function callerWith(resources: any[], caps: any = { resources: {} }, pages?: any[][]) {
  let i = 0
  return {
    getServerCapabilities: () => caps,
    listResources: async (_p?: any) => {
      if (pages) { const page = pages[i] ?? []; const nextCursor = i < pages.length - 1 ? `c${i}` : undefined; i++; return { resources: page, nextCursor } }
      return { resources }
    },
    readResource: async () => ({ contents: [] }),
  }
}

describe('makeListMcpResourcesTool', () => {
  it('遍历所有 connected server，给每项贴 server 字段', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any); r.markConnected('A', callerWith([{ uri: 'a://1', name: 'one' }]) as any)
    r.seedPending('B', {} as any); r.markConnected('B', callerWith([{ uri: 'b://1', name: 'two' }]) as any)
    const out = JSON.parse(await makeListMcpResourcesTool(r).call({}, ctx))
    expect(out.map((x: any) => `${x.server}:${x.uri}`).sort()).toEqual(['A:a://1', 'B:b://1'])
  })

  it('server 参数过滤；不存在的 server 抛错', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any); r.markConnected('A', callerWith([{ uri: 'a://1', name: 'one' }]) as any)
    const out = JSON.parse(await makeListMcpResourcesTool(r).call({ server: 'A' }, ctx))
    expect(out).toHaveLength(1)
    await expect(makeListMcpResourcesTool(r).call({ server: 'Z' }, ctx)).rejects.toThrow(/not found/i)
  })

  it('无 resources capability 的 server 跳过返 []（不报错）', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any); r.markConnected('A', callerWith([{ uri: 'a://1', name: 'one' }], null) as any)
    const out = JSON.parse(await makeListMcpResourcesTool(r).call({}, ctx))
    expect(out).toEqual([])
  })

  it('分页：循环 nextCursor 直到无，受 maxPages 上限约束', async () => {
    const r = createMcpRegistry()
    const pages = [[{ uri: 'a://1', name: '1' }], [{ uri: 'a://2', name: '2' }], [{ uri: 'a://3', name: '3' }]]
    r.seedPending('A', {} as any); r.markConnected('A', callerWith([], { resources: {} }, pages) as any)
    const out = JSON.parse(await makeListMcpResourcesTool(r, { maxPages: 2 }).call({}, ctx))
    expect(out.map((x: any) => x.uri)).toEqual(['a://1', 'a://2']) // maxPages=2 截断第三页
  })

  it('单 server listResources 抛错时降级返 []，不整体失败', async () => {
    const r = createMcpRegistry()
    const bad = { getServerCapabilities: () => ({ resources: {} }), listResources: async () => { throw new Error('boom') }, readResource: async () => ({ contents: [] }) }
    r.seedPending('A', {} as any); r.markConnected('A', bad as any)
    r.seedPending('B', {} as any); r.markConnected('B', callerWith([{ uri: 'b://1', name: 'two' }]) as any)
    const out = JSON.parse(await makeListMcpResourcesTool(r).call({}, ctx))
    expect(out.map((x: any) => x.uri)).toEqual(['b://1'])
  })
})

describe('makeReadMcpResourceTool', () => {
  function reg(caller: any) { const r = createMcpRegistry(); r.seedPending('A', {} as any); r.markConnected('A', caller); return r }

  it('文本内容内联返回', async () => {
    const r = reg({ getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [{ uri: 'a://1', mimeType: 'text/plain', text: 'hello' }] }) })
    const out = JSON.parse(await makeReadMcpResourceTool(r).call({ server: 'A', uri: 'a://1' }, ctx))
    expect(out.contents[0].text).toBe('hello')
    expect(out.contents[0].blobSavedTo).toBeUndefined()
  })

  it('二进制 blob 落盘并回传 blobSavedTo 路径（不含 base64）', async () => {
    const blobDir = join(tmpdir(), 'dc-mcp-test')
    const b64 = Buffer.from('binarydata').toString('base64')
    const r = reg({ getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [{ uri: 'a://img', mimeType: 'image/png', blob: b64 }] }) })
    const out = JSON.parse(await makeReadMcpResourceTool(r, { blobDir }).call({ server: 'A', uri: 'a://img' }, ctx))
    const path = out.contents[0].blobSavedTo
    expect(typeof path).toBe('string')
    expect(JSON.stringify(out)).not.toContain(b64)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path).toString()).toBe('binarydata')
    rmSync(blobDir, { recursive: true, force: true })
  })

  it('server 不存在抛错', async () => {
    const r = createMcpRegistry()
    await expect(makeReadMcpResourceTool(r).call({ server: 'Z', uri: 'x' }, ctx)).rejects.toThrow(/not found/i)
  })

  it('MethodNotFound(-32601) 与 not-found 错误映射为友好文案', async () => {
    const notFound = reg({ getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }), readResource: async () => { const e: any = new Error('x'); e.code = -32002; throw e } })
    const out = JSON.parse(await makeReadMcpResourceTool(notFound).call({ server: 'A', uri: 'a://x' }, ctx))
    expect(out.error).toMatch(/ListMcpResources/)
    const noMethod = reg({ getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }), readResource: async () => { const e: any = new Error('x'); e.code = -32601; throw e } })
    const out2 = JSON.parse(await makeReadMcpResourceTool(noMethod).call({ server: 'A', uri: 'a://x' }, ctx))
    expect(out2.error).toMatch(/does not implement|不支持/)
  })
})

describe('makeWaitForMcpServersTool', () => {
  it('无 pending 立即 ready', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any); r.markConnected('A', { getServerCapabilities: () => ({}), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) } as any)
    const out = JSON.parse(await makeWaitForMcpServersTool(r, { pollMs: 1, timeoutMs: 50 }).call({}, ctx))
    expect(out.ready).toBe(true)
    expect(out.connected).toEqual(['A'])
    expect(out.stillPending).toEqual([])
  })

  it('pending 在轮询期间连上 → ready', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any)
    setTimeout(() => r.markConnected('A', { getServerCapabilities: () => ({}), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) } as any), 5)
    const out = JSON.parse(await makeWaitForMcpServersTool(r, { pollMs: 1, timeoutMs: 500 }).call({}, ctx))
    expect(out.ready).toBe(true)
    expect(out.connected).toEqual(['A'])
  })

  it('超时仍 pending → ready:false + stillPending', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any)
    const out = JSON.parse(await makeWaitForMcpServersTool(r, { pollMs: 1, timeoutMs: 20 }).call({}, ctx))
    expect(out.ready).toBe(false)
    expect(out.stillPending).toEqual(['A'])
  })

  it('servers 参数只等指定 server', async () => {
    const r = createMcpRegistry()
    r.seedPending('A', {} as any); r.markConnected('A', { getServerCapabilities: () => ({}), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) } as any)
    r.seedPending('B', {} as any) // B 一直 pending
    const out = JSON.parse(await makeWaitForMcpServersTool(r, { pollMs: 1, timeoutMs: 20 }).call({ servers: ['A'] }, ctx))
    expect(out.ready).toBe(true) // 只等 A，B 被忽略
  })

  it('makeMcpResourceTools 返回 List/Read/Wait 三工具', () => {
    const names = makeMcpResourceTools(createMcpRegistry()).map(t => t.name)
    expect(names).toEqual(['ListMcpResources', 'ReadMcpResource', 'WaitForMcpServers'])
  })
})
