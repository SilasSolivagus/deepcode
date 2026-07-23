// test/setup.command.test.tsx
// /setup 命令：App/FullscreenApp 双组件挂载 Setup 向导 overlay（照 modelPickerMode 全套）。
// 含 Task5 修复回归：Setup 挂 overlay 时不得调 ink exit()，否则 Esc 取消/完成会把整个 TUI 根实例杀掉。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() => (async function* () { throw new Error('script exhausted') })()),
}))

vi.mock('../src/config.js', async orig => ({
  ...(await orig() as any),
  saveOnboardingKeys: vi.fn(),
}))
vi.mock('../src/keyValidate.js', () => ({
  validateLlmKey: vi.fn(async () => ({ ok: true })),
  validateSearchKey: vi.fn(async () => ({ ok: true })),
  validateVisionKey: vi.fn(async () => ({ ok: true })),
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
import * as config from '../src/config.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  memRoot = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-mem-'))
  vi.clearAllMocks()
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

  // Task5 回归：Setup 在 overlay 里 Esc 取消 / 完成，绝不能调 ink exit()（会把整个 TUI 根实例杀掉）。
  // 判定"存活"＝overlay 关闭后再敲键，输入框仍回显新字符（若树已被 exit() 卸载，stdin.write 不会再改变 lastFrame）。
  it('App：/setup 后 Esc 取消 provider 步 → overlay 关闭，TUI 仍存活可继续输入', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-app-cancel-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    r.stdin.write('/setup')
    r.stdin.write('\r')
    await delay()
    expect(r.lastFrame()).toContain('先选 LLM provider')

    r.stdin.write('\x1B') // Esc：provider 步取消
    await delay()
    expect(r.lastFrame()).not.toContain('先选 LLM provider')

    // 树存活证明：Esc 取消后再敲字符，应回显进普通输入框（若根实例被 exit() 卸载，这里不会生效）
    r.stdin.write('hello-after-cancel')
    await delay()
    expect(r.lastFrame()).toContain('hello-after-cancel')
  })

  it('FullscreenApp：跑完整个向导到 DoneStep 按键关闭 → overlay 关闭，saveOnboardingKeys 被调用，TUI 仍存活可继续输入', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-setup-cmd-fs-complete-'))
    const r = render(<FullscreenApp client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    r.stdin.write('/setup')
    r.stdin.write('\r')
    await delay()
    expect(r.lastFrame()).toContain('先选 LLM provider')

    // provider 步：默认 DeepSeek，直接 Enter
    r.stdin.write('\r')
    await delay()

    // llmKey 步：录 key（validateLlmKey mock 已设 ok:true）
    r.stdin.write('sk-test-key')
    await delay()
    r.stdin.write('\r')
    await delay(30)

    // search 步：Bocha/Tavily 都 Enter 跳过
    r.stdin.write('\r')
    await delay()
    r.stdin.write('\r')
    await delay()

    // vision 步（DeepSeek 不复用，未自动跳过）：Enter 留空跳过
    r.stdin.write('\r')
    await delay(30)

    expect(config.saveOnboardingKeys).toHaveBeenCalledTimes(1)
    expect(r.lastFrame()).toContain('配置完成')

    // DoneStep：任意键关闭 overlay
    r.stdin.write('\r')
    await delay()
    expect(r.lastFrame()).not.toContain('配置完成')

    // 树存活证明：overlay 关闭后再敲字符，应回显进普通输入框
    r.stdin.write('hello-after-done')
    await delay()
    expect(r.lastFrame()).toContain('hello-after-done')
  })
})
