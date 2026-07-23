import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { PermissionDialog } from '../src/tui/components/PermissionDialog.js'
import type { PendingAsk } from '../src/tui/useChat.js'

const ask: PendingAsk = { toolName: 'Write', desc: 'a.txt', dangerous: false } as PendingAsk

describe('PermissionDialog Shift+Tab = 允许并本会话不再问', () => {
  it('Shift+Tab 触发 onDecide("always")', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={ask} onDecide={onDecide} />)
    await new Promise(r => setTimeout(r, 20))
    stdin.write('\x1b[Z')            // Shift+Tab（CSI Z / backtab）
    await new Promise(r => setTimeout(r, 20))
    expect(onDecide).toHaveBeenCalledWith('always')
  })
})
