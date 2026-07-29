// 子代理权限确认向上转发：改造前子代理由本地启发式拍板（非危险命令一律自动 'yes'），
// 而同环境的无人值守主代理 ask 恒 'no' —— 派个子代理就把「默认拒绝」变成「默认放行」。
// 本文件锁住转发后的三档行为：安全门/危险命令仍硬拒，其余转发，askUp 缺失则硬拒（不回落旧启发式）。
import { describe, it, expect } from 'vitest'
import { buildSubagentPermission } from '../src/subagentRunner.js'
import type { Decision } from '../src/permissions.js'
import { WORKSPACE_FENCE_REASON } from '../src/permissions.js'

describe('子代理 ask 向上转发', () => {
  it('普通确认转发到 askUp，参数完整传递', async () => {
    const seen: unknown[] = []
    const askUp = async (t: string, d: string, r?: unknown, p?: string): Promise<Decision> => {
      seen.push([t, d, r, p]); return 'yes'
    }
    const pc = buildSubagentPermission(undefined, '/proj', askUp)
    const d = await pc.ask('Bash', 'ls -la', undefined, 'Bash(ls:*)')
    expect(d).toBe('yes')
    expect(seen).toEqual([['Bash', 'ls -la', undefined, 'Bash(ls:*)']])
  })

  it('askUp 缺失 → 硬拒，不回落旧启发式的自动放行', async () => {
    const pc = buildSubagentPermission(undefined, '/proj')
    expect(await pc.ask('Bash', 'ls -la')).toBe('no')
  })

  it('安全门不经转发，直接硬拒', async () => {
    let forwarded = false
    const askUp = async (): Promise<Decision> => { forwarded = true; return 'yes' }
    const pc = buildSubagentPermission(undefined, '/proj', askUp)
    const d = await pc.ask('Read', '/etc/passwd', { type: 'other', reason: WORKSPACE_FENCE_REASON })
    expect(d).toBe('no')
    expect(forwarded).toBe(false)
  })

  it('危险命令不经转发，直接硬拒（不放宽）', async () => {
    let forwarded = false
    const askUp = async (): Promise<Decision> => { forwarded = true; return 'yes' }
    const pc = buildSubagentPermission(undefined, '/proj', askUp)
    const d = await pc.ask('Bash', 'rm -rf /')
    expect(d).toBe('no')
    expect(forwarded).toBe(false)
  })

  it('origin 随转发带到顶层，供 UI 标注来源', async () => {
    let seenOrigin: unknown
    const askUp = async (_t: string, _d: string, _r?: unknown, _p?: string, origin?: unknown): Promise<Decision> => {
      seenOrigin = origin; return 'yes'
    }
    const pc = buildSubagentPermission(undefined, '/proj', askUp, { agentId: 'ag_1', agentType: 'Explore' })
    await pc.ask('Bash', 'ls')
    expect(seenOrigin).toEqual({ agentId: 'ag_1', agentType: 'Explore' })
  })

  // 回归 1.2：改造前 headless 主代理 ask 恒 'no'，而同环境子代理对非危险命令返回 'yes'。
  it('无人值守下子代理不再比主代理宽松', async () => {
    const unattendedAsk = async (): Promise<Decision> => 'no' // headless.ts / backgroundRunner.ts 的主代理实现
    const pc = buildSubagentPermission(undefined, '/proj', unattendedAsk)
    for (const desc of ['ls -la', 'cat package.json', 'npm test']) {
      expect(await pc.ask('Bash', desc)).toBe(await unattendedAsk())
    }
  })
})
