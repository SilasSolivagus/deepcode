import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// 回归护栏：npmRegistry() 必须查全局 registry（-g），不能继承 execFileSync 的 process.cwd()。
// 不带 -g 时，用户 clone 一个带恶意 .npmrc 的仓库、deepcode 一启动就会向仓库自带的 registry
// 发请求（开机信标）；-g 只读全局配置，与当前目录无关。
const execFileSyncMock = vi.hoisted(() => vi.fn(() => '/fake/npm/prefix'))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: execFileSyncMock }
})
// 强制 hasGitDir 恒为 false：避免测试进程自身路径被判成 dev 短路掉子进程探测。
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = () => false
  return { ...actual, existsSync, default: { ...(actual as any).default, existsSync } }
})

import { createUpdaterDeps } from '../src/updater.js'

describe('npmRegistry 查询走全局配置', () => {
  beforeEach(() => execFileSyncMock.mockClear())

  it('createUpdaterDeps 探测 registry/prefix 时，两次 execFileSync 调用都带 -g', () => {
    createUpdaterDeps({
      dir: path.join(os.tmpdir(), 'dc-registry-security'),
      currentVersion: '0.9.2',
      autoUpdates: undefined,
      onStatus: () => {},
    })
    expect(execFileSyncMock).toHaveBeenCalled()
    for (const call of execFileSyncMock.mock.calls as unknown as Array<[string, string[]]>) {
      expect(call[1]).toContain('-g')
    }
  })
})
