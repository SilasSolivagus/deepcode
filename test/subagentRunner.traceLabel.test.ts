import { describe, it, expect, vi } from 'vitest'

// 捕获 chatStream 实际收到的 opts——要证明的是「真实的 runSubagent → runLoop 链路
// 把标签传下去了」，不是在测试里把拼装逻辑重抄一遍。
const captured: any[] = []
vi.mock('../src/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  chatStream: vi.fn((_client: any, opts: any) =>
    (async function* () {
      captured.push(opts)
      return {
        content: '做完了', finishReason: 'stop', toolCalls: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 },
      }
    })(),
  ),
}))

import { runSubagent } from '../src/subagentRunner.js'

const ctx = () => ({
  cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map(),
}) as any

describe('子代理把自己的类型写进 traceLabel', () => {
  it('agentType 出现在标签里，形如 subagent:<类型>', async () => {
    captured.length = 0
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [], model: 'm', ctx: ctx(), signal: new AbortController().signal,
      agentId: 'a1', agentType: 'verification',
    })
    expect(captured.length).toBeGreaterThan(0)
    expect(captured[0].traceLabel).toBe('subagent:verification')
  })

  it('别的子代理类型也带自己的名字（标签不是写死的）', async () => {
    captured.length = 0
    await runSubagent({
      client: {} as any, onUsage: () => {}, systemPrompt: 'sys', userPrompt: 'go',
      tools: [], model: 'm', ctx: ctx(), signal: new AbortController().signal,
      agentId: 'a2', agentType: 'general-purpose',
    })
    expect(captured[0].traceLabel).toBe('subagent:general-purpose')
  })
})
