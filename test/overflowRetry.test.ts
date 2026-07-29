import { describe, it, expect } from 'vitest'
import { planOverflowRetry } from '../src/overflowRetry.js'
import { MICROCOMPACT_FLOOR_TOKENS } from '../src/compact.js'

/** 造一份含大工具结果的对话：足够让 microcompact 有东西可甩。 */
function fatMessages() {
  const big = 'x'.repeat(MICROCOMPACT_FLOOR_TOKENS * 8)
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't2', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't3', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't3', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't4', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't4', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't5', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't5', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't6', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't6', content: big },
    { role: 'assistant', content: '', tool_calls: [{ id: 't7', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't7', content: big },
  ]
}

const overflowErr = new Error('This model maximum context length is 128000 tokens')

describe('planOverflowRetry', () => {
  it('三条判据都满足 → retry，带压缩后的 messages 与 tokensSaved', () => {
    const p = planOverflowRetry(overflowErr, fatMessages(), false)
    expect(p.action).toBe('retry')
    if (p.action !== 'retry') throw new Error('unreachable')
    expect(p.tokensSaved).toBeGreaterThan(0)
    expect(p.messages.length).toBe(fatMessages().length) // 消息条数不变，只是内容被换成占位符
  })

  it('非超窗错误 → report', () => {
    expect(planOverflowRetry(new Error('boom'), fatMessages(), false).action).toBe('report')
  })

  it('已重试过 → report（单发语义，防死循环）', () => {
    expect(planOverflowRetry(overflowErr, fatMessages(), true).action).toBe('report')
  })

  it('microcompact 无可回收 → report', () => {
    const thin = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]
    expect(planOverflowRetry(overflowErr, thin, false).action).toBe('report')
  })

  it('不修改传入的 messages（身份与内容均不变）', () => {
    const msgs = fatMessages()
    const before = JSON.stringify(msgs)
    const ref = msgs
    planOverflowRetry(overflowErr, msgs, false)
    expect(msgs).toBe(ref)
    expect(JSON.stringify(msgs)).toBe(before)
  })
})
