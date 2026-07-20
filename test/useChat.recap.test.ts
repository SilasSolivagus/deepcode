// test/useChat.recap.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 隔离真实 provider 配置：pinning activeProvider/activeFastModel 为 deepseek 档，
// 使测试对 ~/.deepcode/settings.json 中 provider:glm 免疫（/model 切换、rotateModel 等依赖此）。
vi.mock('../src/providers.js', async orig => {
  const actual = await orig() as any
  const deepseekPreset = actual.BUILTIN_PROVIDERS.deepseek
  return {
    ...actual,
    activeProvider: () => deepseekPreset,
    activeFastModel: () => 'deepseek-v4-flash',
    activeSmartModel: () => 'deepseek-v4-pro',
    belongsToProvider: (preset: any, modelId: string) => actual.belongsToProvider(deepseekPreset, modelId),
  }
})

const script: Array<{ deltas?: any[]; result: any }> = []
vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      for (const d of scene.deltas ?? []) yield typeof d === 'string' ? { type: 'text', delta: d } : d
      return scene.result
    })(),
  ),
}))

// 隔离宿主机 ~/.deepcode/settings.json 的权限规则：钉空 permissions.allow/deny，
// 使权限测试（ask-chain 等）不受用户累积的 allow 规则影响（如 Bash(echo hello:*) 会让 ask 不弹 → 测试挂死）。
vi.mock('../src/settingsLayers.js', async orig => {
  const actual = (await orig()) as any
  return {
    ...actual,
    loadLayeredSettings: (cwd: string, flagPath?: string) => {
      const real = actual.loadLayeredSettings(cwd, flagPath)
      return {
        ...real,
        // memory.enabled=false：禁掉每轮末 fire-and-forget 的提取/dream（本文件无测试依赖之），
        // 避免 mock 脚本耗尽时的 "[memory] 提取失败" 噪音与测试结束后晚到的 console.error→write EPIPE。
        settings: { ...real.settings, permissions: { allow: [], deny: [] }, memory: { ...real.settings.memory, enabled: false } },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

import { createChatCore } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
const sessionDir = mkdtempSync(path.join(tmpdir(), 'recap-'))

describe('/recap', () => {
  it('空会话 → 提示先发消息', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/recap')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('还没有可回顾'))).toBe(true)
  })
  it('有会话 → 调 generateRecap（走 chatStream）并 notice 结果', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '答复', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('随便说点')                       // 造一轮真实 turn
    script.push({ result: { content: '在做 A，下一步 B。', usage, finishReason: 'stop' } })
    await core.send('/recap')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('下一步 B'))).toBe(true)
  })
})
