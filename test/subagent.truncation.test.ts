// test/subagent.truncation.test.ts
//
// 首轮真机 A/B（2026-08-04）挖出的失效链：验证子代理烧穿轮次预算被截断 → runLoop 给它封了一句
// 中性的「（已达最大轮数上限，已停止。）」→ runSubagent 把 runLoop 的返回状态整个丢掉 →
// 父代理拿到的东西与「正常收工但没多说什么」无从分辨 → 父代理照常收工，在交付陈述里写下
// 「Verified Behavior」，而那次验证从未返回任何 verdict。
//
// 有这套机制反而比没有更糟：没机制时交付物只是「没验过」，这样失效时它挂着一个没人挣来的
// 「已验证」标题。这组测试锁住「截断必须喊出来」。
import { describe, it, expect, vi } from 'vitest'

const loopCalls: any[] = []
let loopReturn: 'done' | 'max_turns' | 'aborted' = 'done'
let loopText = '验证完成：PASS'

vi.mock('../src/loop.js', () => ({
  runLoop: vi.fn(function* (messages: any[], deps: any) {
    loopCalls.push(deps)
    messages.push({ role: 'assistant', content: loopText })
    return loopReturn
  }),
}))

import { runSubagent, TRUNCATED_NOTICE, DEFAULT_SUBAGENT_MAX_TURNS } from '../src/subagentRunner.js'

const baseOpts = () => ({
  client: {} as any,
  onUsage: () => {},
  systemPrompt: 'sys',
  userPrompt: 'user',
  tools: [] as any[],
  model: 'm',
  ctx: {
    cwd: () => process.cwd(),
    setCwd: () => {},
    denyPatterns: () => [],
    parentPermission: () => ({ mode: 'default', rules: [], deny: [] }),
    askUp: async () => 'no' as const,
    signal: new AbortController().signal,
    fileState: new Map(),
    sessionId: () => 's',
  } as any,
  signal: new AbortController().signal,
  agentId: 'a1',
  agentType: 'verification',
})

describe('子代理撞轮次上限时必须喊出来', () => {
  it('正常收工：原样返回，不加任何警示', async () => {
    loopReturn = 'done'; loopText = '验证完成：PASS'
    const r = await runSubagent(baseOpts())
    expect(r).toBe('验证完成：PASS')
    expect(r).not.toContain('⚠️')
  })

  it('撞上限：返回内容前置截断警示，且明确堵掉「据此声称已验证」', async () => {
    loopReturn = 'max_turns'; loopText = '（已达最大轮数上限，已停止。）'
    const r = await runSubagent(baseOpts())!
    expect(r).toContain(TRUNCATED_NOTICE)
    expect(r).toMatch(/不是结论/)
    expect(r).toMatch(/不得据此声称任务已完成或已验证/)
    // 原始内容仍保留在后面——诊断信息不能丢
    expect(r).toContain('已达最大轮数上限')
  })

  it('撞上限且子代理一个字都没产出时，也要给出警示而不是 undefined', async () => {
    loopReturn = 'max_turns'; loopText = ''
    const r = await runSubagent(baseOpts())
    expect(r).toBeDefined()
    expect(r).toContain(TRUNCATED_NOTICE)
  })

  it('中断（aborted）不加截断警示——那不是预算问题，措辞会误导', async () => {
    loopReturn = 'aborted'; loopText = '（本轮已被用户中断。）'
    const r = await runSubagent(baseOpts())
    expect(r).not.toContain(TRUNCATED_NOTICE)
  })
})

describe('verification 的预算定义与接线', () => {
  it('verification 定义了 maxTurns: 50', async () => {
    const { BUILTIN_AGENTS } = await import('../src/tools/agentTypes.js')
    const def = BUILTIN_AGENTS.find(a => a.agentType === 'verification')
    expect(def?.maxTurns).toBe(50)
  })

  it('系统提示里有批量执行指令——根因不是「30 太少」，是一轮一条把预算烧在往返上', async () => {
    const { BUILTIN_AGENTS } = await import('../src/tools/agentTypes.js')
    const p = BUILTIN_AGENTS.find(a => a.agentType === 'verification')!.getSystemPrompt()
    expect(p).toContain('批量执行')
    expect(p).toMatch(/并进同一轮|并成一轮/)
  })

  it('每一处 runSubagent 调用都把 maxTurns 传下去了', async () => {
    // 「定义了预算却没接到调用处」＝ 定义形同虚设，与 --model/--permission-mode 曾经的
    // 静默忽略是同一类 bug。源码扫描在这里是合适的：它查的是「有没有忘了接线」这个结构性问题。
    const fs = await import('node:fs')
    const path = await import('node:path')
    for (const f of ['src/tools/agent.ts', 'src/tools/skill.ts', 'src/workflow/backend.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf8')
      const calls = (src.match(/runSubagent\(\{/g) ?? []).length
      const wired = (src.match(/maxTurns: \w+\??\.maxTurns/g) ?? []).length
      expect(wired, `${f}: ${calls} 处调用只接了 ${wired} 处 maxTurns`).toBe(calls)
    }
  })
})

describe('轮次预算可按 agent 类型配置', () => {
  it('不传时用默认值 30', async () => {
    loopCalls.length = 0; loopReturn = 'done'; loopText = 'ok'
    await runSubagent(baseOpts())
    expect(loopCalls[0].maxTurns).toBe(DEFAULT_SUBAGENT_MAX_TURNS)
    expect(DEFAULT_SUBAGENT_MAX_TURNS).toBe(30)
  })

  it('传了就用传进来的（verification 定义的是 50）', async () => {
    loopCalls.length = 0; loopReturn = 'done'; loopText = 'ok'
    await runSubagent({ ...baseOpts(), maxTurns: 50 })
    expect(loopCalls[0].maxTurns).toBe(50)
  })
})
