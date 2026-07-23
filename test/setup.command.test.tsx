// test/setup.command.test.tsx
// /setup 命令：App/FullscreenApp 双组件挂载 Setup 向导 overlay（照 modelPickerMode 全套）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() => (async function* () { throw new Error('script exhausted') })()),
}))

// App/FullscreenApp 未暴露 home 注入口；memdir 重定向到临时目录，防止活动日志真写 ~/.deepcode
let memRoot: string
vi.mock('../src/memdir/paths.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/paths.js')>()
  return { ...actual, memdirFor: () => memRoot }
})

import React from 'react'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import { FullscreenApp } from '../src/tui/FullscreenApp.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

beforeEach(() => {
  memRoot = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-mem-'))
})
afterEach(() => {
  rmSync(memRoot, { recursive: true, force: true })
})

describe('/setup 命令', () => {
  it('App：送 /setup 后出现 Setup 向导 overlay', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-app-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    r.stdin.write('/setup')
    r.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.lastFrame()).toContain('先选 LLM provider')
  })

  it('FullscreenApp：送 /setup 后出现 Setup 向导 overlay', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-fs-'))
    const r = render(<FullscreenApp client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await new Promise(resolve => setTimeout(resolve, 0))
    r.stdin.write('/setup')
    r.stdin.write('\r')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(r.lastFrame()).toContain('先选 LLM provider')
  })
})
