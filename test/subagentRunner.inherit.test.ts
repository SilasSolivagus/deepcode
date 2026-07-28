import { describe, it, expect } from 'vitest'
import { checkPermission, type PermissionSnapshot } from '../src/permissions.js'
import type { ToolContext } from '../src/tools/types.js'

// 直接驱动 subagentRunner 导出的真实组装函数——不复刻，否则实现改了测试也发现不了。
import { buildSubagentPermission } from '../src/subagentRunner.js'
const subagentPc = (parent: PermissionSnapshot | undefined, fenceRoot: string) =>
  buildSubagentPermission(parent, fenceRoot)

const readTool = (file: string): any => ({
  name: 'Read', isReadOnly: true,
  needsPermission: () => `read ${file}`,
  deniablePaths: () => [file],
})
const writeTool = (file: string): any => ({
  name: 'Write', isReadOnly: false,
  needsPermission: () => `write ${file}`,
  deniablePaths: () => [file],
  workspacePaths: () => [file],
})
const bashTool = (cmd: string): any => ({
  name: 'Bash', isReadOnly: false,
  needsPermission: () => cmd,
  deniablePaths: () => [],
})

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

describe('子代理继承安全约束 · 对抗性实跑', () => {
  const parent: PermissionSnapshot = {
    mode: 'default',
    rules: [],
    deny: ['**/id_rsa', '**/.aws/credentials'],
  }

  it('攻击：子代理读 ~/.ssh/id_rsa → 被 deny 拦', async () => {
    const r = await checkPermission(readTool('/home/u/.ssh/id_rsa'), {}, subagentPc(parent, '/repo'))
    expect(r.ok).toBe(false)
  })

  it('攻击：子代理读 ~/.aws/credentials → 被 deny 拦', async () => {
    const r = await checkPermission(readTool('/home/u/.aws/credentials'), {}, subagentPc(parent, '/repo'))
    expect(r.ok).toBe(false)
  })

  it('攻击：子代理 rm -rf / → 被 S4 守卫拦（语义反转回归）', async () => {
    const r = await checkPermission(bashTool('rm -rf /'), {}, subagentPc(parent, '/repo'))
    expect(r.ok).toBe(false)
  })

  it('攻击：子代理写围栏外路径 → 被工作目录围栏拦', async () => {
    const r = await checkPermission(writeTool('/home/u/.ssh/authorized_keys'), {}, subagentPc(parent, '/repo'))
    expect(r.ok).toBe(false)
  })

  it('回归：子代理写围栏内路径 → 正常放行（不打断现有能力）', async () => {
    const r = await checkPermission(writeTool('/repo/src/a.ts'), {}, subagentPc(parent, '/repo'))
    expect(r.ok).toBe(true)
  })

  it('worktree 子代理：fenceRoot 取 worktreePath，写 worktree 内放行、写主仓被拦', async () => {
    const wt = '/repo/.deepcode/worktrees/agent-1'
    expect((await checkPermission(writeTool(`${wt}/x.ts`), {}, subagentPc(parent, wt))).ok).toBe(true)
    expect((await checkPermission(writeTool('/repo/src/a.ts'), {}, subagentPc(parent, wt))).ok).toBe(false)
  })

  it('拿不到父快照时回落到当前行为，不放宽', async () => {
    const bare: PermissionSnapshot = { mode: 'default', rules: [] }
    const r = await checkPermission(bashTool('sudo rm -rf /etc'), {}, subagentPc(bare, '/repo'))
    expect(r.ok).toBe(false) // isDangerous 兜底
  })
})
