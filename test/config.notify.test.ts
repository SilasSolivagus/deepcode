import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings } from '../src/config.js'

// parsePresent 未从 settingsLayers.ts export，改测 loadSettings(dir, flagFile) 端到端
// （与 test/settingsLayers.test.ts 的 flag scope 既有模式一致）。
describe('通知设置键解析', () => {
  it('loadSettings 读 preferredNotifChannel 合法值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-notif-'))
    const flagFile = join(dir, 'flag.json')
    try {
      writeFileSync(flagFile, JSON.stringify({ preferredNotifChannel: 'terminal_bell' }))
      expect(loadSettings(dir, flagFile).preferredNotifChannel).toBe('terminal_bell')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('loadSettings 丢弃非法 preferredNotifChannel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-notif-'))
    const flagFile = join(dir, 'flag.json')
    try {
      writeFileSync(flagFile, JSON.stringify({ preferredNotifChannel: 'bogus' }))
      expect(loadSettings(dir, flagFile).preferredNotifChannel).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('loadSettings 读 messageIdleNotifThresholdMs 正数', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-notif-'))
    const flagFile = join(dir, 'flag.json')
    try {
      writeFileSync(flagFile, JSON.stringify({ messageIdleNotifThresholdMs: 30000 }))
      expect(loadSettings(dir, flagFile).messageIdleNotifThresholdMs).toBe(30000)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
  it('loadSettings 丢弃非正数阈值', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-notif-'))
    const flagFile = join(dir, 'flag.json')
    try {
      writeFileSync(flagFile, JSON.stringify({ messageIdleNotifThresholdMs: -1 }))
      expect(loadSettings(dir, flagFile).messageIdleNotifThresholdMs).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
