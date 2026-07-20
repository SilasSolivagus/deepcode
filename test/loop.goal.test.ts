import { describe, it, expect, vi } from 'vitest'
const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() => (async function* () {
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    return scene.result
  })()),
}))
import { runLoop, type LoopDeps } from '../src/loop.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
function baseDeps(): LoopDeps {
  return {
    client: {} as any, tools: [], model: 'm', thinking: false,
    permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' } as any,
    ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() } as any,
  }
}
async function drain(gen: AsyncGenerator<any, any>) { let s; while (!(s = await gen.next()).done) {} return s.value }

describe('loop goalGate', () => {
  it('gate continue → 注入 inject 并续跑', async () => {
    script.push({ result: { content: '第一轮', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '第二轮', toolCalls: [], usage, finishReason: 'stop' } })
    let n = 0
    const deps = baseDeps()
    deps.goalGate = async () => (n++ === 0 ? { continue: true, inject: 'GO' } : { continue: false })
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    expect(messages.some(m => m.role === 'user' && m.content === 'GO')).toBe(true)
    expect(n).toBe(2)  // 第一轮 continue，第二轮 stop
  })
  it('gate stop → 正常结束一轮', async () => {
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const deps = baseDeps(); deps.goalGate = async () => ({ continue: false })
    const ret = await drain(runLoop([{ role: 'user', content: 'hi' }], deps))
    expect(ret).toBe('done')
  })
  it('无 goalGate → 零回归', async () => {
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const ret = await drain(runLoop([{ role: 'user', content: 'hi' }], baseDeps()))
    expect(ret).toBe('done')
  })
})
