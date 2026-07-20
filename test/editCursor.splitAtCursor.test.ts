// test/editCursor.splitAtCursor.test.ts
import { describe, it, expect } from 'vitest'
import { splitAtCursor } from '../src/tui/editCursor.js'

describe('splitAtCursor', () => {
  it('中间光标：before/at/after 三段', () => {
    expect(splitAtCursor('abc', 1)).toEqual({ before: 'a', at: 'b', after: 'c' })
  })
  it('末尾光标：at 为空（渲染时反色空格）', () => {
    expect(splitAtCursor('abc', 3)).toEqual({ before: 'abc', at: '', after: '' })
  })
  it('行首光标', () => {
    expect(splitAtCursor('abc', 0)).toEqual({ before: '', at: 'a', after: 'bc' })
  })
  it('空串', () => {
    expect(splitAtCursor('', 0)).toEqual({ before: '', at: '', after: '' })
  })
  it('emoji 字素不撕裂（👍 = 2 UTF-16 单元）', () => {
    expect(splitAtCursor('👍x', 0)).toEqual({ before: '', at: '👍', after: 'x' })
  })
})
