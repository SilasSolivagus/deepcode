// test/suggestions.shiftTab.test.tsx —— 补全菜单键位：Tab 确认，Shift+Tab 不确认（留给权限模式循环）
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Suggestions } from '../src/tui/components/Suggestions.js'

// ink 的 useInput 在 useEffect 中注册 stdin 监听器；需等一个微任务让 effect 跑完后才能写 stdin
const delay = (ms = 0) => new Promise(res => setTimeout(res, ms))

const items = [
  { value: '/model', hint: '切换模型' },
  { value: '/plan', hint: 'plan 模式' },
]

describe('Suggestions 键位', () => {
  it('Tab 确认当前补全', async () => {
    const onPick = vi.fn()
    const r = render(<Suggestions items={items} onPick={onPick} />)
    await delay()
    r.stdin.write('\t')
    expect(onPick).toHaveBeenCalledWith('/model')
  })

  it('Enter 确认当前补全', async () => {
    const onPick = vi.fn()
    const r = render(<Suggestions items={items} onPick={onPick} />)
    await delay()
    r.stdin.write('\r')
    expect(onPick).toHaveBeenCalledWith('/model')
  })

  // 回归：Shift+Tab（ESC[Z）此前被 `key.tab || key.return` 误当成确认补全，
  // 导致菜单开着时按 Shift+Tab 会补全命令，而不是（只）循环权限模式。
  it('Shift+Tab（ESC[Z）不确认补全', async () => {
    const onPick = vi.fn()
    const r = render(<Suggestions items={items} onPick={onPick} />)
    await delay()
    r.stdin.write('\x1b[Z')
    expect(onPick).not.toHaveBeenCalled()
  })
})
