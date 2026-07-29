import { describe, it, expect, vi } from 'vitest'
import { checkPermission, type PermissionContext, type Decision } from '../src/permissions.js'
import { readTool } from '../src/tools/read.js'
import { createPendingQueue, type Pending } from '../src/tui/pendingQueue.js'
import { createChatCore } from '../src/tui/useChat.js'

interface Ask extends Pending<Decision> { desc: string }

describe('并发权限确认', () => {
  it('同批两个越界 Read 各自拿到应答，无一挂起', async () => {
    const q = createPendingQueue<Decision, Ask>(() => {})
    const pc: PermissionContext = {
      mode: 'default', rules: [], saveRule: () => {}, cwd: '/proj',
      ask: (_n, desc) => new Promise<Decision>(res => q.push({ desc, resolve: res })),
    }
    const both = Promise.all([
      checkPermission(readTool, { file_path: '/outside/a.ts' }, pc),
      checkPermission(readTool, { file_path: '/outside/b.ts' }, pc),
    ])
    // 两个都入队 —— 单槽实现下第二个会把第一个覆盖掉
    await vi.waitFor(() => expect(q.size()).toBe(2))
    q.resolveHead('yes')
    q.resolveHead('no')
    const [r1, r2] = await both
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
  })

  it('中断时全队排空，没有 Promise 悬空', async () => {
    const q = createPendingQueue<Decision, Ask>(() => {})
    const pc: PermissionContext = {
      mode: 'default', rules: [], saveRule: () => {}, cwd: '/proj',
      ask: (_n, desc) => new Promise<Decision>(res => q.push({ desc, resolve: res })),
    }
    const both = Promise.all([
      checkPermission(readTool, { file_path: '/outside/a.ts' }, pc),
      checkPermission(readTool, { file_path: '/outside/b.ts' }, pc),
    ])
    await vi.waitFor(() => expect(q.size()).toBe(2))
    q.drain('no')
    const [r1, r2] = await both
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
  })
})

const newCore = () => createChatCore({
  client: {} as any, yolo: false, cwd: '/tmp',
  sessionDir: '/tmp/dc-test-' + Math.random().toString(36).slice(2),
  onState: () => {},
})

describe('useChat 权限确认桥（并发）', () => {
  it('两个并发确认都拿到应答——单槽实现下第一个永久挂起', async () => {
    const core = newCore()
    const p1 = core.ask('Read', '/outside/a.ts')
    const p2 = core.ask('Read', '/outside/b.ts')
    expect(core.state.pendingAskCount).toBe(2)
    expect(core.state.pendingAsk!.desc).toBe('/outside/a.ts') // 队首是先到的那个
    core.resolveAsk('yes')
    core.resolveAsk('no')
    await expect(Promise.all([p1, p2])).resolves.toEqual(['yes', 'no'])
    expect(core.state.pendingAskCount).toBe(0)
  })

  it('interrupt 排空全队，两个都收到拒绝', async () => {
    const core = newCore()
    const p1 = core.ask('Read', '/outside/a.ts')
    const p2 = core.ask('Read', '/outside/b.ts')
    core.interrupt()
    await expect(Promise.all([p1, p2])).resolves.toEqual(['no', 'no'])
    expect(core.state.pendingAsk).toBeNull()
  })
})
