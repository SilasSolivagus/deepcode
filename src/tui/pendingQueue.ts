// src/tui/pendingQueue.ts
/** 挂起项的公共形状：只要求能被 resolve。 */
export interface Pending<V> {
  resolve: (v: V) => void
  /** 入队时由队列写入的单调序号，构造方不填。存在的理由是给 UI 当 React key：
   *  改造前 resolve 会把挂起槽置 null，渲染出 null 分支 → 弹窗组件卸载 → 下一项重新挂载，
   *  组件内部 state/ref 靠卸载天然重置。改成队列后队首从第 1 项直接变第 2 项，
   *  中间没有 null 帧、组件不卸载，上一项的选择会串到下一项（复核页索引错位、ref 越界崩溃）。
   *  key 随 id 变化即强制重新挂载，把那份天然重置语义原样找回来。 */
  id?: number
}

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
  let seq = 0
  return {
    push(item: T): void {
      // 序号在入队时写死：同一项在队列里挪位（前面的出队）不改 id，
      // 否则 key 会随出队跳变，反而把还没答完的队首弹窗给重置了。
      ;(item as Pending<V>).id = ++seq
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
