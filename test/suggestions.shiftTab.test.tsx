// test/suggestions.shiftTab.test.tsx —— 补全菜单键位：Tab 确认，Shift+Tab 不确认（留给权限模式循环）
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { Suggestions } from '../src/tui/components/Suggestions.js'

// ink 的 useInput 在 useEffect 中注册 stdin 监听器；需等一个微任务让 effect 跑完后才能写 stdin
const delay = async (ms = 0) => {
  // ⚠️ 两类等待必须都覆盖，缺一不可：
  // ① 有些调用点等的是**源码里的真实定时器**（如 InputBox 的 PASTE_COALESCE_MS=40 去抖窗口），
  //    这类必须让真实时间流逝——只让 tick 的话去抖压根不触发。
  // ② 有些等的是**异步活干完**（ink 挂载、useInput 注册、文件读取），这类靠固定时长不可靠：
  //    到点就走、不随负载自适应，全量并发下按键会打在还没监听的组件上。
  // 故：先睡满调用点要求的时长，再多让 8 个事件循环边界（每次在负载下都被调度器自然拉长）。
  if (ms > 0) await new Promise(r => setTimeout(r, ms))
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 1))
}

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
