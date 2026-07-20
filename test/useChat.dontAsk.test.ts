// test/useChat.dontAsk.test.ts
import { describe, it, expect } from 'vitest'
import { nextPermMode } from '../src/tui/useChat.js'

describe('nextPermMode 含 dontAsk', () => {
  it('plan→dontAsk→default（disableAuto=false 全循环）', () => {
    expect(nextPermMode('default', false)).toBe('auto')
    expect(nextPermMode('auto', false)).toBe('acceptEdits')
    expect(nextPermMode('acceptEdits', false)).toBe('plan')
    expect(nextPermMode('plan', false)).toBe('dontAsk')
    expect(nextPermMode('dontAsk', false)).toBe('default')
  })
  it('disableAuto 跳过 auto，plan→dontAsk 仍在链', () => {
    expect(nextPermMode('default', true)).toBe('acceptEdits')
    expect(nextPermMode('plan', true)).toBe('dontAsk')
    expect(nextPermMode('dontAsk', true)).toBe('default')
  })
})
