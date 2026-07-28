import { describe, it, expect } from 'vitest'
import { checkPermission, YOLO_DANGEROUS_CONFIRM_REASON, type PermissionContext, type Decision, type PermissionDecisionReason } from '../src/permissions.js'

const fakeTool = (name: string, isReadOnly: boolean, desc: false | string = 'x'): any => ({
  name, isReadOnly, needsPermission: () => desc,
})

function pc(over: Partial<PermissionContext> = {}): PermissionContext {
  return { mode: 'default', rules: [], saveRule: () => {}, ask: async () => 'no' as Decision, ...over }
}

describe('yolo 危险命令门', () => {
  it('yolo 下危险命令强制弹窗，用户拒绝则拒', async () => {
    let asked = false
    const r = await checkPermission(fakeTool('Bash', false, 'dd if=/dev/zero of=/dev/sda'), {}, pc({
      mode: 'yolo',
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(true)
    expect(r.ok).toBe(false)
  })

  it('yolo 下危险命令带结构化 reason（供无人值守侧识别）', async () => {
    let seen: PermissionDecisionReason | undefined
    await checkPermission(fakeTool('Bash', false, 'mkfs.ext4 /dev/sdb1'), {}, pc({
      mode: 'yolo',
      ask: async (_n, _d, reason) => { seen = reason; return 'no' as Decision },
    }))
    expect(seen).toEqual({ type: 'other', reason: YOLO_DANGEROUS_CONFIRM_REASON })
  })

  it('yolo 下用户放行则放行，但不写规则', async () => {
    let saved: string | null = null
    const r = await checkPermission(fakeTool('Bash', false, 'sudo chown -R root /etc'), {}, pc({
      mode: 'yolo',
      ask: async () => 'always' as Decision,
      saveRule: (rule: string) => { saved = rule },
    }))
    expect(r.ok).toBe(true)
    expect(saved).toBeNull() // always 也不固化危险命令
  })

  it('yolo 下普通命令仍然零弹窗放行（不打废 yolo）', async () => {
    let asked = false
    const r = await checkPermission(fakeTool('Bash', false, 'npm test'), {}, pc({
      mode: 'yolo',
      ask: async () => { asked = true; return 'no' as Decision },
    }))
    expect(asked).toBe(false)
    expect(r.ok).toBe(true)
  })
})
