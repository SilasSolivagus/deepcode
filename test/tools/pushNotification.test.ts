import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// src/config.ts 在模块加载时就计算 DIR = path.join(os.homedir(), '.deepcode')，
// pushNotification.ts 的 call() 会读 loadSettings(ctx.cwd()).preferredNotifChannel，
// 其 user 层始终来自 os.homedir()（与 cwd 无关）。必须在 import 之前把 node:os 的
// homedir mock 到临时目录，否则会读到真实 ~/.deepcode/settings.json，测试非 hermetic
// （若真实机器上设了 preferredNotifChannel: 'terminal_bell'/'notifications_disabled'，
// 下面的 OSC 字节断言会失败）。mock 手法与 test/config.test.ts:15-22 一致。
vi.mock('node:os', async importOriginal => {
  const os = await importOriginal<typeof import('node:os')>()
  const { mkdtempSync } = await import('node:fs')
  const path = await import('node:path')
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dc-notif-'))
  const homedir = () => fakeHome
  return { ...os, homedir, default: { ...os, homedir } }
})

import fs from 'node:fs'
import { oscNotification, pushNotificationTool } from '../../src/tools/pushNotification.js'

describe('oscNotification', () => {
  it('iTerm/默认 → OSC 9 + 独立 BEL', () => {
    expect(oscNotification('hi', 'iTerm.app')).toBe('\x1b]9;hi\x07\x07')
  })
  it('Ghostty → OSC 777 + 独立 BEL', () => {
    expect(oscNotification('hi', 'ghostty')).toContain('\x1b]777;notify;')
    expect(oscNotification('hi', 'ghostty')).toMatch(/\x07\x07$/)
  })
  it('未知终端 → OSC 9 + 独立 BEL 响铃兜底', () => {
    expect(oscNotification('hi', 'unknown')).toBe('\x1b]9;hi\x07\x07')
    expect(oscNotification('hi', 'unknown')).toMatch(/\x07\x07$/)
  })
})

describe('PushNotification tool', () => {
  const ctx = { cwd: () => process.cwd() } as any

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('截断到 200 字 + 返回已发提示', async () => {
    const out = await pushNotificationTool.call({ message: 'x'.repeat(300), status: 'proactive' }, ctx)
    expect(out).toMatch(/已发送|通知/)
    expect(out).toContain('已发送桌面通知：' + 'x'.repeat(200))
  })

  it('优先写入 /dev/tty 成功时调用 fs.writeFileSync', async () => {
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => undefined as any)
    const out = await pushNotificationTool.call({ message: 'hi', status: 'proactive' }, ctx)
    expect(spy).toHaveBeenCalledWith('/dev/tty', expect.stringContaining('\x1b]'))
    expect(out).toContain('已发送桌面通知：hi')
  })

  it('当 /dev/tty 写入失败时回退到 process.stdout.write', async () => {
    const fsSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('ENODEV')
    })
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const out = await pushNotificationTool.call({ message: 'fallback', status: 'proactive' }, ctx)
    expect(fsSpy).toHaveBeenCalledWith('/dev/tty', expect.any(String))
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('\x1b]'))
    expect(out).toContain('已发送桌面通知：fallback')
  })
})
