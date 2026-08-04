// test/verifyGate.test.ts
//
// 收工前验证自检门。真机背景（2026-08-04 定向探针）：验证合同此前纯靠系统提示说服，
// 那次跑机制侧毫无问题（合同注入成功、Agent 工具可用、120 轮只用了 56），模型改了 19 个
// 文件、零次派验证子代理、直接收工，并在交付陈述里自评「## Verifying … 82/82 tests pass」。
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'

const script: Array<{ result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() => (async function* () {
    const scene = script.shift(); if (!scene) throw new Error('script exhausted')
    return scene.result
  })()),
}))

import { scanForVerification, makeVerifyGate, verifyNudge } from '../src/verifyGate.js'
import { runLoop, type LoopDeps } from '../src/loop.js'

const call = (name: string, args: any) => ({ id: 'c', type: 'function', function: { name, arguments: JSON.stringify(args) } })
const asst = (...calls: any[]) => ({ role: 'assistant', content: null, tool_calls: calls })

describe('scanForVerification', () => {
  it('数的是不同文件数，重复改同一个文件只算一次', () => {
    const m = [asst(call('Write', { file_path: '/a' })), asst(call('Edit', { file_path: '/a' }), call('Edit', { file_path: '/b' }))]
    expect(scanForVerification(m).editedFiles).toBe(2)
  })
  it('三个写工具都算（Edit / Write / NotebookEdit）', () => {
    const m = [asst(call('Edit', { file_path: '/a' }), call('Write', { file_path: '/b' }), call('NotebookEdit', { file_path: '/c' }))]
    expect(scanForVerification(m).editedFiles).toBe(3)
  })
  it('只读工具不算改动', () => {
    const m = [asst(call('Read', { file_path: '/a' }), call('Grep', { pattern: 'x' }))]
    expect(scanForVerification(m).editedFiles).toBe(0)
  })
  it('认出验证子代理', () => {
    expect(scanForVerification([asst(call('Agent', { subagent_type: 'verification', prompt: 'p' }))]).spawnedVerifier).toBe(true)
  })
  it('别的类型的子代理不算——这条门管的是验证，不是「派过任何子代理」', () => {
    const m = [asst(call('Agent', { subagent_type: 'general-purpose', prompt: 'p' })), asst(call('Agent', { subagent_type: 'Explore', prompt: 'p' }))]
    expect(scanForVerification(m).spawnedVerifier).toBe(false)
  })
  it('工具入参是坏 JSON 时跳过该条，不整体失败', () => {
    const bad = { id: 'c', type: 'function', function: { name: 'Write', arguments: '{不是 JSON' } }
    const m = [{ role: 'assistant', content: null, tool_calls: [bad] }, asst(call('Write', { file_path: '/a' }))]
    expect(scanForVerification(m).editedFiles).toBe(1)
  })
  it('user/tool 消息与无 tool_calls 的 assistant 都安全跳过', () => {
    const m = [{ role: 'user', content: 'x' }, { role: 'tool', tool_call_id: 't', content: 'r' }, { role: 'assistant', content: '说点什么' }, null]
    expect(scanForVerification(m as any)).toEqual({ editedFiles: 0, spawnedVerifier: false })
  })
})

describe('makeVerifyGate', () => {
  const edited = (n: number) => Array.from({ length: n }, (_, i) => asst(call('Write', { file_path: `/f${i}` })))

  it('够阈值且没派验证者 → 催一次', async () => {
    const g = makeVerifyGate()
    const r = await g(edited(3))
    expect(r.continue).toBe(true)
    expect((r as any).inject).toContain('3 个文件')
    expect((r as any).inject).toContain('verification')
  })

  it('没够阈值 → 放行（改一两个文件不该被拦）', async () => {
    expect((await makeVerifyGate()(edited(2))).continue).toBe(false)
  })

  it('已经派过验证者 → 放行（这才是门想要的结果）', async () => {
    const m = [...edited(9), asst(call('Agent', { subagent_type: 'verification', prompt: 'p' }))]
    expect((await makeVerifyGate()(m)).continue).toBe(false)
  })

  it('催到上限就放行——不能把剩余轮次全烧光', async () => {
    // 合同自己允许没拿到 PASS 时收工（只要明说「未通过验证」），硬拦会与合同自相矛盾。
    const g = makeVerifyGate({ maxNudges: 2 })
    const m = edited(5)
    expect((await g(m)).continue).toBe(true)
    expect((await g(m)).continue).toBe(true)
    expect((await g(m)).continue).toBe(false) // 第三次放行
  })

  it('阈值与上限可配', async () => {
    expect((await makeVerifyGate({ minEdits: 10 })(edited(5))).continue).toBe(false)
    expect((await makeVerifyGate({ maxNudges: 0 })(edited(5))).continue).toBe(false)
  })

  it('计数是每个门独立的，不跨实例累积', async () => {
    const a = makeVerifyGate({ maxNudges: 1 }), b = makeVerifyGate({ maxNudges: 1 })
    await a(edited(5))
    expect((await a(edited(5))).continue).toBe(false)
    expect((await b(edited(5))).continue).toBe(true)
  })
})

