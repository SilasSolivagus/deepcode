import { describe, it, expect, vi } from 'vitest'
import { startMcpConnections, initMcpTools } from '../src/mcp.js'
import { createMcpRegistry } from '../src/mcpRegistry.js'

const caller = { getServerCapabilities: () => ({ resources: {} }), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) }
const fakeTool = (name: string) => ({ name, description: '', inputSchema: {} as any, isReadOnly: true, needsPermission: () => false, call: async () => '' })

describe('startMcpConnections', () => {
  it('慢 server 不阻塞快 server：快的先热插工具，且不整体 await', async () => {
    const registry = createMcpRegistry()
    const tools: any[] = []
    let releaseSlow!: () => void
    const slow = new Promise<void>(r => { releaseSlow = r })
    const connect = vi.fn(async (name: string) => {
      if (name === 'slow') { await slow; return { tools: [fakeTool('mcp__slow__x')], close: async () => {}, caller } }
      return { tools: [fakeTool('mcp__fast__y')], close: async () => {}, caller }
    })
    startMcpConnections(tools, { fast: { command: 'a' } as any, slow: { command: 'b' } as any }, registry, { connect: connect as any })
    // 三个资源工具立即追加（servers 非空）
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['ListMcpResources', 'ReadMcpResource', 'WaitForMcpServers']))
    // 两者初始 pending
    expect(registry.pending().map(s => s.name).sort()).toEqual(['fast', 'slow'])
    // 等 fast 连上（微任务），slow 仍挂起
    await vi.waitFor(() => expect(tools.some(t => t.name === 'mcp__fast__y')).toBe(true))
    expect(registry.list().find(s => s.name === 'fast')!.status).toBe('connected')
    expect(registry.list().find(s => s.name === 'slow')!.status).toBe('pending')
    expect(tools.some(t => t.name === 'mcp__slow__x')).toBe(false)
    releaseSlow()
    await vi.waitFor(() => expect(registry.list().find(s => s.name === 'slow')!.status).toBe('connected'))
  })

  it('server 连接失败 → markFailed + onWarn，不抛不影响别的', async () => {
    const registry = createMcpRegistry()
    const tools: any[] = []
    const onWarn = vi.fn()
    const connect = vi.fn(async (name: string) => { if (name === 'bad') throw new Error('spawn fail'); return { tools: [fakeTool('mcp__ok__z')], close: async () => {}, caller } })
    startMcpConnections(tools, { bad: { command: 'a' } as any, ok: { command: 'b' } as any }, registry, { connect: connect as any, onWarn })
    await vi.waitFor(() => expect(registry.list().find(s => s.name === 'bad')!.status).toBe('failed'))
    expect(onWarn).toHaveBeenCalled()
    expect(registry.list().find(s => s.name === 'ok')!.status).toBe('connected')
  })

  it('无 server：不追加资源工具，cleanup 无操作', async () => {
    const registry = createMcpRegistry()
    const tools: any[] = []
    const cleanup = startMcpConnections(tools, undefined, registry, {})
    expect(tools).toEqual([])
    await cleanup()
  })

  it('initMcpTools 填 registry 并在 tools 追加资源工具（阻塞路径）', async () => {
    const registry = createMcpRegistry()
    const connect = vi.fn(async () => ({ tools: [fakeTool('mcp__s__t')], close: async () => {}, caller }))
    const { tools } = await initMcpTools({ s: { command: 'a' } as any }, { connect: connect as any, registry })
    expect(registry.list().find(x => x.name === 's')!.status).toBe('connected')
    expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['mcp__s__t', 'ListMcpResources', 'ReadMcpResource', 'WaitForMcpServers']))
  })
})
