// test/useChat.resumeTranscript.test.ts —— 恢复会话后界面能看到之前的对话（不只是模型记得）
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
          permissions: { allow: [], deny: [] },
          memory: { ...real.settings.memory, enabled: false },
        },
        permissionSources: { allow: {}, deny: {} },
      }
    },
  }
})

vi.mock('../src/notify.js', async orig => ({ ...(await orig() as any), emitNotification: () => {} }))

import { createChatCore, displayTextOf } from '../src/tui/useChat.js'

const usage = { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-restore-'))
})

describe('恢复会话后重建 transcript', () => {
  it('--resume 回来能在界面上看到之前的用户与助手消息', async () => {
    script.push({ deltas: ['你', '好'], result: { content: '你好', toolCalls: [], usage, finishReason: 'stop' } })

    const first = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    await first.send('第一句话')
    const file = first.sessionFile()!

    const second = createChatCore({
      client: {} as any, yolo: true, cwd: '/tmp', sessionDir, resumeFile: file, onState: () => {},
    })

    const items = second.state.transcript
    expect(items.some(i => i.kind === 'user' && (i as any).text === '第一句话')).toBe(true)
    expect(items.some(i => i.kind === 'assistant' && displayTextOf(i as any) === '你好')).toBe(true)
  })
})
