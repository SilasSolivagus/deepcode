// test/headless.memory.test.ts
// opus 评审 I2：headless 生产路径（deepcode -p "..."）此前不注入全局记忆抽屉，
// 用户在 A 项目记下的红线偏好在 B 项目 headless 跑时静默失效。验证注入侧已补齐。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', () => ({
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// 与 test/headless.test.ts 同款隔离：固定 mockSettings，不读开发者真实 ~/.deepcode/settings.json
// （否则真实 hooks/permissions 会在测试里被执行，且行为依赖机器状态）。
// mockSettings 不含 memory 字段 → useChat/headless 侧 `settings.memory ?? DEFAULT_MEMORY_CONFIG`
// 落到 DEFAULT_MEMORY_CONFIG（global.enabled=true），恰好是本次要验证的默认接线路径。
const mockSettings = {
  permissions: { allow: [] },
  compactTokens: 200_000,
  costWarnCNY: 15,
}
vi.mock('../src/config.js', async (orig) => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})
vi.mock('../src/settingsLayers.js', async (orig) => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings,
      provenance: {},
      permissionSources: { allow: {}, deny: {} },
      scopes: [],
    })),
  }
})

import { runHeadless } from '../src/headless.js'
import { chatStream } from '../src/api.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 10 }

let home: string
beforeEach(() => {
  script.length = 0
  vi.mocked(chatStream).mockClear()
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-headless-home-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('runHeadless 全局记忆抽屉注入（opus 评审 I2）', () => {
  it('系统提示里含全局记忆全文（headless -p 是真实生产路径，红线偏好必须在场）', async () => {
    const globalMemDir = path.join(home, '.deepcode', 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    writeFileSync(path.join(globalMemDir, 'tw.md'), '---\ntype: user\n---\n不喜欢 tailwind。')

    script.push({ deltas: ['好的'], result: { content: '好的', toolCalls: [], usage, finishReason: 'stop' } })

    await runHeadless({ client: {} as any, prompt: '搭个落地页', yolo: true, home })

    const call = vi.mocked(chatStream).mock.calls.at(0)
    expect(call).toBeDefined()
    const sysMsg = call![1].messages[0]
    expect(sysMsg.role).toBe('system')
    expect(sysMsg.content).toContain('不喜欢 tailwind。')
  })

  it('未注入 home 时不 throw（生产走真实 os.homedir()，此处仅冒烟接线不报错）', async () => {
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await expect(runHeadless({ client: {} as any, prompt: 'hi', yolo: true })).resolves.toBeDefined()
  })
})
