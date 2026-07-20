// test/exitFlush.test.ts
// flushThenExit 顺序不变量单测：退出前必须先 await flush 完成，再调用 exit。
// 这条不变量此前零自动化防护——删掉 helper 内的 await 不会有测试变红（见任务报告的变异验证）。
import { describe, it, expect, vi } from 'vitest'
import { flushThenExit } from '../src/tui/exitFlush.js'

describe('flushThenExit', () => {
  it('顺序正确：flush 未 resolve 时 exit 不应被调用，flush resolve 之后才调用', async () => {
    let resolved = false
    const flush = () => new Promise<void>(resolve => {
      setTimeout(() => { resolved = true; resolve() }, 30)
    })
    const exit = vi.fn(() => {
      // exit 被调用时，flush 必须已经 resolve
      expect(resolved).toBe(true)
    })

    await flushThenExit(flush, exit)

    expect(exit).toHaveBeenCalledTimes(1)
  })

  it('notify 先于 flush 调用', async () => {
    const order: string[] = []
    const flush = async () => { order.push('flush') }
    const exit = () => { order.push('exit') }
    const notify = () => { order.push('notify') }

    await flushThenExit(flush, exit, notify)

    expect(order).toEqual(['notify', 'flush', 'exit'])
  })

  it('无 notify 时也能正常工作', async () => {
    const flush = vi.fn(async () => {})
    const exit = vi.fn()

    await flushThenExit(flush, exit)

    expect(flush).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
