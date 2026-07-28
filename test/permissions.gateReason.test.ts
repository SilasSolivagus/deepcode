import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext, type Decision, type PermissionDecisionReason } from '../src/permissions.js'

const fakeTool = (name: string, isReadOnly: boolean, desc: false | string = 'x'): any => ({
  name,
  isReadOnly,
  needsPermission: () => desc,
})

function pc(over: Partial<PermissionContext> = {}): PermissionContext {
  return { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' as Decision, ...over }
}

describe('网关来源可识别化', () => {
  it('工作目录围栏触发时，ask 收到结构化 reason', async () => {
    let seen: PermissionDecisionReason | undefined
    const tool = {
      ...fakeTool('Write', false, 'write /etc/passwd'),
      workspacePaths: () => ['/etc/passwd'],
    }
    await checkPermission(tool, {}, pc({
      cwd: '/repo',
      ask: async (_n, _d, reason) => { seen = reason; return 'no' as Decision },
    }))
    expect(seen).toEqual({ type: 'other', reason: '工作目录围栏' })
  })

  it('auto 分类器判 ask → 尾部 ask 收到 classifier 来源', async () => {
    let seen: PermissionDecisionReason | undefined
    await checkPermission(fakeTool('Bash', false, 'echo hi'), {}, pc({
      mode: 'auto',
      classify: async () => 'ask',
      ask: async (_n, _d, reason) => { seen = reason; return 'no' as Decision },
    }))
    expect(seen).toEqual({ type: 'classifier', decision: 'ask' })
  })

  it('无网关的常规审批：reason 仍为 undefined（不制造假来源）', async () => {
    let seen: PermissionDecisionReason | undefined = { type: 'other', reason: 'sentinel' }
    await checkPermission(fakeTool('Bash', false, 'echo hi'), {}, pc({
      ask: async (_n, _d, reason) => { seen = reason; return 'no' as Decision },
    }))
    expect(seen).toBeUndefined()
  })
})
