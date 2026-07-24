import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 启动路径接线测试：
// - Bug#6（性能）：节流命中时不该构造 deps（零子进程），只有真要联网检查或缓存里已知有
//   更新版时才付这个代价。
// - Bug#9（测试覆盖缺口）：全局 DEEPCODE_DISABLE_UPDATES=1 是必要止血，但代价是「启动闸门 +
//   2s 定时器 + onStatus→setState」这条链此前没有任何用例覆盖。这里解除全局关闭 + fake
//   timers + mock 掉 createUpdaterDeps/startUpdateCheck，断言定时器触发后确实调用、且
//   DEEPCODE_DISABLE_UPDATES=1 时不调用。
const startUpdateCheckMock = vi.hoisted(() => vi.fn(async () => {}))
const createUpdaterDepsMock = vi.hoisted(() => vi.fn((o: any) => o))
const detectInstallCheapMock = vi.hoisted(() => vi.fn(() => ({ kind: 'foreign', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' })))

vi.mock('../src/updater.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/updater.js')>()
  return {
    ...actual,
    createUpdaterDeps: createUpdaterDepsMock,
    startUpdateCheck: startUpdateCheckMock,
    detectInstallCheap: detectInstallCheapMock,
  }
})

import { createChatCore } from '../src/tui/useChat.js'
import { writeUpdateState } from '../src/updater.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-startup-'))

describe('启动升级检查节流闸接线', () => {
  beforeEach(() => {
    startUpdateCheckMock.mockClear()
    createUpdaterDepsMock.mockClear()
    detectInstallCheapMock.mockClear()
    detectInstallCheapMock.mockReturnValue({ kind: 'foreign', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('DEEPCODE_DISABLE_UPDATES=1 → 定时器触发后仍不调用（全局关闭生效）', () => {
    vi.stubEnv('DEEPCODE_DISABLE_UPDATES', '1')
    vi.useFakeTimers()
    createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home: tmpDir(), onState: () => {} })
    vi.advanceTimersByTime(3000)
    expect(createUpdaterDepsMock).not.toHaveBeenCalled()
    expect(startUpdateCheckMock).not.toHaveBeenCalled()
  })

  it('解除全局关闭 + 无节流缓存 → 2s 后确实调用 createUpdaterDeps + startUpdateCheck', () => {
    vi.stubEnv('DEEPCODE_DISABLE_UPDATES', '')
    vi.useFakeTimers()
    createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home: tmpDir(), onState: () => {} })
    expect(createUpdaterDepsMock).not.toHaveBeenCalled() // 2s 前不该跑
    vi.advanceTimersByTime(2100)
    expect(createUpdaterDepsMock).toHaveBeenCalled()
    expect(startUpdateCheckMock).toHaveBeenCalled()
  })

  it('节流命中 + 缓存无更新版 → 零调用 createUpdaterDeps（Bug#6：避免白跑两次同步子进程）', () => {
    vi.stubEnv('DEEPCODE_DISABLE_UPDATES', '')
    vi.useFakeTimers()
    const home = tmpDir()
    writeUpdateState(path.join(home, '.deepcode'), { lastCheckAt: Date.now(), latest: '0.0.1' }) // 远旧于当前版本
    createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home, onState: () => {} })
    vi.advanceTimersByTime(3000)
    expect(createUpdaterDepsMock).not.toHaveBeenCalled()
    expect(startUpdateCheckMock).not.toHaveBeenCalled()
  })

  it('节流命中 + 缓存显示有新版 → 立刻展示 available，且零调用 createUpdaterDeps（Bug#6）', () => {
    vi.stubEnv('DEEPCODE_DISABLE_UPDATES', '')
    const home = tmpDir()
    writeUpdateState(path.join(home, '.deepcode'), { lastCheckAt: Date.now(), latest: '99.0.0' })
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home, onState: () => {} })
    expect(createUpdaterDepsMock).not.toHaveBeenCalled()
    expect(core.state.updateStatus).toEqual({ phase: 'available', latest: '99.0.0', command: 'npm i -g @silassolivagus/deepcode@latest' })
  })
})
