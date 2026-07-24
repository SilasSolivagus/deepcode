import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'
import os from 'node:os'

// 回归护栏：createUpdaterDeps 在判定为 dev 时不应跑任何 npm 子进程探测。
// 之前实现无条件调 npmPrefix()/npmRegistry()（各一次 execFileSync），
// 导致每个建 ChatCore 的既有测试都会在后台真跑 npm 子进程（静默污染，不会让用例变红）。
//
// mock fs.existsSync 强制「任意目录的 .git 探测都命中」，与「测试进程自身路径是否恰好落在
// 仓库 5 层向上查找范围内」这一环境细节解耦——直接验证「一旦判成 dev，不该跑任何 npm 子进程」
// 这条不变量本身（真实 vitest worker 的 argv[1] 深埋 node_modules/vitest/dist/workers/，
// 未必落在 5 层查找范围内，不能作为可靠的 dev 判定依据）。
const execFileSyncMock = vi.hoisted(() => vi.fn(() => '/fake/npm/prefix'))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: execFileSyncMock }
})
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const existsSync = () => true
  return { ...actual, existsSync, default: { ...(actual as any).default, existsSync } }
})

import { createUpdaterDeps } from '../src/updater.js'

describe('createUpdaterDeps 在 dev 形态下零子进程', () => {
  beforeEach(() => execFileSyncMock.mockClear())

  it('判成 dev 时，创建 deps 不应调用 execFileSync', () => {
    const deps = createUpdaterDeps({
      dir: path.join(os.tmpdir(), 'dc-nosubprocess'),
      currentVersion: '0.9.2',
      autoUpdates: undefined,
      onStatus: () => {},
    })
    expect(deps.install.kind).toBe('dev')
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})
