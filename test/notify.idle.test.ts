import { describe, it, expect, vi } from 'vitest'
import { makeIdleNotifier } from '../src/notify.js'

// 多定时器登记表（Map<id, fn>）：能区分「先 cancel 再 setTimer」与「不 cancel 直接叠加」，
// 因为 fake 会记住所有仍未被 clearTimer 的挂起定时器，而不是像单槽 fake 那样后写覆盖前写。
function fakeTimers() {
  let nextId = 0
  const pending = new Map<number, () => void>()
  return {
    setTimer: (f: () => void) => { const id = ++nextId; pending.set(id, f); return id },
    clearTimer: (id: number) => { pending.delete(id) },
    fire: () => { const fns = [...pending.values()]; pending.clear(); fns.forEach((f) => f()) },
    armed: () => pending.size > 0,
    pendingCount: () => pending.size,
  }
}

describe('makeIdleNotifier', () => {
  it('arm→到点空闲且无 loop → emit', () => {
    const t = fakeTimers(); const emit = vi.fn()
    const n = makeIdleNotifier({ thresholdMs: 100, isIdle: () => true, hasActiveLoop: () => false, emit, setTimer: t.setTimer, clearTimer: t.clearTimer })
    n.arm(); t.fire()
    expect(emit).toHaveBeenCalledOnce()
  })
  it('到点但已 busy → 不 emit', () => {
    const t = fakeTimers(); const emit = vi.fn()
    const n = makeIdleNotifier({ thresholdMs: 100, isIdle: () => false, hasActiveLoop: () => false, emit, setTimer: t.setTimer, clearTimer: t.clearTimer })
    n.arm(); t.fire()
    expect(emit).not.toHaveBeenCalled()
  })
  it('有活跃 loop → 不 emit（镜像 !lLe()）', () => {
    const t = fakeTimers(); const emit = vi.fn()
    const n = makeIdleNotifier({ thresholdMs: 100, isIdle: () => true, hasActiveLoop: () => true, emit, setTimer: t.setTimer, clearTimer: t.clearTimer })
    n.arm(); t.fire()
    expect(emit).not.toHaveBeenCalled()
  })
  it('cancel → 清定时器不 emit', () => {
    const t = fakeTimers(); const emit = vi.fn()
    const n = makeIdleNotifier({ thresholdMs: 100, isIdle: () => true, hasActiveLoop: () => false, emit, setTimer: t.setTimer, clearTimer: t.clearTimer })
    n.arm(); n.cancel(); expect(t.armed()).toBe(false); t.fire()
    expect(emit).not.toHaveBeenCalled()
  })
  it('重复 arm → 先清旧定时器（不叠加）', () => {
    const t = fakeTimers(); const emit = vi.fn()
    const n = makeIdleNotifier({ thresholdMs: 100, isIdle: () => true, hasActiveLoop: () => false, emit, setTimer: t.setTimer, clearTimer: t.clearTimer })
    n.arm(); n.arm()
    // 关键断言：二次 arm 后应只剩 1 个挂起定时器（第一个已被 cancel），
    // 若 arm() 漏调 cancel() 直接叠加，这里会是 2。
    expect(t.pendingCount()).toBe(1)
    t.fire()
    expect(emit).toHaveBeenCalledOnce()
  })
})
