import { describe, it, expect } from 'vitest'
import type { PermissionSnapshot } from '../src/permissions.js'
import type { ToolContext } from '../src/tools/types.js'

describe('PermissionSnapshot 注入通道', () => {
  it('ToolContext 可携带 parentPermission，返回只读安全约束快照', () => {
    const snap: PermissionSnapshot = {
      mode: 'default',
      rules: ['Bash(ls:*)'],
      deny: ['**/id_rsa'],
      askRules: ['Bash(git push:*)'],
      additionalDirs: ['/tmp/extra'],
    }
    const ctx = { parentPermission: () => snap } as unknown as ToolContext
    const got = ctx.parentPermission!()
    expect(got.deny).toEqual(['**/id_rsa'])
    expect(got.askRules).toEqual(['Bash(git push:*)'])
    // 快照不得暴露写入口
    expect('saveRule' in got).toBe(false)
    expect('ask' in got).toBe(false)
  })
})
