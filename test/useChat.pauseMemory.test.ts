// test/useChat.pauseMemory.test.ts
// Task 6：验证 /pause-memory（及别名 /memory-pause、/toggle-memory）会话级暂停记忆
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

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

// subagentRunner 归零，防止消耗 chatStream mock 脚本
vi.mock('../src/subagentRunner.js', async orig => ({
  ...(await orig() as any),
  runSubagent: vi.fn(async () => 'ok'),
}))

import { createChatCore } from '../src/tui/useChat.js'
import { clearAllTasks } from '../src/tasks.js'

const usage = { prompt_tokens: 50, completion_tokens: 20, prompt_cache_hit_tokens: 40 }

let sessionDir: string
beforeEach(() => {
  script.length = 0
  vi.clearAllMocks()
  clearAllTasks()
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-pausemem-test-'))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
})

describe('/pause-memory 会话级暂停记忆', () => {
  it('/pause-memory toggle 语义 + 别名等价', async () => {
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {} })
    expect(core.memoryPaused()).toBe(false)
    await core.send('/pause-memory')
    expect(core.memoryPaused()).toBe(true)
    await core.send('/toggle-memory')   // 别名再切
    expect(core.memoryPaused()).toBe(false)
    await core.send('/memory-pause')     // 第三别名
    expect(core.memoryPaused()).toBe(true)
    core.dispose()
  })

  it('暂停后一轮结束不触发 extract（runSubagent 记忆提取被门控）', async () => {
    script.push({ deltas: ['ok'], result: { content: 'ok', toolCalls: [], usage, finishReason: 'stop' } })
    const runSub = vi.fn(async () => 'ok')
    // 默认设置 memory.enabled=true（DEFAULT_MEMORY_CONFIG），无需额外注入 settings
    const core = createChatCore({ client: {} as any, yolo: true, cwd: '/tmp', sessionDir, onState: () => {}, runSubagent: runSub })
    await core.send('/pause-memory')
    await core.send('hi')
    await new Promise(r => setTimeout(r, 50))
    expect(runSub).not.toHaveBeenCalled() // 记忆提取被 !memoryPaused 门控
    core.dispose()
  })
})
