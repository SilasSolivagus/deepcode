// test/model.keyEntry.test.tsx
// /model 切到未配 key 的 provider → 就地录入 overlay（不再硬报错）。
// App/FullscreenApp 双组件核对，照 setup.command.test.tsx 全套（含 Task5 存活回归判定）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() => (async function* () { throw new Error('script exhausted') })()),
}))

// saveOnboardingKeys 打桩记账；loadSettings 打桩控制 resolveKeyEntry 存 key 后的重读结果——
// 默认仍报未就绪（不触发真实 switchProvider 重启路径），单独一个用例把它切成"已就绪"验证 overlay 关闭。
let loadSettingsReady = false
vi.mock('../src/config.js', async orig => ({
  ...(await orig() as any),
  saveOnboardingKeys: vi.fn(),
  loadSettings: vi.fn(() => (loadSettingsReady ? { providers: { glm: { apiKey: 'saved-key' } } } : { providers: {} })),
}))

vi.mock('../src/keyValidate.js', () => ({
  validateLlmKey: vi.fn(async () => ({ ok: true })),
  validateSearchKey: vi.fn(async () => ({ ok: true })),
  validateVisionKey: vi.fn(async () => ({ ok: true })),
}))

// 钉住初始 settings：deepseek 无 key 约束 active、GLM 未配 key、无全局 baseURL（除非该用例覆盖）。
let globalBaseURL: string | undefined
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = (await orig()) as any
  return {
    ...actual,
    loadLayeredSettings: (cwd: string, flagPath?: string) => {
      const real = actual.loadLayeredSettings(cwd, flagPath)
      return {
        ...real,
        settings: {
          ...real.settings,
          provider: 'deepseek',
          model: undefined,
          apiKey: undefined,
          baseURL: globalBaseURL,
          providers: {},
          permissions: { allow: [], deny: [] },
          memory: { ...real.settings.memory, enabled: false },
        },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

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
import { allModelList, BUILTIN_PROVIDERS } from '../src/providers.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const DOWN = '\x1B[B'

// 挑中列表里第一个 GLM 档（未配 key）相对起始项的下移次数，不依赖硬编码下标。
const glmDownPresses = (() => {
  const items = allModelList({ provider: 'deepseek', providers: {} } as any, BUILTIN_PROVIDERS.deepseek.models.smart)
  const idx = items.findIndex(i => i.providerId === 'glm')
  if (idx < 0) throw new Error('测试前置假设失败：modelList 里找不到 GLM 档')
  return idx
})()

beforeEach(() => {
  memRoot = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-mem-'))
  globalBaseURL = undefined
  loadSettingsReady = false
  vi.clearAllMocks()
  vi.stubEnv('ZHIPUAI_API_KEY', '')
  vi.stubEnv('MOONSHOT_API_KEY', '')
})
afterEach(() => {
  rmSync(memRoot, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function openModelPickerAndPickGlm(stdin: { write: (s: string) => void }) {
  stdin.write('/model')
  stdin.write('\r')
  await delay()
  // 逐次单独 write + delay：一次性 write 多个 DOWN 转义序列会被解析器合并/丢失，必须分开喂
  for (let i = 0; i < glmDownPresses; i++) {
    stdin.write(DOWN)
    await delay()
  }
  stdin.write('\r')
  await delay()
}

describe('/model 切到未配 key 的 provider', () => {
  it('App：选中 GLM（无 key）→ 弹 key 录入 overlay，不再是旧的硬错误通知', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-app-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    await openModelPickerAndPickGlm(r.stdin)

    expect(r.lastFrame()).toContain('🐳 切换到 GLM')
    expect(r.lastFrame()).not.toContain('未配置 API key，无法切换')
  })

  it('FullscreenApp：选中 GLM（无 key）→ 弹 key 录入 overlay，不再是旧的硬错误通知', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-fs-'))
    const r = render(<FullscreenApp client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    await openModelPickerAndPickGlm(r.stdin)

    expect(r.lastFrame()).toContain('🐳 切换到 GLM')
    expect(r.lastFrame()).not.toContain('未配置 API key，无法切换')
  })

  it('App：全局 settings.baseURL 存在时，预检先于 key 录入命中——不弹 key 录入 overlay', async () => {
    globalBaseURL = 'https://ds-mirror.internal/v1'
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-baseurl-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    await openModelPickerAndPickGlm(r.stdin)

    expect(r.lastFrame()).not.toContain('🐳 切换到 GLM')
    expect(r.lastFrame()).toContain('baseURL')
  })

  it('FullscreenApp：录入 key 验证成功 → saveOnboardingKeys 落盘 key、overlay 关闭、TUI 仍存活可继续输入', async () => {
    loadSettingsReady = true // 存完 key 后重读判定就绪，resolveKeyEntry 才会真正走完（命中未接 unmount 的安全兜底）而不是重挂起
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-fs-save-'))
    const r = render(<FullscreenApp client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    await openModelPickerAndPickGlm(r.stdin)
    expect(r.lastFrame()).toContain('🐳 切换到 GLM')

    r.stdin.write('zk-test-key-123')
    await delay()
    r.stdin.write('\r')
    await delay(30)

    expect(config.saveOnboardingKeys).toHaveBeenCalledTimes(1)
    expect(config.saveOnboardingKeys).toHaveBeenCalledWith({ providerKeys: { glm: 'zk-test-key-123' } })

    expect(r.lastFrame()).not.toContain('🐳 切换到 GLM')

    // 树存活证明：overlay 关闭后再敲字符，应回显进普通输入框
    r.stdin.write('hello-after-keyentry')
    await delay()
    expect(r.lastFrame()).toContain('hello-after-keyentry')
  })

  it('App：Esc 取消 key 录入 → overlay 关闭、不保存 key、TUI 仍存活可继续输入', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-model-keyentry-app-cancel-'))
    const r = render(<App client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)
    await openModelPickerAndPickGlm(r.stdin)
    expect(r.lastFrame()).toContain('🐳 切换到 GLM')

    r.stdin.write('\x1B') // Esc 取消
    await delay()
    expect(r.lastFrame()).not.toContain('🐳 切换到 GLM')
    expect(config.saveOnboardingKeys).not.toHaveBeenCalled()

    r.stdin.write('hello-after-cancel')
    await delay()
    expect(r.lastFrame()).toContain('hello-after-cancel')
  })
})
