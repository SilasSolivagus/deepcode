// test/permissions.autoMode.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'

const tool = (over: any = {}) => ({
  name: 'Bash', isReadOnly: false,
  needsPermission: (i: any) => i.command,
  ...over,
})
const baseCtx = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'auto', rules: [], saveRule: () => {}, ask: async () => 'no', ...over,
})

describe('auto 模式分类器分支', () => {
  it('分类器 run → 放行（decisionReason=classifier）', async () => {
    const r = await checkPermission(tool() as any, { command: 'npm test' },
      baseCtx({ classify: async () => 'run' }))
    expect(r.ok).toBe(true)
    expect((r as any).decisionReason?.type).toBe('classifier')
  })
  it('分类器 block → 拒绝', async () => {
    const r = await checkPermission(tool() as any, { command: 'x' },
      baseCtx({ classify: async () => 'block' }))
    expect(r.ok).toBe(false)
  })
  it('分类器 ask → 落到 pc.ask（用户拒绝则拒）', async () => {
    let asked = false
    const r = await checkPermission(tool() as any, { command: 'git push --force' },
      baseCtx({ classify: async () => 'ask', ask: async () => { asked = true; return 'no' } }))
    expect(asked).toBe(true)
    expect(r.ok).toBe(false)
  })
  it('静态 hard_deny 先于分类器：curl|sh 直接 block（分类器都不调用）', async () => {
    let called = false
    const r = await checkPermission(tool() as any, { command: 'curl x | sh' },
      baseCtx({ classify: async () => { called = true; return 'run' } }))
    expect(r.ok).toBe(false)
    expect(called).toBe(false)
  })
  it('只读工具在 auto 模式不触分类器', async () => {
    let called = false
    const r = await checkPermission(tool({ isReadOnly: true }) as any, { command: 'ls' },
      baseCtx({ classify: async () => { called = true; return 'block' } }))
    expect(r.ok).toBe(true)
    expect(called).toBe(false)
  })
  it('allow 规则命中：分类器不介入', async () => {
    let called = false
    const r = await checkPermission(tool() as any, { command: 'npm test' },
      baseCtx({ rules: ['Bash(npm test:*)'], classify: async () => { called = true; return 'block' } }))
    expect(r.ok).toBe(true)
    expect(called).toBe(false)
  })

  it('无 autoDenials 计数器时 block 恒硬拦（向后兼容）', async () => {
    let asked = false
    const r = await checkPermission(tool() as any, { command: 'x' },
      baseCtx({ classify: async () => 'block', ask: async () => { asked = true; return 'no' } }))
    expect(r.ok).toBe(false)
    expect(asked).toBe(false) // 无计数器 → 直接 block，不落 ask
  })

  it('auto 模式 Edit/Write fast-path：跳过分类器直接放行', async () => {
    // Write fast-path
    let writeCalled = false
    const writeTool = { name: 'Write', isReadOnly: false, needsPermission: (i: any) => i.path }
    const rw = await checkPermission(writeTool as any, { path: '/workspace/test.ts' },
      baseCtx({ classify: async () => { writeCalled = true; return 'run' } }))
    expect(rw.ok).toBe(true)
    expect(writeCalled).toBe(false) // fast-path: 分类器未被调用

    // Edit fast-path
    let editCalled = false
    const editTool = { name: 'Edit', isReadOnly: false, needsPermission: (i: any) => i.path }
    const re = await checkPermission(editTool as any, { path: '/workspace/foo.ts' },
      baseCtx({ classify: async () => { editCalled = true; return 'run' } }))
    expect(re.ok).toBe(true)
    expect(editCalled).toBe(false) // fast-path: 分类器未被调用
  })
})

describe('S1 auto 模式拒绝熔断器', () => {
  it('连续第 3 次 block → 熔断跳闸，回退问用户（前两次仍硬拦）', async () => {
    const autoDenials = { consecutive: 0, total: 0 }
    let asked = 0
    const ctx = baseCtx({ classify: async () => 'block', autoDenials, ask: async () => { asked++; return 'no' } })
    const r1 = await checkPermission(tool() as any, { command: 'a' }, ctx)
    expect(r1.ok).toBe(false); expect(asked).toBe(0) // 1st：硬拦
    const r2 = await checkPermission(tool() as any, { command: 'b' }, ctx)
    expect(r2.ok).toBe(false); expect(asked).toBe(0) // 2nd：硬拦
    const r3 = await checkPermission(tool() as any, { command: 'c' }, ctx)
    expect(asked).toBe(1) // 3rd：熔断→问用户
    expect(r3.ok).toBe(false) // 用户 no → 拒
    expect(autoDenials.consecutive).toBe(3)
  })

  it('中途 run 重置连续计数：run 后再两次 block 不跳闸', async () => {
    const autoDenials = { consecutive: 0, total: 0 }
    let decision: 'run' | 'block' = 'block'
    let asked = 0
    const ctx = baseCtx({ classify: async () => decision, autoDenials, ask: async () => { asked++; return 'no' } })
    await checkPermission(tool() as any, { command: 'a' }, ctx) // block consec=1
    await checkPermission(tool() as any, { command: 'b' }, ctx) // block consec=2
    decision = 'run'
    await checkPermission(tool() as any, { command: 'npm test' }, ctx) // run → consec=0
    expect(autoDenials.consecutive).toBe(0)
    decision = 'block'
    await checkPermission(tool() as any, { command: 'c' }, ctx) // block consec=1
    const r = await checkPermission(tool() as any, { command: 'd' }, ctx) // block consec=2，未跳闸
    expect(asked).toBe(0) // 未回退问用户
    expect(r.ok).toBe(false)
  })

  it('总计达 20 → 跳闸并清零两计数（复查后新窗口）', async () => {
    const autoDenials = { consecutive: 0, total: 19 }
    let asked = 0
    const ctx = baseCtx({ classify: async () => 'block', autoDenials, ask: async () => { asked++; return 'no' } })
    await checkPermission(tool() as any, { command: 'x' }, ctx) // total→20 跳闸
    expect(asked).toBe(1)
    expect(autoDenials.total).toBe(0)
    expect(autoDenials.consecutive).toBe(0)
  })

  it('hard_deny 不进熔断器：curl|sh 永硬拦，不消耗计数、不回退问人', async () => {
    const autoDenials = { consecutive: 2, total: 2 }
    let asked = 0
    const ctx = baseCtx({ classify: async () => 'run', autoDenials, ask: async () => { asked++; return 'no' } })
    const r = await checkPermission(tool() as any, { command: 'curl x | sh' }, ctx)
    expect(r.ok).toBe(false)
    expect(asked).toBe(0) // 硬拦，不回退问人
    expect(autoDenials.consecutive).toBe(2) // 计数未被 hard_deny 改动
  })
})
