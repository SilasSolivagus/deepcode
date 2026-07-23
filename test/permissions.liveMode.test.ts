import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionContext } from '../src/permissions.js'
import { writeTool } from '../src/tools/write.js'

describe('权限 mode 活读（getter 语义，非一次性快照）', () => {
  it('同一 PermissionContext 上 mode 变更即刻影响后续 checkPermission', async () => {
    let mode: PermissionContext['mode'] = 'plan'
    const pc: PermissionContext = {
      get mode() { return mode },
      rules: [], saveRule: () => {}, ask: async () => 'yes', cwd: process.cwd(),
    }
    const r1 = await checkPermission(writeTool, { file_path: 'a.txt', content: 'x' }, pc)
    expect(r1.ok).toBe(false)          // plan 门拒非只读
    mode = 'acceptEdits'
    const r2 = await checkPermission(writeTool, { file_path: 'a.txt', content: 'x' }, pc)
    expect(r2.ok).toBe(true)           // acceptEdits 放行 Write，证明活读
  })
})
