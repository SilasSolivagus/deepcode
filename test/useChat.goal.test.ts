// test/useChat.goal.test.ts —— 复用 tui.useChat.test.ts 顶部三段 vi.mock（含 const script）
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
const sessionDir = mkdtempSync(path.join(tmpdir(), 'goal-'))

describe('/goal 分发', () => {
  it('无参无目标 → 用法提示', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await core.send('/goal')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('未设目标'))).toBe(true)
  })
  it('设目标 → notice 已设置 + 触发续跑', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '好的，开始', toolCalls: [], usage, finishReason: 'stop' } })  // directive turn
    await core.send('/goal 让所有测试通过')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('目标已设置'))).toBe(true)
  })
  it('设后无参 → 报告进行中', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('/goal 目标X')
    await core.send('/goal')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('目标进行中'))).toBe(true)
  })
  it('/goal clear → 清除', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    await core.send('/goal 目标X')
    await core.send('/goal clear')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('已清除目标'))).toBe(true)
  })
})

describe('/goal 强制续跑（goalGate）', () => {
  it('judge ok:false→续跑，下轮 ok:true→自清+达成', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '开始干', toolCalls: [], usage, finishReason: 'stop' } })    // directive turn（无工具→触发 gate）
    script.push({ result: { content: '{"ok":false,"reason":"还没跑测试"}', usage, finishReason: 'stop' } }) // judge #1
    script.push({ result: { content: '跑完了，全绿', toolCalls: [], usage, finishReason: 'stop' } })  // 续跑 turn（无工具→再触发 gate）
    script.push({ result: { content: '{"ok":true,"reason":"全绿"}', usage, finishReason: 'stop' } })   // judge #2
    await core.send('/goal 让测试全绿')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('目标达成'))).toBe(true)
  })
  it('judge error → 放行停止 + 警告', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '开始', toolCalls: [], usage, finishReason: 'stop' } })
    script.push({ result: { content: '瞎说不是JSON', usage, finishReason: 'stop' } })  // judge malformed → error
    await core.send('/goal 目标Y')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('放行停止'))).toBe(true)
  })
  it('judge impossible → 清除 + 放行 + 无法达成 notice', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '开始', toolCalls: [], usage, finishReason: 'stop' } })                                  // directive turn
    script.push({ result: { content: '{"ok":false,"impossible":true,"reason":"依赖不存在的服务"}', usage, finishReason: 'stop' } }) // judge → impossible
    await core.send('/goal 依赖不存在的服务')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('无法达成'))).toBe(true)
  })
  it('iterations 达上限（25）→ 强制清除 + 放行 + 上限 notice', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    script.push({ result: { content: '开始', toolCalls: [], usage, finishReason: 'stop' } }) // directive turn
    for (let i = 0; i < 25; i++) {
      script.push({ result: { content: '{"ok":false,"reason":"还没达成"}', usage, finishReason: 'stop' } }) // judge i (ok:false)
      script.push({ result: { content: '继续干', toolCalls: [], usage, finishReason: 'stop' } })            // continue turn i
    }
    await core.send('/goal 永不达成的目标')
    expect(core.state.transcript.some(i => i.kind === 'notice' && i.text.includes('上限'))).toBe(true)
  })
})
