// test/useChat.providerGuard.test.ts —— /model 跨 provider 硬拒 + 启动期 settings.model 归属校验
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 钉住 active provider = deepseek，免疫宿主机 ~/.deepcode/settings.json 的 provider 配置
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

// settings.model 由 settingsModel 变量注入；同时钉空权限规则、关记忆，隔离宿主机配置
let settingsModel: string | undefined
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
          // 钉死 provider：代码用 resolveActiveProvider(settings) 解析 preset，若摊开宿主机真实 settings，
          // 测试会随开发机的 provider 配置漂移（本仓历史教训）。
          provider: 'deepseek',
          model: settingsModel,
          permissions: { allow: [], deny: [] },
          memory: { ...real.settings.memory, enabled: false },
        },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

vi.mock('../src/notify.js', async orig => ({
  ...(await orig() as any),
  emitNotification: () => {},
}))

import { createChatCore } from '../src/tui/useChat.js'

let sessionDir: string
beforeEach(() => {
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-pguard-'))
  settingsModel = undefined
})

const makeCore = () =>
  createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })

const notices = (core: ReturnType<typeof makeCore>): string =>
  core.state.transcript
    .filter((i): i is Extract<typeof i, { kind: 'notice' }> => i.kind === 'notice')
    .map(i => i.text)
    .join('\n')

describe('/model 跨 provider', () => {
  // 跨 provider 需重启（见 useChat.providerSwitch.test.ts）。无重启能力时（未注入 unmount，
  // 如非交互环境）绝不静默错投——拒绝且保持 model 不变。
  it('无重启能力时切到别的 provider 的档 → 拒绝，model 不变', async () => {
    const core = makeCore()
    const before = core.state.model
    await core.send('/model glm-5.2')
    expect(core.state.model).toBe(before)
    expect(notices(core)).toContain('重启')
  })

  it('切到本 provider 的档 → 正常生效', async () => {
    const core = makeCore()
    await core.send('/model deepseek-v4-pro')
    expect(core.state.model).toBe('deepseek-v4-pro')
  })

  it('切到无人认领的未知档 → 仍放行（custom / 未来新档不被误伤）', async () => {
    const core = makeCore()
    await core.send('/model my-local-llama')
    expect(core.state.model).toBe('my-local-llama')
  })
})

describe('启动期 settings.model 归属校验', () => {
  it('settings.model 属于别的 provider → 回落 active fast 并告警', () => {
    settingsModel = 'glm-5.2'
    const core = makeCore()
    expect(core.state.model).toBe('deepseek-v4-flash')
    expect(notices(core)).toContain('glm-5.2')
  })

  it('settings.model 属于当前 provider → 原样使用，不告警', () => {
    settingsModel = 'deepseek-v4-pro'
    const core = makeCore()
    expect(core.state.model).toBe('deepseek-v4-pro')
    expect(notices(core)).not.toContain('回落')
  })
})
