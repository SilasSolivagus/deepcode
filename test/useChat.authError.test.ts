// test/useChat.authError.test.ts —— 运行中 provider key 失效（401/invalid）：优雅失败 + 弹当前 provider 的就地 key 重录（复用 Task6 overlay）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Settings } from '../src/config.js'

// 钉住 active provider = deepseek，settings 干净（不读真实 ~/.deepcode）
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
          baseURL: undefined,
          providers: {},
          permissions: { allow: [], deny: [] },
          memory: { ...real.settings.memory, enabled: false },
        },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

// chatStream 打桩抛出鉴权错误；isAuthError 保留真实实现（spread 原模块）
let scriptedError: any
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() => (async function* () { throw scriptedError })()),
}))

// saveOnboardingKeys 打桩记账；saveRawUserSettings/loadRawUserSettings 记账，用来断言就地恢复不触发 switchProvider 的重启写盘
let savedKeys: any[] = []
let savedRaw: Settings[] = []
vi.mock('../src/config.js', async orig => ({
  ...(await orig() as any),
  saveOnboardingKeys: vi.fn((k: any) => { savedKeys.push(k) }),
  loadRawUserSettings: () => ({ provider: 'deepseek' }),
  saveRawUserSettings: (s: Settings) => { savedRaw.push(s) },
}))

vi.mock('../src/notify.js', async orig => ({ ...(await orig() as any), emitNotification: () => {} }))

import { createChatCore } from '../src/tui/useChat.js'

let sessionDir: string
let spawned: Array<{ cmd: string; args: string[] }>
let exited: number[]
let client: { apiKey: string; chat?: any }

beforeEach(() => {
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-autherr-'))
  spawned = []
  exited = []
  savedKeys = []
  savedRaw = []
  client = { apiKey: 'old-invalid-key' }
  scriptedError = Object.assign(new Error('401 Incorrect API key provided'), { status: 401 })
})

const makeCore = () =>
  createChatCore({
    client: client as any,
    yolo: false,
    cwd: '/tmp',
    sessionDir,
    onState: () => {},
    unmount: () => {},
    spawnSyncFn: (cmd: string, args: string[]) => { spawned.push({ cmd, args }); return { status: 0 } },
    exitFn: (code: number) => { exited.push(code) },
  } as any)

const notices = (core: ReturnType<typeof makeCore>): string =>
  core.state.transcript.filter(i => i.kind === 'notice').map(i => (i as any).text).join('\n')

describe('运行中 provider key 失效（401/invalid）恢复', () => {
  it('鉴权错误 → 优雅失败通知 + 挂起 pendingKeyEntry（当前 provider），不是裸错误堆栈', async () => {
    const core = makeCore()
    await core.send('你好')

    expect(notices(core)).toContain('DeepSeek')
    expect(notices(core)).toContain('API key 失效或无效')
    expect(notices(core)).not.toContain('[错误]') // 走的是专门的鉴权 notice，不是兜底错误通知
    expect(core.state.pendingKeyEntry).toEqual({
      providerId: 'deepseek', label: 'DeepSeek', baseURL: expect.any(String), model: expect.any(String), modelId: expect.any(String),
    })
  })

  it('限流（429）不误判为鉴权失效——维持原有错误处理不变，不弹重录', async () => {
    scriptedError = Object.assign(new Error('Rate limit reached'), { status: 429 })
    const core = makeCore()
    await core.send('你好')

    expect(core.state.pendingKeyEntry).toBeNull()
    expect(notices(core)).toContain('[错误]')
    expect(notices(core)).not.toContain('API key 失效或无效')
  })

  it('录入新 key → 保存、热改 client.apiKey、提示可重新发送，不触发 switchProvider 重启', async () => {
    const core = makeCore()
    await core.send('你好')
    expect(core.state.pendingKeyEntry).not.toBeNull()

    core.resolveKeyEntry('sk-new-valid-key')

    expect(savedKeys).toEqual([{ providerKeys: { deepseek: 'sk-new-valid-key' } }])
    expect(client.apiKey).toBe('sk-new-valid-key') // 热改已建好的 client，无需重启即可生效
    expect(notices(core)).toContain('已更新')
    expect(notices(core)).toContain('可重新发送')
    expect(core.state.pendingKeyEntry).toBeNull()
    // 就地恢复：不是 /model 跨 provider 切换，不应触发 switchProvider 的重启式写盘/spawn/exit
    expect(savedRaw).toHaveLength(0)
    expect(spawned).toHaveLength(0)
    expect(exited).toHaveLength(0)
  })

  it('Esc/取消 key 录入 → 只清挂起，不保存 key，轮次仍是失败态', async () => {
    const core = makeCore()
    await core.send('你好')
    expect(core.state.pendingKeyEntry).not.toBeNull()

    core.resolveKeyEntry(undefined)

    expect(savedKeys).toHaveLength(0)
    expect(client.apiKey).toBe('old-invalid-key')
    expect(core.state.pendingKeyEntry).toBeNull()
  })
})
