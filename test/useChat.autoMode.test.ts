import { describe, it, expect } from 'vitest'
import { nextPermMode } from '../src/tui/useChat.js'

describe('nextPermMode 五态循环', () => {
  it('default→auto→acceptEdits→plan→dontAsk→default', () => {
    expect(nextPermMode('default', false)).toBe('auto')
    expect(nextPermMode('auto', false)).toBe('acceptEdits')
    expect(nextPermMode('acceptEdits', false)).toBe('plan')
    expect(nextPermMode('plan', false)).toBe('dontAsk')
    expect(nextPermMode('dontAsk', false)).toBe('default')
  })
  it('disableAutoMode=true 时跳过 auto', () => {
    expect(nextPermMode('default', true)).toBe('acceptEdits')
  })
})