describe('催促文案', () => {
  it('给出两条都合法的出路，且堵掉「拿自测顶替」', () => {
    const t = verifyNudge(7)
    expect(t).toContain('7 个文件')
    expect(t).toMatch(/派一个验证子代理|subagent_type="verification"/)
    expect(t).toContain('未通过验证')          // 出路二：明说没验
    expect(t).toMatch(/不能替代它的 verdict/)  // 堵掉自评
  })
})

// —— 门造好了不等于门接上了。这一节真穿 runLoop，锁住接线本身。
const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
const baseDeps = (): LoopDeps => ({
  client: {} as any, tools: [], model: 'm', thinking: false,
  permission: { mode: 'yolo', rules: [], saveRule: () => {}, ask: async () => 'no' } as any,
  ctx: { cwd: () => '/tmp', setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() } as any,
})
const drain = async (gen: AsyncGenerator<any, any>) => { let s; while (!(s = await gen.next()).done) {} return s.value }

describe('verifyGate 真的接在 runLoop 的收工点上', () => {
  it('门要求续跑 → inject 被推进 messages 并再跑一轮', async () => {
    script.length = 0
    script.push({ result: { content: '干完了', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '好，我去验', toolCalls: [], usage, finishReason: 'stop' } })
    let n = 0
    const deps = baseDeps()
    deps.verifyGate = async () => (n++ === 0 ? { continue: true, inject: 'VERIFY-NUDGE' } : { continue: false })
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    expect(messages.some(m => m.role === 'user' && m.content === 'VERIFY-NUDGE')).toBe(true)
    expect(n).toBe(2)
  })

  it('门放行 → 正常 done', async () => {
    script.length = 0
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    const deps = baseDeps(); deps.verifyGate = async () => ({ continue: false })
    expect(await drain(runLoop([{ role: 'user', content: 'hi' }], deps))).toBe('done')
  })

  it('不传 verifyGate → 零回归（默认关时行为不变）', async () => {
    script.length = 0
    script.push({ result: { content: '答', toolCalls: [], usage, finishReason: 'stop' } })
    expect(await drain(runLoop([{ role: 'user', content: 'hi' }], baseDeps()))).toBe('done')
  })

  it('端到端：真门 + 真扫描，改了 3 个文件没派验证者时会被拦下续跑', async () => {
    script.length = 0
    script.push({ result: { content: '', toolCalls: [
      { id: 'w1', name: 'Write', args: JSON.stringify({ file_path: '/a', content: 'x' }) },
      { id: 'w2', name: 'Write', args: JSON.stringify({ file_path: '/b', content: 'x' }) },
      { id: 'w3', name: 'Write', args: JSON.stringify({ file_path: '/c', content: 'x' }) },
    ], usage, finishReason: 'tool_calls' } })
    script.push({ result: { content: '写完了', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '这就去派验证者', toolCalls: [], usage, finishReason: 'stop' } })
    const deps = baseDeps()
    deps.tools = [{ name: 'Write', description: '', isReadOnly: false, needsPermission: () => false,
      inputSchema: z.object({ file_path: z.string(), content: z.string() }),
      call: async () => '写好了' } as any]
    deps.verifyGate = makeVerifyGate({ maxNudges: 1 })
    const messages: any[] = [{ role: 'user', content: 'hi' }]
    await drain(runLoop(messages, deps))
    const nudged = messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('验证合同的触发条件'))
    expect(nudged, '改了 3 个文件却没被催').toBeTruthy()
    expect(nudged.content).toContain('3 个文件')
  })
})
