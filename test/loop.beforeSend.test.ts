// test/loop.beforeSend.test.ts
// beforeSend 是「发送前」接缝：每轮请求发出前恰好调一次，最后一轮之后不调。
// 语义精确性是它存在的全部理由——若退化成「轮末」（挪到循环体末尾），
// 每个回合的最后一轮都会压缩一个再也不发给 API 的 messages，
// 与 7e7126c 修掉的那个 headless bug 同构。
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 脚本化 chatStream，同时记录每次真正发出去的 messages 长度与调用顺序
const script: Array<{ result: any }> = []
const trace: string[] = []
const sentLengths: number[] = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn((_client: any, opts: any) =>
    (async function* () {
      trace.push('send')
      sentLengths.push(opts.messages.length)
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      return scene.result
    })(),
  ),
}))

import { runLoop, type LoopDeps } from '../src/loop.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }
const toolTurn = (i: number) => ({
  result: {
    content: '', toolCalls: [{ id: `t${i}`, name: 'NoSuchTool', args: '{}' }],
    usage, finishReason: 'tool_calls',
  },
})
const stopTurn = () => ({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })

// 工具用不存在的名字：execCall 会返回错误结果并照常回灌 tool 消息，
// 循环继续推进，而不必真跑一个工具——本文件只关心接缝时机。
function makeDeps(over: Partial<LoopDeps> = {}): LoopDeps {
  return {
    client: {} as any,
    tools: [],
    model: 'deepseek-v4-flash',
    thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' },
    ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() },
    ...over,
  } as LoopDeps
}

async function drain(gen: AsyncGenerator<any, any>) {
  const events: any[] = []
  let r
  while (!(r = await gen.next()).done) events.push(r.value)
  return { events, ret: r.value }
}

beforeEach(() => { script.length = 0; trace.length = 0; sentLengths.length = 0 })

describe('beforeSend 接缝', () => {
  it('每轮发送前恰好调一次，且最后一轮之后不再调', async () => {
    script.push(toolTurn(0), toolTurn(1), stopTurn())
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    await drain(runLoop(messages, makeDeps({
      beforeSend: async () => { trace.push('before') },
    })))
    // 3 轮 → 3 次 send、3 次 before，且严格交替、以 send 收尾。
    // 挪到循环体末尾会变成 send,before,send,before,send,before（末位是 before）。
    // 整行删掉会变成 send,send,send（before 一次都没有）。
    expect(trace).toEqual(['before', 'send', 'before', 'send', 'before', 'send'])
  })

  it('beforeSend 改写 messages 后，turn_end 的 sentLen 与真正发出去的长度一致', async () => {
    script.push(stopTurn())
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    const { events } = await drain(runLoop(messages, makeDeps({
      // 模拟压缩：原地改写成更短的数组
      beforeSend: async m => { m.length = 0; m.push({ role: 'system', content: 's' }) },
    })))
    const turnEnd = events.find(e => e.type === 'turn_end')
    // sentLen 必须反映改写【之后】的长度。若 beforeSend 被挪到 `const sentLen` 之后，
    // sentLen 会是改写前的 2，而真正发出去的是 1。
    expect(sentLengths).toEqual([1])
    expect(turnEnd.sentLen).toBe(1)
  })

  it('不传 beforeSend → 零影响', async () => {
    script.push(stopTurn())
    const messages: any[] = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]
    const { ret } = await drain(runLoop(messages, makeDeps()))
    expect(ret).toBe('done')
    expect(trace).toEqual(['send'])
  })
})
