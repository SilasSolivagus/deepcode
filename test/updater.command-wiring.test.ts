import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// /update 命令行为的接线测试：mock 掉 updater.js 的编排/工厂/零成本探测，只验证 useChat.ts
// 这一层「收到什么 phase → 给用户看什么文案」的接线是否正确（Bug#4：已是最新/查询失败/dev
// 形态过去零输出）。真实编排逻辑已在 test/updater.orchestrate.test.ts 单独覆盖。
const startUpdateCheckMock = vi.hoisted(() => vi.fn(async (_deps: any) => {}))
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

import { createChatCore, displayTextOf } from '../src/tui/useChat.js'

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dc-cmdwire-'))
const textOf = (it: any): string => ('segments' in it ? displayTextOf(it) : (it.text ?? ''))

describe('/update 命令文案接线', () => {
  let prevDisable: string | undefined

  beforeEach(() => {
    startUpdateCheckMock.mockClear()
    createUpdaterDepsMock.mockClear()
    detectInstallCheapMock.mockClear()
    detectInstallCheapMock.mockReturnValue({ kind: 'foreign', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' })
    prevDisable = process.env.DEEPCODE_DISABLE_UPDATES
    process.env.DEEPCODE_DISABLE_UPDATES = ''
  })

  afterEach(() => {
    if (prevDisable === undefined) delete process.env.DEEPCODE_DISABLE_UPDATES
    else process.env.DEEPCODE_DISABLE_UPDATES = prevDisable
  })

  it('phase up-to-date → 提示已是最新版（Bug#4：此前零输出）', async () => {
    const states: any[] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home: tmpDir(), onState: s => states.push(s) })
    await core.send('/update')
    const deps = startUpdateCheckMock.mock.calls.at(-1)![0]
    deps.onStatus({ phase: 'up-to-date', latest: '9.9.9' })
    const texts = states.at(-1)!.transcript.map(textOf).join('\n')
    expect(texts).toContain('已是最新版')
  })

  it('phase check-failed → 提示检查失败（Bug#4：此前零输出）', async () => {
    const states: any[] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home: tmpDir(), onState: s => states.push(s) })
    await core.send('/update')
    const deps = startUpdateCheckMock.mock.calls.at(-1)![0]
    deps.onStatus({ phase: 'check-failed' })
    const texts = states.at(-1)!.transcript.map(textOf).join('\n')
    expect(texts).toContain('检查新版本失败')
  })

  it('dev 形态 → 单独兜底提示，且不调用 startUpdateCheck（Bug#4：此前 dev 下 /update 彻底零反馈）', async () => {
    detectInstallCheapMock.mockReturnValue({ kind: 'dev', upgradeCommand: 'npm i -g @silassolivagus/deepcode@latest' })
    const states: any[] = []
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir: tmpDir(), home: tmpDir(), onState: s => states.push(s) })
    await core.send('/update')
    const texts = states.at(-1)!.transcript.map(textOf).join('\n')
    expect(texts).toContain('仓库工作副本')
    expect(startUpdateCheckMock).not.toHaveBeenCalled()
  })
})
