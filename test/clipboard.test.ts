import { describe, it, expect } from 'vitest'
import { lastAssistantText, nthAssistantText, lastCodeBlock, osc52Sequence } from '../src/clipboard.js'

const sys = { role: 'system', content: 'you are a bot' }

describe('lastAssistantText', () => {
  it('只有 system 时返回 null', () => {
    expect(lastAssistantText([sys])).toBeNull()
  })

  it('单条 assistant 返回其文本', () => {
    expect(lastAssistantText([sys, { role: 'assistant', content: '你好' }])).toBe('你好')
  })

  it('多条 assistant 取最后一条', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '第一条' },
      { role: 'user', content: '继续' },
      { role: 'assistant', content: '第二条' },
    ]
    expect(lastAssistantText(msgs)).toBe('第二条')
  })

  it('最后是 user 时回溯到上一条 assistant', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '问题' },
    ]
    expect(lastAssistantText(msgs)).toBe('回复')
  })

  it('最后是 tool 时回溯到上一条 assistant', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '回复' },
      { role: 'tool', content: '工具结果', tool_call_id: 'x' },
    ]
    expect(lastAssistantText(msgs)).toBe('回复')
  })

  it('assistant content=null（带 tool_calls）跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '有文本的回复' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'foo', arguments: '{}' } }] },
    ]
    expect(lastAssistantText(msgs)).toBe('有文本的回复')
  })

  it('纯空白 content 跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '实质内容' },
      { role: 'assistant', content: '   \n\t  ' },
    ]
    expect(lastAssistantText(msgs)).toBe('实质内容')
  })

  it('content 非字符串跳过', () => {
    const msgs = [
      sys,
      { role: 'assistant', content: '正常文本' },
      { role: 'assistant', content: 123 as any },
    ]
    expect(lastAssistantText(msgs)).toBe('正常文本')
  })

  it('user/tool 消息被忽略，没有 assistant 返回 null', () => {
    const msgs = [
      sys,
      { role: 'user', content: '只有用户消息' },
      { role: 'tool', content: '工具结果', tool_call_id: 'x' },
    ]
    expect(lastAssistantText(msgs)).toBeNull()
  })
})

describe('nthAssistantText', () => {
  const msgs = [
    { role: 'assistant', content: '第一条' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: '第二条' },
    { role: 'assistant', content: '第三条' },
  ]
  it('n=1 取最新 assistant', () => expect(nthAssistantText(msgs, 1)).toBe('第三条'))
  it('n=2 取倒数第二条', () => expect(nthAssistantText(msgs, 2)).toBe('第二条'))
  it('n=3 取倒数第三条', () => expect(nthAssistantText(msgs, 3)).toBe('第一条'))
  it('n 超出范围返回 null', () => expect(nthAssistantText(msgs, 4)).toBeNull())
  it('n<1 返回 null', () => expect(nthAssistantText(msgs, 0)).toBeNull())
})

describe('lastCodeBlock', () => {
  it('取最后一个围栏块内容', () => {
    const t = '前言\n```js\nconst a = 1\n```\n中间\n```py\nx = 2\n```\n尾'
    expect(lastCodeBlock(t)).toBe('x = 2')
  })
  it('无代码块返回 null', () => expect(lastCodeBlock('纯文本')).toBeNull())
  it('null 输入返回 null', () => expect(lastCodeBlock(null)).toBeNull())
})

describe('osc52Sequence', () => {
  it('用 base64 编码文本并包在 OSC52 起止里', () => {
    const seq = osc52Sequence('你好 hi')
    expect(seq.startsWith('\x1b]52;c;')).toBe(true)
    expect(seq.endsWith('\x07')).toBe(true)
    const b64 = seq.slice('\x1b]52;c;'.length, -1)
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('你好 hi')
  })
})
