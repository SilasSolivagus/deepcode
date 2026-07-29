import { describe, it, expect } from 'vitest'
import { createPendingQueue, type Pending } from '../src/tui/pendingQueue.js'

// tag = 用例自己的身份标记。不叫 id：id 已被队列在 push 时占用（写入单调序号，供 UI 当 React key），
// 两者同名会让下面的身份断言退化成「队列序号 == 队列序号」的空转。
type Item = Pending<string> & { tag: number }

describe('pendingQueue', () => {
  it('两个并发挂起都拿到应答（单槽赋值会丢掉第一个）', async () => {
    const q = createPendingQueue<string, Item>(() => {})
    const p1 = new Promise<string>(res => q.push({ tag: 1, resolve: res }))
    const p2 = new Promise<string>(res => q.push({ tag: 2, resolve: res }))
    expect(q.size()).toBe(2)
    expect(q.head()!.tag).toBe(1)
    q.resolveHead('a')
    expect(q.head()!.tag).toBe(2)
    q.resolveHead('b')
    expect(await p1).toBe('a')
    expect(await p2).toBe('b')
    expect(q.size()).toBe(0)
  })

  it('FIFO：先入先出，不是后来居上', async () => {
    const order: number[] = []
    const q = createPendingQueue<string, Item>(() => {})
    for (const tag of [1, 2, 3]) q.push({ tag, resolve: () => order.push(tag) })
    q.resolveHead('x'); q.resolveHead('x'); q.resolveHead('x')
    expect(order).toEqual([1, 2, 3])
  })

  it('drain 排空全队，每个都 resolve', async () => {
    const q = createPendingQueue<string, Item>(() => {})
    const ps = [1, 2, 3].map(tag => new Promise<string>(res => q.push({ tag, resolve: res })))
    q.drain('no')
    expect(q.size()).toBe(0)
    expect(await Promise.all(ps)).toEqual(['no', 'no', 'no'])
  })

  it('空队列 resolveHead 返回 false 且不抛（重复应答幂等）', () => {
    const q = createPendingQueue<string, Item>(() => {})
    expect(q.resolveHead('x')).toBe(false)
    expect(() => q.drain('x')).not.toThrow()
  })

  // id 是 UI 的 React key（App/FullscreenApp 拿它强制换项时重新挂载弹窗组件）。
  // 两条不变式：跨项唯一（否则 React 认成同一个组件不重挂），以及入队后不再变
  // （若随位置重算，前面的项一出队就会把还没答完的新队首也一起重置掉）。
  it('id：入队时写入，跨项唯一且不随出队变动', () => {
    const q = createPendingQueue<string, Item>(() => {})
    const a: Item = { tag: 1, resolve: () => {} }
    const b: Item = { tag: 2, resolve: () => {} }
    q.push(a); q.push(b)
    expect(a.id).toBeDefined()
    expect(b.id).not.toBe(a.id)
    const bIdBefore = b.id
    q.resolveHead('x')            // a 出队，b 挪到队首
    expect(q.head()).toBe(b)
    expect(b.id).toBe(bIdBefore)  // 位置变了，id 不变
  })

  it('次序：先改队列、再 onChange、最后 resolve', () => {
    const events: string[] = []
    const q = createPendingQueue<string, Item>(() => events.push(`change:${q.size()}`))
    q.push({ tag: 1, resolve: () => events.push('resolved') })
    events.length = 0
    q.resolveHead('x')
    expect(events).toEqual(['change:0', 'resolved'])
  })
})
