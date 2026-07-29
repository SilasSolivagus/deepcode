// 回归：同一 React 渲染周期内到达的连续按键，提交分支不得读到过期的选中下标。
//
// 上游 ink 的 useInput 是裸回调，没有 React 离散事件优先级通道——同一 tick 内的多个
// 按键全部派发给同一个闭包。导航排队的 setState 尚未提交，提交分支读闭包 idx 就落后一格。
// 实测后果：权限弹窗「↓↓ 然后回车」把用户选的「拒绝」提交成「总是允许」。
//
// 这些用例用「两次 stdin.write 之间不 await」精确复现该时序，是确定性的，不是概率性的：
// 修复前必红，修复后必绿。
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { render } from 'ink-testing-library'
import { PermissionDialog } from '../src/tui/components/PermissionDialog.js'
import { PlanApprovalDialog } from '../src/tui/components/PlanApprovalDialog.js'
import { SelectList } from '../src/tui/components/SelectList.js'
import { Suggestions } from '../src/tui/components/Suggestions.js'
import { INPUT_GUARD_MS } from '../src/tui/components/PermissionDialog.js'
import { mockClock } from './helpers.js'

const delay = (ms = 0) => new Promise(r => setTimeout(r, ms))
const DOWN = '\x1b[B'

describe('同 tick 连续按键：提交分支不得读过期选中态', () => {
  it('PermissionDialog：↓↓ 后回车 → 拒绝（不是总是允许）', async () => {
    const clock = mockClock()
    try {
      const onDecide = vi.fn()
      const ask = { toolName: 'Read', desc: '/etc/passwd', dangerous: false, resolve: onDecide }
      const r = render(<PermissionDialog ask={ask as any} onDecide={onDecide} />)
      await delay()
      clock.advance(INPUT_GUARD_MS + 1) // 越过上屏去抖
      r.stdin.write(DOWN)               // → 总是允许
      r.stdin.write(DOWN)               // → 拒绝
      r.stdin.write('\r')               // 提交，中间不让出
      await delay(30)
      expect(onDecide).toHaveBeenCalledWith('no')
    } finally {
      clock.restore()
    }
  })

  it('PermissionDialog：↓ 后回车 → 总是允许（不是允许）', async () => {
    const clock = mockClock()
    try {
      const onDecide = vi.fn()
      const ask = { toolName: 'Read', desc: '/etc/passwd', dangerous: false, resolve: onDecide }
      const r = render(<PermissionDialog ask={ask as any} onDecide={onDecide} />)
      await delay()
      clock.advance(INPUT_GUARD_MS + 1)
      r.stdin.write(DOWN)
      r.stdin.write('\r')
      await delay(30)
      expect(onDecide).toHaveBeenCalledWith('always')
    } finally {
      clock.restore()
    }
  })

  it('PlanApprovalDialog：↓ 后回车 → 拒绝（不是批准）', async () => {
    const onDecide = vi.fn()
    const r = render(<PlanApprovalDialog pending={{ plan: "计划正文", resolve: onDecide } as any} onDecide={onDecide} />)
    await delay()
    r.stdin.write(DOWN)   // → 拒绝
    r.stdin.write('\r')
    await delay(30)
    expect(onDecide).toHaveBeenCalledWith(false)
  })

  it('SelectList：↓↓ 后回车 → 第三项', async () => {
    const onPick = vi.fn()
    const r = render(<SelectList items={['a', 'b', 'c']} onPick={onPick} onCancel={() => {}} />)
    await delay()
    r.stdin.write(DOWN)
    r.stdin.write(DOWN)
    r.stdin.write('\r')
    await delay(30)
    expect(onPick).toHaveBeenCalledWith(2)
  })

  it('Suggestions：↓ 后 Tab → 第二项', async () => {
    const onPick = vi.fn()
    const items = [{ value: '/model', hint: 'a' }, { value: '/think', hint: 'b' }]
    const r = render(<Suggestions items={items} onPick={onPick} />)
    await delay()
    r.stdin.write(DOWN)
    r.stdin.write('\t')
    await delay(30)
    expect(onPick).toHaveBeenCalledWith('/think')
  })
})
