// test/permissions.dontAsk.test.ts
import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { bashTool } from '../src/tools/bash.js'
import { readTool } from '../src/tools/read.js'
import { writeTool } from '../src/tools/write.js'

const pc = (over: Partial<PermissionContext> = {}): PermissionContext => ({
  mode: 'dontAsk', rules: [], saveRule: () => {}, ask: async () => 'no', cwd: '/proj', ...over,
})

describe('dontAsk 模式', () => {
  it('只读工具放行（不弹窗）', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/proj/a.ts' }, pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(r.ok).toBe(true); expect(asked).toBe(false)
  })
  it('写工具无规则 → 自动 deny，不弹窗，归因 mode', async () => {
    let asked = false
    const r = await checkPermission(writeTool, { file_path: '/proj/a.ts', content: 'x' },
      pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.decisionReason).toEqual({ type: 'mode', mode: 'dontAsk' })
    expect((r as any).reason).toContain('Shift+Tab')
  })
  it('Bash 有 allow 规则 → 放行（预批准）', async () => {
    const r = await checkPermission(bashTool, { command: 'ls' }, pc({ rules: ['Bash(ls)'] }))
    expect(r.ok).toBe(true)
  })
  it('Bash 无规则 → deny', async () => {
    const r = await checkPermission(bashTool, { command: 'npm publish' }, pc())
    expect(r.ok).toBe(false)
  })
  it('deny 规则命中 → deny（deny>mode，非 mode 归因）', async () => {
    const r = await checkPermission(readTool, { file_path: '/proj/id_rsa' }, pc({ deny: ['**/id_rsa'] }))
    expect(r.ok).toBe(false)
    expect(r.decisionReason).not.toMatchObject({ type: 'mode' })
    expect(r.decisionReason).toMatchObject({ type: 'rule', rule: { behavior: 'deny' } })
  })
  it('ask 规则命中 → deny（本该弹窗被翻成 deny）', async () => {
    let asked = false
    const r = await checkPermission(bashTool, { command: 'rm foo' },
      pc({ askRules: ['Bash(rm:*)'], ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(false); expect(r.ok).toBe(false)
    expect(r.decisionReason).toEqual({ type: 'mode', mode: 'dontAsk' })
  })
  it('onRequest hook 显式 allow → 放行（hook 覆盖 mode）', async () => {
    const r = await checkPermission(writeTool, { file_path: '/proj/a.ts', content: 'x' }, pc(),
      { onRequest: async () => ({ permission: 'allow' }) as any })
    expect(r.ok).toBe(true)
  })
  it('工作目录围栏在 dontAsk 下越界 Read → deny，不弹窗', async () => {
    let asked = false
    const r = await checkPermission(readTool, { file_path: '/etc/passwd' },
      pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.decisionReason).toEqual({ type: 'mode', mode: 'dontAsk' })
  })
  it('Workflow 用量门在 dontAsk 下 → deny，不弹窗', async () => {
    let asked = false
    const wfTool = { name: 'Workflow', isReadOnly: true, needsPermission: () => '会消耗大量 token' } as any
    const r = await checkPermission(wfTool, {}, pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.decisionReason).toEqual({ type: 'mode', mode: 'dontAsk' })
  })
  it('非哨兵异常照常抛出（catch 只吞 DontAskDeny）', async () => {
    await expect(checkPermission(bashTool, { command: 'npm publish' },
      pc({ mode: 'default', ask: async () => { throw new Error('boom') } })))
      .rejects.toThrow('boom')
  })
  it('S4 危删守卫在 dontAsk 下 → deny，不弹窗', async () => {
    let asked = false
    const r = await checkPermission(bashTool, { command: 'rm -rf /' },
      pc({ ask: async () => { asked = true; return 'yes' } }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(false)
    expect(r.decisionReason).toEqual({ type: 'mode', mode: 'dontAsk' })
  })
})
