// test/useChat.cycleMode.test.ts
// Task 6：cycleMode() 改 footer-only——彻底修 O(N²) OOM（取代 Task 5 的 busy-gate 半修）。
// Task 5 只堵了跑动中（busy）的 notice，空闲长按 Shift+Tab 仍走 idle 分支 notice → transcript
// 无界增长 → 每帧 render clone/map 整个数组 → O(N²) 分配 → 堆爆（真机冒烟两次证实）。
// 新不变量：cycleMode 无论 idle 还是 busy 都绝不 push 模式相关的 transcript notice（模式只在页脚
// 实时显示），但仍必须真正前进 permMode（不能沦为 no-op）。
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

// 模式相关的 notice：文本含「切换」或「plan 模式」（typed /plan·/accept·/dontask 各自的 notice
// 不会被 cycleMode 触发，此过滤只为不误伤其他无关 notice）。
const modeNoticeCount = (transcript: any[]): number =>
  transcript.filter(i => i.kind === 'notice' && (i.text?.includes('切换') || i.text?.includes('plan 模式'))).length

describe('cycleMode footer-only（O(N²) OOM 彻底修复回归）', () => {
  it('空闲长按 cycleMode：不 push 模式 notice，但 permMode 真的前进', () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: sessionDir, sessionDir, home, onState: () => {} })

    const before = modeNoticeCount(core.state.transcript)
    const modeBefore = core.permMode()
    // 循环长度为 5（default→auto→acceptEdits→plan→dontAsk→default），故意选不是 5 的倍数的次数，
    // 避免刚好转一圈又落回原模式，误判成 no-op。
    for (let i = 0; i < 22; i++) core.cycleMode()
    const after = modeNoticeCount(core.state.transcript)
    const modeAfter = core.permMode()

    expect(after).toBe(before) // footer-only：空闲长按不刷屏
    expect(modeAfter).not.toBe(modeBefore) // 不是 no-op：模式确实前进了

    core.dispose()
  })

  it('跑动中反复 cycleMode：同样不 push 模式 notice', async () => {
    const core = createChatCore({ client: {} as any, yolo: false, cwd: sessionDir, sessionDir, home, onState: () => {} })

    const p = core.send('任务')
    // 等到本轮首个 delta 落进 transcript：此刻 runLoop 正挂在 chatStream 的 gate await 上，busy 恒 true。
    await vi.waitFor(() => {
      if (!core.state.transcript.some(i => i.kind === 'assistant' && !i.done)) throw new Error('还没收到 delta')
    })
    expect(core.state.busy).toBe(true)

    const before = modeNoticeCount(core.state.transcript)
    for (let i = 0; i < 20; i++) core.cycleMode()
    const during = modeNoticeCount(core.state.transcript)
    expect(during).toBe(before) // 跑动中不增长

    release!()
    await p
    expect(core.state.busy).toBe(false)

    core.dispose()
  })
})
