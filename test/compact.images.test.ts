// test/compact.images.test.ts
import { describe, it, expect } from 'vitest'
import { microcompact, MICROCOMPACT_PLACEHOLDER } from '../src/compact.js'

// 造一条 ~600 tok 的 tool 结果（ASCII 2000 字符 × 0.3 ≈ 600），可选带 images 旁挂
const bigTool = (id: string, extra?: object) => ({ role: 'tool', tool_call_id: id, content: 'x'.repeat(2000), ...extra })
const asst = (id: string) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name: 'Read', arguments: '{}' } }] })

describe('microcompact 剥离 images 旁挂', () => {
  it('占位化的消息 images 变 undefined，避免为已压缩消息重发大 base64', () => {
    const msgs: any[] = [{ role: 'system', content: 'SYS' }]
    for (let i = 0; i < 60; i++) {
      // 最老的一条 tool 结果带 images 旁挂（模拟视觉工具结果）
      msgs.push(asst('t' + i), bigTool('t' + i, i === 0 ? { images: [{ base64: 'BIG_BASE64', mime: 'image/png' }] } : undefined))
    }
    const r = microcompact(msgs)!
    expect(r).not.toBeNull()
    const cleared = r.messages.find(m => m.tool_call_id === 't0')
    expect(cleared.content).toBe(MICROCOMPACT_PLACEHOLDER) // 确认它确实被占位化
    expect(cleared.images).toBeUndefined() // 占位化的同时应剥掉 images，不再重发大 base64
    // 不改原数组
    expect(msgs.find(m => m.tool_call_id === 't0').images).toEqual([{ base64: 'BIG_BASE64', mime: 'image/png' }])
  })
})
