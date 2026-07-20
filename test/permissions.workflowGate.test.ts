import { describe, it, expect, vi } from 'vitest'
import { checkPermission } from '../src/permissions.js'

const wfTool = (warn: string | false) => ({
  name: 'Workflow', isReadOnly: true,
  needsPermission: () => warn,
} as any)

function pc(over: any = {}) {
  return {
    mode: 'default' as const, rules: [], deny: [],
    saveRule: vi.fn(), ask: vi.fn(async () => 'yes' as const),
    ...over,
  }
}

describe('B7 workflow 用量同意门', () => {
  it('未跳过警告 → 即便 isReadOnly 也弹 ask（破短路）', async () => {
    const ask = vi.fn(async () => 'yes' as const)
    const r = await checkPermission(wfTool('会消耗大量 token'), {}, pc({ ask }))
    expect(ask).toHaveBeenCalledOnce()
    expect(r.ok).toBe(true)
  })

  it('ask 返回 no → 拒绝', async () => {
    const r = await checkPermission(wfTool('警告'), {}, pc({ ask: async () => 'no' }))
    expect(r.ok).toBe(false)
  })

  it('ask 返回 always → 放行并持久化 skipWorkflowUsageWarning', async () => {
    const setSkip = vi.fn()
    const r = await checkPermission(wfTool('警告'), {}, pc({ ask: async () => 'always', setSkipWorkflowWarning: setSkip }))
    expect(r.ok).toBe(true)
    expect(setSkip).toHaveBeenCalledOnce()
  })

  it('needsPermission 返 false（已跳过）→ isReadOnly 直接放行，不 ask', async () => {
    const ask = vi.fn(async () => 'yes' as const)
    const r = await checkPermission(wfTool(false), {}, pc({ ask }))
    expect(ask).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('回归（headless/后台真实场景）：needsPermission=false + ask 桩恒 no（无人值守默认拒绝）→ 仍放行且从不调用 ask', async () => {
    // 复现 headless.ts / backgroundRunner.ts 的真实接线：ask: async () => 'no'。
    // 若 B7 门未被短路跳过而误触发 ask，会被这个恒 'no' 的桩 100% 拒绝——这正是被修复的回归。
    const ask = vi.fn(async () => 'no' as const)
    const r = await checkPermission(wfTool(false), {}, pc({ ask }))
    expect(ask).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('回归：非 Workflow 的 isReadOnly 工具仍短路放行不 ask', async () => {
    const ask = vi.fn(async () => 'yes' as const)
    const read = { name: 'Read', isReadOnly: true, needsPermission: () => false } as any
    const r = await checkPermission(read, {}, pc({ ask }))
    expect(ask).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })
})
