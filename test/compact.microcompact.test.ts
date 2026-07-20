// test/compact.microcompact.test.ts
import { describe, it, expect } from 'vitest'
import {
  microcompact, isContextOverflowError, rebuildFromPrecompute,
  MICROCOMPACT_PLACEHOLDER, MICROCOMPACT_KEEP_RECENT,
} from '../src/compact.js'

// 造一条 ~600 tok 的 tool 结果（ASCII 2000 字符 × 0.3 ≈ 600）
const bigTool = (id: string) => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(2000) })
const asst = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'Read', arguments: '{}' } }] })

describe('microcompact', () => {
  it('保留最近 keepRecent 条 tool，更老的换占位符，可回收 ≥ floor', () => {
    // 10 组 assistant+tool，每 tool ~600 tok，老的 5 条可回收 ~3000 < 20000 → 提高数量
    const msgs: any[] = [{ role: 'system', content: 'SYS' }]
    for (let i = 0; i < 60; i++) { msgs.push(asst('t' + i), bigTool('t' + i)) }
    const r = microcompact(msgs)!
    expect(r).not.toBeNull()
    // 消息总数不变（占位符替换而非删除，保 tool_call↔tool 配对）
    expect(r.messages.length).toBe(msgs.length)
    // 最近 5 条 tool 保留原文
    const tools = r.messages.filter(m => m.role === 'tool')
    expect(tools.slice(-MICROCOMPACT_KEEP_RECENT).every(t => t.content !== MICROCOMPACT_PLACEHOLDER)).toBe(true)
    // 更老的被占位
    expect(tools.slice(0, -MICROCOMPACT_KEEP_RECENT).every(t => t.content === MICROCOMPACT_PLACEHOLDER)).toBe(true)
    // 可回收非零
    expect(r.tokensSaved).toBeGreaterThanOrEqual(20000)
    // 不改原数组
    expect(msgs.filter(m => m.role === 'tool').every(t => t.content !== MICROCOMPACT_PLACEHOLDER)).toBe(true)
  })

  it('可回收 < floor 返回 null', () => {
    const msgs = [{ role: 'system', content: 'SYS' }, asst('a'), bigTool('a'), asst('b'), bigTool('b')]
    expect(microcompact(msgs)).toBeNull() // 只 2 条 tool，全在 keep 内，可回收 0
  })

  it('无 tool 消息返回 null', () => {
    expect(microcompact([{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }])).toBeNull()
  })

  it('幂等：二次调用返回 null（已占位可回收骤降）', () => {
    const msgs: any[] = [{ role: 'system', content: 'SYS' }]
    for (let i = 0; i < 60; i++) { msgs.push(asst('t' + i), bigTool('t' + i)) }
    const r1 = microcompact(msgs)!
    expect(microcompact(r1.messages)).toBeNull()
  })
})

describe('isContextOverflowError', () => {
  it('命中常见 provider 超长错误', () => {
    expect(isContextOverflowError(new Error('maximum context length is 65536 tokens'))).toBe(true)
    expect(isContextOverflowError({ code: 'context_length_exceeded' })).toBe(true)
    expect(isContextOverflowError({ message: 'reduce the length of the messages' })).toBe(true)
    expect(isContextOverflowError(new Error('上下文长度超出限制'))).toBe(true)
  })
  it('无关错误不命中', () => {
    expect(isContextOverflowError(new Error('rate limit exceeded'))).toBe(false)
    expect(isContextOverflowError(null)).toBe(false)
  })
})

describe('rebuildFromPrecompute', () => {
  it('[system, 摘要(user), ...slice(armLen)]，摘要含标签', () => {
    const msgs = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' },
    ]
    const out = rebuildFromPrecompute(msgs, '总结X', 3) // 摘要覆盖 [0,3)，尾部 = u2,a2
    expect(out[0]).toEqual({ role: 'system', content: 'S' })
    expect(out[1].role).toBe('user')
    expect(out[1].content).toContain('总结X')
    expect(out[1].content).toContain('<对话历史总结>')
    expect(out.slice(2)).toEqual([{ role: 'user', content: 'u2' }, { role: 'assistant', content: 'a2' }])
  })
  it('无 system 时不前置 system', () => {
    const out = rebuildFromPrecompute([{ role: 'user', content: 'u1' }, { role: 'assistant', content: 'a1' }], 'S', 1)
    expect(out[0].role).toBe('user')
    expect(out[0].content).toContain('S')
  })
})
