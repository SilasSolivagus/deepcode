import { describe, it, expect } from 'vitest'
import { createPendingQueue } from '../src/tui/pendingQueue.js'

type Item = { id: number; resolve: (v: string) => void }

describe('pendingQueue', () => {
  it('两个并发挂起都拿到应答（单槽赋值会丢掉第一个）', async () => {
    const q = createPendingQueue<string, Item>(() => {})
    const p1 = new Promise<string>(res => q.push({ id: 1, resolve: res }))
    const p2 = new Promise<string>(res => q.push({ id: 2, resolve: res }))
    expect(q.size()).toBe(2)
    expect(q.head()!.id).toBe(1)
    q.resolveHead('a')
    expect(q.head()!.id).toBe(2)
    q.resolveHead('b')
    expect(await p1).toBe('a')
    expect(await p2).toBe('b')
    expect(q.size()).toBe(0)
  })

  it('FIFO：先入先出，不是后来居上', async () => {
    const order: number[] = []
    const q = createPendingQueue<string, Item>(() => {})
    for (const id of [1, 2, 3]) q.push({ id, resolve: () => order.push(id) })
    q.resolveHead('x'); q.resolveHead('x'); q.resolveHead('x')
    expect(order).toEqual([1, 2, 3])
  })

  it('drain 排空全队，每个都 resolve', async () => {
    const q = createPendingQueue<string, Item>(() => {})
    const ps = [1, 2, 3].map(id => new Promise<string>(res => q.push({ id, resolve: res })))
    q.drain('no')
    expect(q.size()).toBe(0)
    expect(await Promise.all(ps)).toEqual(['no', 'no', 'no'])
  })

  it('空队列 resolveHead 返回 false 且不抛（重复应答幂等）', () => {
    const q = createPendingQueue<string, Item>(() => {})
    expect(q.resolveHead('x')).toBe(false)
    expect(() => q.drain('x')).not.toThrow()
  })

  it('次序：先改队列、再 onChange、最后 resolve', () => {
    const events: string[] = []
    const q = createPendingQueue<string, Item>(() => events.push(`change:${q.size()}`))
    q.push({ id: 1, resolve: () => events.push('resolved') })
    events.length = 0
    q.resolveHead('x')
    expect(events).toEqual(['change:0', 'resolved'])
  })
})
