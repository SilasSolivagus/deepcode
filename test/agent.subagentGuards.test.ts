import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MAX_SUBAGENT_DEPTH } from '../src/tools/agent.js'
import { clearAllTasks, drainNotifications, listTasks, getTask } from '../src/tasks.js'

// 真实执行路径需要 chatStream 桩（子代理跑的是 runLoop，会真的调 chatStream）。
const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

import { makeAgentTool } from '../src/tools/agent.js'

const usage = { prompt_tokens: 30, completion_tokens: 10, prompt_cache_hit_tokens: 0 }
const ctx = (overrides: any = {}): any => ({
  cwd: () => process.cwd(), setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
  ...overrides,
})

/** 让脱钩的后台 async 跑完：轮询直到任务进入终态（或超时）。避免任务句柄悬挂污染下一个用例。 */
async function waitForDone(id: string): Promise<void> {
  // ⚠️ 预算必须按**墙钟**算，不能按 tick 数。原来是 200 次 setTimeout(r, 0)——Node 会把 0
  // 钳到约 1ms，于是实际预算只有约 200ms，而这里等的是一次真实的 git worktree 创建
  // （init + add + commit + worktree add）。全量并发跑时 git 轻松超过 200ms，表现为与本用例
  // 逻辑无关的偶发超时。实测 6 次全量里挂 3 次，这是其中一种。
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const t = getTask(id)
    if (t && t.status !== 'running') return
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('timeout waiting for task done')
}

beforeEach(() => { script.length = 0; vi.clearAllMocks(); clearAllTasks(); drainNotifications() })

describe('子代理嵌套守卫', () => {
  it('深度上限为 2（主→子→孙，孙再派即拒）', () => {
    expect(MAX_SUBAGENT_DEPTH).toBe(2)
  })

  it('depth 判定：0/1 可派，2 及以上不可派', () => {
    const canSpawn = (d: number | undefined) => (d ?? 0) < MAX_SUBAGENT_DEPTH
    expect(canSpawn(undefined)).toBe(true)
    expect(canSpawn(0)).toBe(true)
    expect(canSpawn(1)).toBe(true)
    expect(canSpawn(2)).toBe(false)
    expect(canSpawn(3)).toBe(false)
  })

  it('depth=2 真调用 tool.call 抛错且提示含上限层数', async () => {
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    await expect(
      tool.call({ description: 't', prompt: 'p' }, ctx({ subagentDepth: 2 })),
    ).rejects.toThrow(/嵌套已达上限 2 层/)
  })

  it('depth=1（子代理内部）真调用 tool.call 不抛错，正常派出孙代理', async () => {
    script.push({ result: { content: '孙代理结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'p' }, ctx({ subagentDepth: 1 }))
    expect(out).toBe('孙代理结论')
  })

  it('顶层 ctx（subagentDepth 缺省 = 0）真调用 tool.call 不抛错', async () => {
    script.push({ result: { content: '顶层结论', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call({ description: 't', prompt: 'p' }, ctx())
    expect(out).toBe('顶层结论')
  })

  it('depth=2 + run_in_background:true 仍被拒（深度门在后台分支之前，后台不能绕过）', async () => {
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    await expect(
      tool.call({ description: 't', prompt: 'p', run_in_background: true }, ctx({ subagentDepth: 2 })),
    ).rejects.toThrow(/嵌套已达上限 2 层/)
    // 没有任何后台任务被注册（门在注册之前拦下）
    expect(listTasks().length).toBe(0)
  })
})

describe('子代理后台守卫（isSubagent 降级为前台）', () => {
  it('ctx.isSubagent=true + run_in_background:true → 不注册后台任务，同步返回子代理最终文本', async () => {
    script.push({ result: { content: '子代理同步结果', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call(
      { description: 't', prompt: 'p', run_in_background: true },
      ctx({ isSubagent: true }),
    )
    // 前台同步分支直接返回最终文本，不是 "后台子代理已启动 id=xxx" 句柄
    expect(out).toBe('子代理同步结果')
    expect(out).not.toMatch(/后台子代理已启动/)
    expect(out).not.toMatch(/id=a[0-9a-z]{8}/)
    // 没有注册任何后台任务
    expect(listTasks().length).toBe(0)
  })

  it('反向对照：ctx.isSubagent 为假（主会话）+ run_in_background:true → 仍走后台分支（返回句柄、任务已注册）', async () => {
    script.push({ result: { content: '后台真结果', toolCalls: [], usage, finishReason: 'stop' } })
    const tool = makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'deepseek-v4-flash' })
    const out = await tool.call(
      { description: 't', prompt: 'p', run_in_background: true },
      ctx(), // isSubagent 未设置 → 主会话
    )
    expect(out).toMatch(/后台子代理已启动/)
    expect(out).toMatch(/id=a[0-9a-z]{8}/)
    const running = listTasks().filter(t => t.type === 'local_agent' && t.status === 'running')
    expect(running.length).toBe(1)
    const id = out.match(/id=(a[0-9a-z]{8})/)![1]
    await waitForDone(id)
  })
})
