// test/useChat.providerSwitch.test.ts —— /model 跨 provider：预检 key → 写设置 → 重启并 --resume 恢复会话
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Settings } from '../src/config.js'

// 钉住 active provider = deepseek
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  const deepseek = actual.BUILTIN_PROVIDERS.deepseek
  return {
    ...actual,
    activeProvider: () => deepseek,
    activeFastModel: () => deepseek.models.fast,
    activeSmartModel: () => deepseek.models.smart,
  }
})

// 绝不真写 ~/.deepcode/settings.json：saveRawUserSettings 记账到 saved
let saved: Settings[] = []
vi.mock('../src/config.js', async orig => {
  const actual = await orig() as any
  return {
    ...actual,
    loadRawUserSettings: () => ({ provider: 'deepseek' }),
    saveRawUserSettings: (s: Settings) => { saved.push(s) },
  }
})

// glm key 由 glmKey 变量注入（预检 key 的分支）；globalBaseURL 注入 settings.baseURL（I1 分支）
let glmKey: string | undefined
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
          providers: glmKey ? { glm: { apiKey: glmKey } } : {},
          permissions: { allow: [], deny: [] },
          memory: { ...real.settings.memory, enabled: false },
        },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

vi.mock('../src/notify.js', async orig => ({ ...(await orig() as any), emitNotification: () => {} }))

import { createChatCore } from '../src/tui/useChat.js'

let sessionDir: string
let spawned: Array<{ cmd: string; args: string[] }>
let exited: number[]

beforeEach(() => {
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-pswitch-'))
  saved = []
  spawned = []
  exited = []
  glmKey = undefined
  globalBaseURL = undefined
  vi.stubEnv('ZHIPUAI_API_KEY', '')
})

const makeCore = () =>
  createChatCore({
    client: {} as any,
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

describe('/model 跨 provider 切换', () => {
  it('目标 provider 有 key → 写 settings(provider+model) 并重启', async () => {
    glmKey = 'zk-test'
    const core = makeCore()
    await core.send('/model glm-5.2')

    expect(saved).toHaveLength(1)
    expect(saved[0].provider).toBe('glm')
    expect(saved[0].model).toBe('glm-5.2')
    expect(spawned).toHaveLength(1)
    expect(exited).toEqual([0])
  })

  it('目标 provider 没配 key → 硬拒，不写 settings、不重启（防重启后开机即崩）', async () => {
    glmKey = undefined
    const core = makeCore()
    await core.send('/model glm-5.2')

    expect(saved).toHaveLength(0)
    expect(spawned).toHaveLength(0)
    expect(exited).toHaveLength(0)
    expect(notices(core)).toContain('ZHIPUAI_API_KEY')
  })

  it('有会话记录时带 --resume 重启，恢复当前会话', async () => {
    glmKey = 'zk-test'
    const core = makeCore()
    await core.send('先说句话，制造 transcript') // 无 client 脚本会失败，但 transcript 已有内容
    await core.send('/model glm-5.2')

    expect(spawned).toHaveLength(1)
    expect(spawned[0].args).toContain('--resume')
  })

  // I1：settings.baseURL 盖住所有 preset 的 baseURL（api.ts createClient）。带着它切 provider，
  // 结果是「新 provider 的 key + 旧端点」——切了等于没切，且换了个口子静默错投。
  it('存在全局 settings.baseURL → 硬拒，不写 settings、不重启', async () => {
    glmKey = 'zk-test'
    globalBaseURL = 'https://ds-mirror.internal/v1'
    const core = makeCore()
    await core.send('/model glm-5.2')

    expect(saved).toHaveLength(0)
    expect(spawned).toHaveLength(0)
    expect(notices(core)).toContain('baseURL')
  })

  it('同 provider 的档不触发重启（内存态切换，行为不变）', async () => {
    glmKey = 'zk-test'
    const core = makeCore()
    await core.send('/model deepseek-v4-pro')

    expect(core.state.model).toBe('deepseek-v4-pro')
    expect(saved).toHaveLength(0)
    expect(spawned).toHaveLength(0)
  })
})
