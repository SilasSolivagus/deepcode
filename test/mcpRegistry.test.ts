import { describe, it, expect, vi } from 'vitest'
import { createMcpRegistry } from '../src/mcpRegistry.js'

const cfg = { command: 'x' } as any
const caller = { getServerCapabilities: () => ({}), listResources: async () => ({ resources: [] }), readResource: async () => ({ contents: [] }) }

describe('createMcpRegistry', () => {
  it('seedPending 后 pending() 与 list() 反映 pending 状态', () => {
    const r = createMcpRegistry()
    expect(r.hasServers()).toBe(false)
    r.seedPending('A', cfg)
    r.seedPending('B', cfg)
    expect(r.hasServers()).toBe(true)
    expect(r.pending().map(s => s.name).sort()).toEqual(['A', 'B'])
    expect(r.connectedCallers()).toEqual([])
  })

  it('markConnected 迁移状态并暴露 caller，pending() 不再含它', () => {
    const r = createMcpRegistry()
    r.seedPending('A', cfg)
    r.markConnected('A', caller as any)
    expect(r.pending()).toEqual([])
    expect(r.connectedCallers()).toEqual([{ name: 'A', caller }])
    expect(r.list().find(s => s.name === 'A')!.status).toBe('connected')
  })

  it('markFailed 记录错误，不出现在 pending/connectedCallers', () => {
    const r = createMcpRegistry()
    r.seedPending('A', cfg)
    r.markFailed('A', 'boom')
    expect(r.pending()).toEqual([])
    expect(r.connectedCallers()).toEqual([])
    const s = r.list().find(x => x.name === 'A')!
    expect(s.status).toBe('failed')
    expect(s.error).toBe('boom')
  })

  it('subscribe 在每次状态变更时触发，unsubscribe 后不再触发', () => {
    const r = createMcpRegistry()
    const cb = vi.fn()
    const off = r.subscribe(cb)
    r.seedPending('A', cfg)
    r.markConnected('A', caller as any)
    expect(cb).toHaveBeenCalledTimes(2)
    off()
    r.markFailed('A', 'x')
    expect(cb).toHaveBeenCalledTimes(2)
  })
})
