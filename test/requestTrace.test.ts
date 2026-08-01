import { describe, it, expect } from 'vitest'
import { buildTraceRecord } from '../src/requestTrace.js'

const base = {
  seq: 8,
  ts: '2026-08-01T12:34:56.789Z',
  model: 'deepseek-v4-pro',
  wireMessages: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', function: { name: 'Read' } }],
  params: { stream: true, stream_options: { include_usage: true } },
}

describe('buildTraceRecord', () => {
  it('原样带上 seq / ts / model / messages / tools / params', () => {
    const r = buildTraceRecord(base)
    expect(r.seq).toBe(8)
    expect(r.ts).toBe('2026-08-01T12:34:56.789Z')
    expect(r.model).toBe('deepseek-v4-pro')
    expect(r.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(r.tools).toEqual([{ type: 'function', function: { name: 'Read' } }])
    expect(r.params).toEqual({ stream: true, stream_options: { include_usage: true } })
  })

  it('label 缺省记为 unknown', () => {
    expect(buildTraceRecord(base).label).toBe('unknown')
  })

  it('label 给了就用给的', () => {
    expect(buildTraceRecord({ ...base, label: 'compact' }).label).toBe('compact')
  })

  it('长 messages 不被截断（截断即等于漏）', () => {
    const big = 'x'.repeat(200_000)
    const r = buildTraceRecord({ ...base, wireMessages: [{ role: 'user', content: big }] })
    expect(r.messages[0].content).toHaveLength(200_000)
  })

  it('不复制引用而是可安全序列化（落盘后仍完整）', () => {
    const r = buildTraceRecord(base)
    const round = JSON.parse(JSON.stringify(r))
    expect(round).toEqual(r)
  })
})
