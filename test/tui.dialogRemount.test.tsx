// C1 回归：挂起项队列化后，队首从第 1 项换到第 2 项【中间没有 null 帧】，
// 弹窗组件不再卸载 —— 改造前 resolveQuestion 把 pendingQuestion 置 null 才是那次重置的来源。
// QuestionDialog 有 qi/cursor/mode/buf/submitCur 五个 state，外加只在首次挂载初始化、
// 此后永不与 questions 重同步的 draftsRef；不卸载就会把上一组问题的进度与草稿串给下一组：
// 轻则拿 A 的选择冒充 B 的答案提交给模型，重则 draftsRef 越界在 render 期抛 TypeError
// （ink 无 ErrorBoundary，整个 TUI 崩）。修法是 App/FullscreenApp 给弹窗挂 key=挂起项 id。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../src/api.js', async orig => ({
  ...(await orig() as any),
  chatStream: vi.fn(() => (async function* () { throw new Error('script exhausted') })()),
}))

// App/FullscreenApp 未暴露 home 注入口；memdir 重定向到临时目录，防止活动日志真写 ~/.deepcode
let memRoot: string
vi.mock('../src/memdir/paths.js', async orig => {
  const actual = await orig<typeof import('../src/memdir/paths.js')>()
  return { ...actual, memdirFor: () => memRoot }
})

// App/FullscreenApp 在内部自建 core，没有注入口。包一层 createChatCore 把真实实例捞出来，
// 这样测的是【真的 App.tsx JSX 接线】（含 key），而不是用例自搭的近似接线。
let core: any
vi.mock('../src/tui/useChat.js', async orig => {
  const actual = await orig<typeof import('../src/tui/useChat.js')>()
  return {
    ...actual,
    createChatCore: (opts: any) => { core = actual.createChatCore(opts); return core },
  }
})

import React, { useState } from 'react'
import { Text } from 'ink'
import { render } from 'ink-testing-library'
import { App } from '../src/tui/App.js'
import { FullscreenApp } from '../src/tui/FullscreenApp.js'
import { QuestionDialog } from '../src/tui/components/QuestionDialog.js'
import { createPendingQueue } from '../src/tui/pendingQueue.js'
import type { PendingQuestion } from '../src/tui/useChat.js'
import type { Question, Answer } from '../src/tools/askUserQuestion.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const delay = (ms = 30) => new Promise(r => setTimeout(r, ms))
const DOWN = '\x1B[B'

beforeEach(() => {
  memRoot = mkdtempSync(path.join(tmpdir(), 'dc-remount-mem-'))
  core = undefined
})
afterEach(() => {
  rmSync(memRoot, { recursive: true, force: true })
})

// 双组件陷阱：弹窗在 App.tsx 与 FullscreenApp.tsx 两处平行接线，只改一处会在另一种渲染模式下静默失效。
const RENDERERS: Array<[string, React.ComponentType<any>]> = [['App', App], ['FullscreenApp', FullscreenApp]]

describe.each(RENDERERS)('%s：并发 askConfirm 的两个弹窗互不串台', (_name, Comp) => {
  it('两次并发确认各拿各的答复，第二个弹窗不带第一个的选择', async () => {
    const sessionDir = mkdtempSync(path.join(tmpdir(), 'dc-remount-'))
    const r = render(<Comp client={{} as any} yolo={true} cwd={process.cwd()} sessionDir={sessionDir} />)
    await delay(0)

    // 并发两次（这正是队列要修的场景：只读工具按 CONCURRENCY 成批并行）
    const p1 = core.askConfirm('继续甲？', '甲问', '甲-是', '甲-否')
    const p2 = core.askConfirm('继续乙？', '乙问', '乙-是', '乙-否')
    await delay()
    expect(r.lastFrame()).toContain('继续甲？')

    // 甲：把光标挪到第 2 项再确认（若不重挂，cursor=1 会原样带到乙）
    r.stdin.write(DOWN); await delay()
    r.stdin.write('\r'); await delay()
    expect(await p1).toBe(false)

    const f = r.lastFrame()!
    expect(f).toContain('继续乙？')
    // 光标回到乙自己的第 1 项，而不是继承甲的第 2 项
    expect(f).toContain('❯ 1. 乙-是')
    expect(f).not.toContain('❯ 2. 乙-否')
    // 导航条上乙这题未被标记为「已答」——draftsRef 若被继承会打上 ✓
    expect(f).not.toContain('✓乙问')

    r.stdin.write('1'); await delay()
    expect(await p2).toBe(true) // 各拿各的答复：甲=否、乙=是

    r.unmount()
    rmSync(sessionDir, { recursive: true, force: true })
  })
})

// 上面那条用真 App 覆盖了「有 key」这条接线；这条补的是崩溃形态本身——
// 需要一组多题问题走到复核页，而 askConfirm 只会造单题组，故直接对队列+组件建同形接线。
describe('队列换项：复核页进度不得带到下一组（render 期崩溃回归）', () => {
  const groupA: Question[] = [
    { question: '甲一？', header: '甲一', multiSelect: false, options: [{ label: 'A1', description: '' }, { label: 'B1', description: '' }] },
    { question: '甲二？', header: '甲二', multiSelect: false, options: [{ label: 'A2', description: '' }, { label: 'B2', description: '' }] },
  ]
  // 只有 1 题、且只有 1 个选项：若沿用 A 的 qi=2 会直落复核页，
  // 再拿 A 第一题的选择（下标 1）去索引本题的 options（长度 1）→ render 期 TypeError。
  const groupB: Question[] = [
    { question: '乙一？', header: '乙一', multiSelect: false, options: [{ label: 'ONLY', description: '' }] },
  ]

  it('A 停在复核页提交后，B 从自己的第 1 题重新开始', async () => {
    let bump = () => {}
    const queue = createPendingQueue<Answer[] | null, PendingQuestion>(() => bump())
    const done: Array<Answer[] | null> = []

    // 与 App.tsx / FullscreenApp.tsx 同形的接线：key=挂起项 id
    function Harness() {
      const [, setT] = useState(0)
      bump = () => setT(x => x + 1)
      const head = queue.head()
      if (!head) return <Text>（无挂起）</Text>
      return <QuestionDialog key={head.id} questions={head.questions} onDone={a => { done.push(a); queue.resolveHead(a) }} />
    }

    const r = render(<Harness />)
    await delay()
    queue.push({ questions: groupA, resolve: () => {} })
    queue.push({ questions: groupB, resolve: () => {} })
    await delay()

    r.stdin.write('2'); await delay()   // 甲一 → B1（下标 1）
    r.stdin.write('1'); await delay()   // 甲二 → A2
    expect(r.lastFrame()).toContain('复核答案')
    r.stdin.write('\r'); await delay()  // 提交 A

    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject([{ selected: ['B1'] }, { selected: ['A2'] }])

    const f = r.lastFrame()!
    expect(f).toContain('乙一？')
    expect(f).toContain('(1/1)')
    expect(f).not.toContain('复核答案')
    expect(f).not.toContain('B1')       // A 的选择不得出现在 B 的界面上

    r.stdin.write('1'); await delay()
    expect(done[1]).toMatchObject([{ selected: ['ONLY'] }])
    r.unmount()
  })
})
