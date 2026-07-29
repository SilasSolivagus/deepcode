// src/tui/pendingQueue.ts
/** 挂起项的公共形状：只要求能被 resolve。 */
export interface Pending<V> { resolve: (v: V) => void }

/** FIFO 挂起队列。
 *
 *  为什么不能是单槽：单槽赋值下并发挂起会互相覆盖，被覆盖那个的 resolve 引用随之丢失，
 *  它的 Promise 永不 resolve —— checkPermission 不返回、runLoop 不返回、会话挂死。
 *  只读工具按 CONCURRENCY 并行成批（loop.ts），而围栏与 ask 桶都在 isReadOnly 短路之前，
 *  所以并发挂起是常规路径而非边角情况。
 *
 *  次序约定：先改队列 → onChange（刷 UI）→ 最后 resolve。
 *  resolve 可能同步触发下游续跑，届时它看到的必须已是新队列状态。 */
export function createPendingQueue<V, T extends Pending<V>>(onChange: () => void) {
  const items: T[] = []
  return {
    push(item: T): void {
      items.push(item)
      onChange()
    },
    head(): T | null {
      return items[0] ?? null
    },
    size(): number {
      return items.length
    },
    /** 应答队首。空队列返回 false（幂等：UI 重复触发不炸）。 */
    resolveHead(value: V): boolean {
      const item = items.shift()
      if (!item) return false
      onChange()
      item.resolve(value)
      return true
    },
    /** 排空全队并逐个 resolve（中断路径）。 */
    drain(value: V): void {
      if (items.length === 0) return
      const all = items.splice(0)
      onChange()
      for (const item of all) item.resolve(value)
    },
  }
}
