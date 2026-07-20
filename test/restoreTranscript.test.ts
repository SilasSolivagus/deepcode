// test/restoreTranscript.test.ts —— 恢复会话时把 messages 反向映射回 UI 的 transcript
import { describe, it, expect } from 'vitest'
import { messagesToTranscript } from '../src/tui/restoreTranscript.js'

describe('messagesToTranscript', () => {
  it('system 消息不进 transcript', () => {
    const items = messagesToTranscript([{ role: 'system', content: '你是 deepcode' }])
    expect(items).toEqual([])
  })

  it('user / assistant 文本按原顺序还原', () => {
    const items = messagesToTranscript([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你也好' },
      { role: 'user', content: '再见' },
    ])
    expect(items.map(i => i.kind)).toEqual(['user', 'assistant', 'user'])
    expect((items[0] as any).text).toBe('你好')
    expect((items[1] as any).done).toBe(true)
    expect((items[1] as any).segments[0].orig).toBe('你也好')
    expect((items[2] as any).text).toBe('再见')
  })

  it('assistant 的 tool_calls 还原成已完成的工具行（不谎报成功：ok 留空）', () => {
    const items = messagesToTranscript([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 't1', function: { name: 'Read', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 't1', content: '1  // a' },
    ])
    expect(items).toHaveLength(1)
    const t = items[0] as any
    expect(t.kind).toBe('tool')
    expect(t.name).toBe('Read')
    expect(t.desc).toBe('{"file_path":"a.ts"}')
    expect(t.running).toBe(false)
    expect(t.ok).toBeUndefined() // 历史里看不出当时成没成，不能画 ✓
  })

  it('assistant 同时有文本和 tool_calls：文本块在前，工具行随后', () => {
    const items = messagesToTranscript([
      {
        role: 'assistant',
        content: '我来看看',
        tool_calls: [{ id: 't1', function: { name: 'Glob', arguments: '{"pattern":"*"}' } }],
      },
    ])
    expect(items.map(i => i.kind)).toEqual(['assistant', 'tool'])
  })

  it('空 assistant 文本不产生空块', () => {
    const items = messagesToTranscript([{ role: 'assistant', content: '' }])
    expect(items).toEqual([])
  })

  it('多模态 user 内容（数组形态）取其中的文本块', () => {
    const items = messagesToTranscript([
      { role: 'user', content: [{ type: 'text', text: '看这张图' }, { type: 'image_url', image_url: { url: 'data:...' } }] },
    ])
    expect((items[0] as any).text).toBe('看这张图')
  })
})
