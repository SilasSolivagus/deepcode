import { describe, it, expect } from 'vitest'
import { notifSequence, resolveNotifChannel, NOTIF_CHANNELS } from '../src/notify.js'

const BEL = '\x07'
describe('notifSequence 按渠道', () => {
  it('disabled → null', () => {
    expect(notifSequence('hi', 'notifications_disabled')).toBeNull()
  })
  it('terminal_bell → 仅 BEL，无 OSC', () => {
    expect(notifSequence('hi', 'terminal_bell')).toBe(BEL)
  })
  it('iterm2 → OSC 9 无 BEL', () => {
    const s = notifSequence('hi', 'iterm2')!
    expect(s).toContain('\x1b]9;hi')
    expect(s.endsWith(BEL + BEL)).toBe(false) // 无末尾双铃
  })
  it('iterm2_with_bell → OSC 9 + BEL', () => {
    const s = notifSequence('hi', 'iterm2_with_bell')!
    expect(s).toContain('\x1b]9;hi')
    expect(s.endsWith(BEL)).toBe(true)
  })
  it('kitty → OSC 99', () => {
    expect(notifSequence('hi', 'kitty')).toContain('\x1b]99;')
  })
  it('ghostty → OSC 777', () => {
    expect(notifSequence('hi', 'ghostty')).toContain('\x1b]777;notify')
  })
  it('auto → 按 term 探测（kitty term → OSC 99）', () => {
    expect(notifSequence('hi', 'auto', 'kitty')).toContain('\x1b]99;')
  })
})

describe('resolveNotifChannel', () => {
  it('未设 → auto（默认开）', () => expect(resolveNotifChannel(undefined)).toBe('auto'))
  it('非法 → auto', () => expect(resolveNotifChannel('bogus')).toBe('auto'))
  it('合法透传', () => expect(resolveNotifChannel('terminal_bell')).toBe('terminal_bell'))
  it('枚举含 7 值', () => expect(NOTIF_CHANNELS).toHaveLength(7))
})
