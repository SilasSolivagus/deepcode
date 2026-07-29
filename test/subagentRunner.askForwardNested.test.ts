// 转发链路的端到端锁：孙代理（第二层）的权限确认必须穿过中间的子代理抵达顶层 askUp，
// 而不是被中间层吞掉或就地拍板。只 mock chatStream 脚本化工具调用序列，跑真实 runSubagent + 真实 Agent 工具。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Decision } from '../src/permissions.js'
import type { ToolContext } from '../src/tools/types.js'

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn(() => (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })()),
  }
})

import { runSubagent } from '../src/subagentRunner.js'
import { makeAgentTool } from '../src/tools/agent.js'
import { bashTool } from '../src/tools/bash.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }
const call = (id: string, name: string, args: object) => ({
  result: { content: '', toolCalls: [{ id, name, args: JSON.stringify(args) }], usage, finishReason: 'tool_calls' },
})
const stop = (content: string) => ({ result: { content, toolCalls: [], usage, finishReason: 'stop' } })

describe('孙代理 ask 穿两层抵达顶层', () => {
  beforeEach(() => { script.length = 0 })

  it('孙代理的确认到达顶层 askUp，origin 标的是孙代理', async () => {
    script.push(
      call('c1', 'Agent', { description: '派孙代理', prompt: '跑一条命令', subagent_type: 'general-purpose' }),
      call('c2', 'Bash', { command: 'echo hi' }), // 孙代理执行
      stop('孙代理完成'),
      stop('子代理完成'),
    )
    const seen: Array<{ agentId: string; agentType: string } | undefined> = []
    const ctx: ToolContext = {
      cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
      parentPermission: () => ({ mode: 'default', rules: [], cwd: '/tmp' }),
      askUp: async (_t: string, _d: string, _r?: unknown, _p?: string, origin?: any): Promise<Decision> => {
        seen.push(origin); return 'no'
      },
    } as any

    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [makeAgentTool({ client: {} as any, onUsage: () => {}, getModel: () => 'm' }), bashTool],
      model: 'm', ctx, signal: new AbortController().signal,
      agentId: 'child-1', agentType: 'general-purpose',
    })

    // 孙代理那条 Bash 的确认必须抵达顶层（中间层没吞掉、没本地拍板）
    expect(seen.length).toBe(1)
    // 且 origin 标的是孙代理自己，不是中间的子代理
    expect(seen[0]).toBeDefined()
    expect(seen[0]!.agentId).not.toBe('child-1')
  })
})
