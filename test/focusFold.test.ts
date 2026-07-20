import { describe, it, expect } from 'vitest'
import { foldTranscript, summarizeCounts } from '../src/tui/focusFold.js'

const user = (t: string) => ({ kind: 'user', id: t, text: t } as any)
const asst = (t: string) => ({ kind: 'assistant', id: t, text: t } as any)
const tool = (name: string) => ({ kind: 'tool', id: name + Math.random(), name } as any)
const reasoning = () => ({ kind: 'reasoning', id: 'r', text: '...' } as any)

describe('foldTranscript', () => {
  it('工具行聚合成一条 collapsed，保留用户与最后助手文本', () => {
    const out = foldTranscript([
      user('问题'), tool('Read'), tool('Read'), tool('Bash'), asst('答'),
    ])
    expect(out.map(i => i.kind)).toEqual(['user', 'collapsed', 'assistant'])
    const c = (out[1] as any).counts
    expect(c.readCount).toBe(2)
    expect(c.bashCount).toBe(1)
  })
  it('只保留每段最后一条 assistant 文本', () => {
    const out = foldTranscript([user('q'), asst('中间'), tool('Grep'), asst('最终')])
    const texts = out.filter(i => i.kind === 'assistant').map(i => (i as any).text)
    expect(texts).toEqual(['最终'])
  })
  it('briefStandalone 工具保留不折叠', () => {
    const out = foldTranscript([user('q'), tool('AskUserQuestion'), asst('a')])
    expect(out.some(i => i.kind === 'tool' && (i as any).name === 'AskUserQuestion')).toBe(true)
  })
  it('reasoning/usage 隐藏，不产生 collapsed 若无工具', () => {
    const out = foldTranscript([user('q'), reasoning(), asst('a')])
    expect(out.map(i => i.kind)).toEqual(['user', 'assistant'])
  })
  it('notice/bang 保留', () => {
    const out = foldTranscript([{ kind: 'notice', id: 'n', text: '提示' } as any, user('q'), asst('a')])
    expect(out.some(i => i.kind === 'notice')).toBe(true)
  })
  it('数据无损：不修改入参数组', () => {
    const input = [user('q'), tool('Read'), asst('a')]
    const snapshot = JSON.stringify(input)
    foldTranscript(input)
    expect(JSON.stringify(input)).toBe(snapshot)
  })
  it('空/畸形输入 fail-safe', () => {
    expect(foldTranscript([])).toEqual([])
    expect(() => foldTranscript([{ kind: 'tool' } as any])).not.toThrow()
  })
})

describe('summarizeCounts', () => {
  it('多类以 · 拼接', () => {
    const s = summarizeCounts({ readCount: 3, searchCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, bashCount: 2, taskCount: 0, webCount: 0, mcpCallCount: 0, otherCount: 0 })
    expect(s).toBe('读取 3 个文件 · 运行 2 条命令')
  })
  it('编辑带行数', () => {
    const s = summarizeCounts({ readCount: 0, searchCount: 0, editFileCount: 1, linesAdded: 10, linesRemoved: 4, bashCount: 0, taskCount: 0, webCount: 0, mcpCallCount: 0, otherCount: 0 })
    expect(s).toBe('编辑 1 个文件 (+10 -4)')
  })
})
