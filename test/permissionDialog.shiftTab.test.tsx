import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { PermissionDialog, INPUT_GUARD_MS } from '../src/tui/components/PermissionDialog.js'
import type { PendingAsk } from '../src/tui/useChat.js'
import { mockClock } from './helpers.js'

const ask: PendingAsk = { toolName: 'Write', desc: 'a.txt', dangerous: false } as PendingAsk

describe('PermissionDialog Shift+Tab = 允许并本会话不再问', () => {
  // 弹窗上屏后有 INPUT_GUARD_MS 的输入去抖窗口。冻住 Date.now 手动推过窗口，
  // 而不是真 sleep：真等待在全量并发下会被事件循环饿住，sleep 完仍在窗口内 → 按键被吞 → 随机翻车。
  let clock: ReturnType<typeof mockClock>
  beforeEach(() => { clock = mockClock() })
  afterEach(() => { clock.restore() })

  it('Shift+Tab 触发 onDecide("always")', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={ask} onDecide={onDecide} />)
    await new Promise(r => setTimeout(r, 20))   // 让 ink 完成挂载（与去抖判定无关）
    clock.advance(INPUT_GUARD_MS + 1)
    stdin.write('\x1b[Z')            // Shift+Tab（CSI Z / backtab）
    await new Promise(r => setTimeout(r, 20))
    expect(onDecide).toHaveBeenCalledWith('always')
  })
})
