import { describe, it, expect, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { checkPermission, type PermissionSnapshot } from '../src/permissions.js'
import type { Tool, ToolContext } from '../src/tools/types.js'

// 直接驱动 subagentRunner 导出的真实组装函数——不复刻，否则实现改了测试也发现不了。
import { buildSubagentPermission, runSubagent } from '../src/subagentRunner.js'
const subagentPc = (parent: PermissionSnapshot | undefined, fenceRoot: string) =>
  buildSubagentPermission(parent, fenceRoot)

// mock chatStream：驱动真实 runSubagent → runLoop，实跑权限检查（非空壳）。
// 第一轮 yield 对 stub 工具的 tool_call，第二轮 yield 纯文本终止子循环。
let chatCalls = 0
let lastToolCallName = ''
vi.mock('../src/api.js', () => ({
  async *chatStream() {
    chatCalls++
    if (chatCalls === 1) {
      return {
        content: '', finishReason: 'tool_calls',
        usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
        toolCalls: [{ id: 'c1', name: lastToolCallName, args: '{}' }],
      }
    }
    yield { type: 'text', delta: 'done' }
    return {
      content: 'done', finishReason: 'stop',
      usage: { prompt_tokens: 0, completion_tokens: 0, prompt_cache_hit_tokens: 0 },
      toolCalls: [],
    }
  },
}))

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
    cwd: '/repo', // 补上：不影响本组用例语义（buildSubagentPermission 返回的 pc.cwd 恒取调用方传入的
    // fenceRoot 而非 parent.cwd，这里只是避免触发"父快照缺 cwd"告警噪音，淹没真实的第四注入点信号）
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
    const r = await checkPermission(bashTool('sudo rm -rf /etc'), {}, subagentPc(undefined, '/repo'))
    expect(r.ok).toBe(false) // isDangerous 兜底
  })
})

describe('跨层子代理围栏逃逸 · 孙代理不得继承已漂移的 cwd', () => {
  afterEach(() => { chatCalls = 0; lastToolCallName = '' })

  // stub 写工具：只有真被 tool.call 执行才会置位，用来反证权限层是否放行。
  const mkWriteStub = (seen: { called: boolean }): Tool => ({
    name: 'Write',
    description: 'write',
    inputSchema: z.object({}),
    isReadOnly: false,
    needsPermission: () => 'write /etc/evil',
    deniablePaths: () => ['/etc/evil'],
    workspacePaths: () => ['/etc/evil'],
    call: async () => { seen.called = true; return 'ok' },
  })

  it('调用方（子代理 A）ctx.cwd() 已被自身 cd 漂移到 /，但 ctx.fenceRoot 仍是 /repo → 新派子代理（孙代理 B）的围栏根须取 /repo，写 /etc/evil 被拒', async () => {
    // 模拟子代理 A 的 subCtx：cwd() 被 A 内部 `cd /` 漂移，但 fenceRoot 是构造时定死、不随之漂移的量。
    const driftedParentCtx: ToolContext = {
      cwd: () => '/', // 已漂移
      setCwd: () => {},
      get signal() { return new AbortController().signal },
      fileState: new Map(),
      fenceRoot: '/repo', // A 自身不可变的围栏根
      // cwd 补个占位值：本用例验证的是 ctx.fenceRoot 优先于 parentPerm.cwd（漂移场景），
      // 加不加都不影响这条断言，纯为避免触发"父快照缺 cwd"告警噪音。
      parentPermission: () => ({ mode: 'default', rules: [], cwd: '/repo' }),
    } as any

    const seen = { called: false }
    lastToolCallName = 'Write'
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [mkWriteStub(seen)], model: 'm', ctx: driftedParentCtx, signal: new AbortController().signal,
      agentId: 'grandchild', agentType: 'general-purpose',
    })
    // 若 fenceRoot 逃逸取到了漂移后的 '/'，isInsideWorkspace(p, ['/']) 对任何路径恒真，写会被放行、call 会执行。
    expect(seen.called).toBe(false)
  })
})
