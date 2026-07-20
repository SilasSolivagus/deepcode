import { describe, it, expect } from 'vitest'
import { renderRecentMessages } from '../src/services/memory/extractPrompt.js'

describe('renderRecentMessages: tool_calls 盲区', () => {
  it('带 tool_calls 的 assistant 消息渲染出工具名与关键参数', () => {
    const out = renderRecentMessages([
      { role: 'assistant', content: null, tool_calls: [
        { id: '1', function: { name: 'Edit', arguments: '{"file_path":"src/api.ts"}' } },
        { id: '2', function: { name: 'Bash', arguments: '{"command":"npm test"}' } },
      ] },
    ])
    expect(out).toContain('Edit(src/api.ts)')
    expect(out).toContain('Bash(npm test)')
  })

  it('arguments 是坏 JSON 时不抛，退化为只有工具名', () => {
    const out = renderRecentMessages([
      { role: 'assistant', content: null, tool_calls: [{ id: '1', function: { name: 'Bash', arguments: '{不是json' } }] },
    ])
    expect(out).toContain('Bash')
  })

  it('普通文本消息行为不变', () => {
    expect(renderRecentMessages([{ role: 'user', content: '你好' }])).toBe('[user] 你好')
  })

  it('既无文本又无 tool_calls 的消息仍被丢弃', () => {
    expect(renderRecentMessages([{ role: 'assistant', content: '' }])).toBe('')
  })
})
