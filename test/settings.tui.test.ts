import { describe, it, expect } from 'vitest'
import { resolveRenderer, resolveInitialFocus } from '../src/tui/viewMode.js'

describe('resolveRenderer', () => {
  const base = { bg: false, isTTY: true, inlineFlag: false, settings: {} as any }
  it('bg 会话强制 fullscreen', () => {
    expect(resolveRenderer({ ...base, bg: true, settings: { tui: 'inline' } })).toBe('fullscreen')
  })
  it('非 TTY 走 headless', () => {
    expect(resolveRenderer({ ...base, isTTY: false })).toBe('headless')
  })
  it('--inline flag 覆盖 settings', () => {
    expect(resolveRenderer({ ...base, inlineFlag: true, settings: { tui: 'fullscreen' } })).toBe('inline')
  })
  it('settings.tui 显式生效', () => {
    expect(resolveRenderer({ ...base, settings: { tui: 'inline' } })).toBe('inline')
  })
  it('旧 inline:true 向后兼容', () => {
    expect(resolveRenderer({ ...base, settings: { inline: true } })).toBe('inline')
  })
  it('tui 优先于旧 inline', () => {
    expect(resolveRenderer({ ...base, settings: { tui: 'fullscreen', inline: true } })).toBe('fullscreen')
  })
  it('默认 fullscreen', () => {
    expect(resolveRenderer(base)).toBe('fullscreen')
  })
})

describe('resolveInitialFocus', () => {
  it('viewMode=focus 启动即开且锁定', () => {
    expect(resolveInitialFocus({ viewMode: 'focus' })).toEqual({ focusMode: true, locked: true })
  })
  it('未设则关闭不锁', () => {
    expect(resolveInitialFocus({})).toEqual({ focusMode: false, locked: false })
  })
})
