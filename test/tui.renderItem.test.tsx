import { describe, it, expect } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Box } from 'ink'
import { renderItem, isDone } from '../src/tui/renderItem.js'
import { DEFAULT_THEME } from '../src/tui/theme.js'
import type { TranscriptItem } from '../src/tui/useChat.js'

describe('renderItem 抽取', () => {
  it('isDone：tool running=false 为完成，assistant done 决定', () => {
    expect(isDone({ kind: 'tool', name: 'Read', running: false } as any)).toBe(true)
    expect(isDone({ kind: 'tool', name: 'Read', running: true } as any)).toBe(false)
    expect(isDone({ kind: 'assistant', text: 'x', done: true } as any)).toBe(true)
    expect(isDone({ kind: 'user', text: 'hi' } as any)).toBe(true)
  })

  it('renderItem：user 项渲染文本与 > 提示符', () => {
    const item: TranscriptItem = { kind: 'user', text: '你好世界' } as any
    const f = render(<Box>{renderItem(item, 0, DEFAULT_THEME)}</Box>).lastFrame()!
    expect(f).toContain('你好世界')
    expect(f).toContain('>')
  })

  it('collapsed 渲染成 dim summary 行', () => {
    const item = { kind: 'collapsed', id: 'brief-0', counts: { readCount: 2, searchCount: 0, editFileCount: 0, linesAdded: 0, linesRemoved: 0, bashCount: 1, taskCount: 0, webCount: 0, mcpCallCount: 0, otherCount: 0 } } as any
    const f = render(<Box>{renderItem(item, 0, DEFAULT_THEME)}</Box>).lastFrame()!
    expect(f).toContain('读取 2 个文件')
    expect(f).toContain('运行 1 条命令')
  })
})
