// test/useChat.cycleMode.test.ts
// Task 5：真机冒烟挖出的 O(N²) OOM 回归测试——cycleMode() 跑动中（busy）绝不 push transcript
// 通知（页脚已实时显示模式），只在空闲时保留一行反馈。用「闸门」把一轮 turn 卡在 busy 态，
// 断言跑动中反复 cycleMode() 不增长 transcript 里的 notice 数；turn 结束后 idle 时 cycleMode()
// 仍保留一条 notice（不能把 idle 分支也一并砍掉，否则该断言会失败——非恒真）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 闸门：generator yield 一个 delta 后 await 这个可控 promise，使 runLoop 挂在 busy 态直到 release()。
let release: (() => void) | null = null
let gate: Promise<void> | null = null

vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() =>
    (async function* () {
      yield { type: 'text', delta: 'x' }
      await gate
      return {
        content: 'x', toolCalls: [], finishReason: 'stop',
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 },
      }
    })(),
  ),
}))
// 记忆提取器每轮后 fire-and-forget；归零防止干扰。
vi.mock('../src/subagentRunner.js', async orig => ({ ...(await orig() as any), runSubagent: vi.fn(async () => 'ok') }))
// emitNotification 真写 /dev/tty；mock 为 no-op。
vi.mock('../src/notify.js', async importOriginal => {
  const orig = await importOriginal() as any
  return { ...orig, emitNotification: () => {} }
})

import { createChatCore } from '../src/tui/useChat.js'
import { clearAllTasks, drainNotifications } from '../src/tasks.js'

let sessionDir: string
let home: string
beforeEach(() => {
  vi.clearAllMocks()
  clearAllTasks()
  drainNotifications()
  gate = new Promise<void>(r => { release = r })
  sessionDir = mkdtempSync(path.join(tmpdir(), 'deepcode-test-'))
  home = mkdtempSync(path.join(tmpdir(), 'deepcode-test-home-'))
})
afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

const noticeCount = (transcript: any[]): number => transcript.filter(i => i.kind === 'notice').length

describe('cycleMode busy 不 push transcript 通知（O(N²) OOM 回归）', () => {
  it('跑动中反复 cycleMode 不增长 notice；idle 时 cycleMode 仍保留一条', async () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: sessionDir, sessionDir, home, onState: () => {} })

    const p = core.send('任务')
    // 等到本轮首个 delta 落进 transcript：此刻 runLoop 正挂在 chatStream 的 gate await 上，busy 恒 true。
    await vi.waitFor(() => {
      if (!core.state.transcript.some(i => i.kind === 'assistant' && !i.done)) throw new Error('还没收到 delta')
    })
    expect(core.state.busy).toBe(true)

    const before = noticeCount(core.state.transcript)
    core.cycleMode()
    core.cycleMode()
    core.cycleMode()
    const during = noticeCount(core.state.transcript)
    expect(during).toBe(before) // 跑动中不增长

    release!()
    await p
    expect(core.state.busy).toBe(false)

    const idleBefore = noticeCount(core.state.transcript)
    core.cycleMode()
    const idleAfter = noticeCount(core.state.transcript)
    expect(idleAfter).toBe(idleBefore + 1) // 空闲时仍保留一条反馈（防止把 idle 分支也砍掉的恒真陷阱）

    core.dispose()
  })
})
