// I2/I3 回归：权限弹窗的输入去抖与「总是允许」文案诚实性。
// I2：挂起项队列化后两个权限弹窗会真正背靠背上屏，为上一个按的 Enter 晚一拍落地就打在下一个上，
//     而它默认选中「允许」——权限层的默认值在放行方向，误触必须按放行成本来防。
// I3：子代理来源走 buildSubagentPermission，那里 saveRule 是 no-op，always 实际只等于放行本次；
//     照抄「本会话不再询问」等于对用户陈述假的后果。
//
// 时钟：去抖窗口用绝对墙钟判定，而全量跑（350+ 文件并发）下事件循环随时可能被饿住几十毫秒，
// 真等待会让正反两个方向的断言都随机翻车。故用 mockClock 冻住 Date.now、由用例显式推进：
// 墙钟耗多久都不影响判定。窗口长度从 PermissionDialog 导入，不再抄一份常量（抄了改常量会静默漂移）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { PermissionDialog, INPUT_GUARD_MS } from '../src/tui/components/PermissionDialog.js'
import type { PendingAsk } from '../src/tui/useChat.js'
import { mockClock } from './helpers.js'

/** 真等待，只用来让 ink 完成挂载/重绘与 effect 落地——与去抖判定无关（那由假时钟决定）。 */
const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
const DOWN = '\x1B[B'

const mkAsk = (over: Partial<PendingAsk> = {}): PendingAsk =>
  ({ toolName: 'Write', desc: 'a.txt', dangerous: false, ...over } as PendingAsk)

describe('PermissionDialog 输入去抖', () => {
  let clock: ReturnType<typeof mockClock>
  beforeEach(() => { clock = mockClock() })
  afterEach(() => { clock.restore() })

  /** 把时钟推过去抖窗口（多推 1ms：判定是 Date.now() < guardUntil 的严格小于）。 */
  const passGuard = () => clock.advance(INPUT_GUARD_MS + 1)

  it('上屏后的去抖窗口内 Enter 被丢弃，不误判「允许」', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={mkAsk()} onDecide={onDecide} />)
    await settle()
    stdin.write('\r')          // 时钟未推进 → 仍在窗口内
    await settle()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('去抖窗口过后 Enter 正常生效（不影响单个弹窗的常规操作）', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={mkAsk()} onDecide={onDecide} />)
    await settle()
    passGuard()
    stdin.write('\r')
    await settle()
    expect(onDecide).toHaveBeenCalledWith('yes')
  })

  it('恰好卡在窗口边界上仍算窗口内（判定是严格小于）', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={mkAsk()} onDecide={onDecide} />)
    await settle()
    clock.advance(INPUT_GUARD_MS - 1)
    stdin.write('\r')
    await settle()
    expect(onDecide).not.toHaveBeenCalled()
  })

  it('窗口期内方向键仍可用：只挡决策不挡挪光标', async () => {
    const onDecide = vi.fn()
    const { stdin } = render(<PermissionDialog ask={mkAsk()} onDecide={onDecide} />)
    await settle()
    stdin.write(DOWN); stdin.write(DOWN)  // 窗口期内挪到「拒绝」
    await settle()
    passGuard()
    stdin.write('\r')
    await settle()
    expect(onDecide).toHaveBeenCalledWith('no')
  })

  it('快捷键同样受窗口约束（y/a/Shift+Tab 都是放行方向）', async () => {
    for (const keySeq of ['y', 'a', '\x1b[Z']) {
      const onDecide = vi.fn()
      const { stdin } = render(<PermissionDialog ask={mkAsk()} onDecide={onDecide} />)
      await settle()
      stdin.write(keySeq)
      await settle()
      expect(onDecide, `按键 ${JSON.stringify(keySeq)} 不该在去抖窗口内生效`).not.toHaveBeenCalled()
    }
  })

  // App/FullscreenApp 给了 key=ask.id，换项即重挂、窗口天然重算；
  // 这条钉的是不依赖调用方给 key 的那一半：ask 换了但组件没卸载时窗口也必须重新起算。
  it('组件不卸载、只换 ask 时窗口重新起算', async () => {
    const onDecide = vi.fn()
    const r = render(<PermissionDialog ask={mkAsk({ desc: 'a.txt' })} onDecide={onDecide} />)
    await settle()
    passGuard()                // 第一个 ask 的窗口已过
    r.rerender(<PermissionDialog ask={mkAsk({ desc: 'b.txt' })} onDecide={onDecide} />)
    await settle()             // 等 effect 落地重新武装窗口
    r.stdin.write('\r')        // 时钟未再推进 → 落在新窗口内
    await settle()
    expect(onDecide).not.toHaveBeenCalled()
  })
})

describe('PermissionDialog「总是允许」文案对来源诚实', () => {
  it('子代理来源：不承诺「本会话不再询问」（规则不落盘，下次仍会问）', () => {
    const f = render(
      <PermissionDialog
        ask={mkAsk({ origin: { agentId: 'ag_1', agentType: 'Explore' }, previewRule: 'Bash(ls:*)' })}
        onDecide={() => {}}
      />,
    ).lastFrame()!
    expect(f).not.toContain('本会话不再询问')
    expect(f).not.toContain('总是允许')
    expect(f).toContain('下次仍会问')
  })

  it('主会话来源：文案不变（规则确实会落盘）', () => {
    const f = render(<PermissionDialog ask={mkAsk({ previewRule: 'Bash(ls:*)' })} onDecide={() => {}} />).lastFrame()!
    expect(f).toContain('总是允许 — Bash(ls:*)')
  })

  it('主会话来源、无 previewRule：仍是「本会话不再询问」', () => {
    const f = render(<PermissionDialog ask={mkAsk()} onDecide={() => {}} />).lastFrame()!
    expect(f).toContain('本会话不再询问')
  })
})
