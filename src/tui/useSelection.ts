// src/tui/useSelection.ts
import { useRef, useState } from 'react'

/** 列表选中态：state 供渲染，ref 供按键处理器读取。
 *
 *  为什么不能在处理器里直接读 state：上游 ink 的 `useInput` 是裸回调，没有 React 的
 *  离散事件优先级通道，同一个渲染周期内到达的多个按键会全部派发给**同一个闭包**。
 *  导航分支排队的 setState 此时尚未提交，提交分支若读闭包里的 idx 就会落后一格。
 *  实测：权限弹窗里「↓↓ 然后回车」——用户选的是「拒绝」，提交出去的是「总是允许」。
 *  终端把快速连按合并进同一个 data chunk 投递时就会发生，不是边角情况。
 *
 *  约定：**导航调 next/prev/set，提交分支一律读 current()，不要读返回的 idx。**
 *  idx 只用于渲染高亮。 */
export function useSelection(count: number) {
  const [idx, setIdx] = useState(0)
  const idxRef = useRef(0)
  // 每次渲染同步最新长度：处理器闭包里的 count 同样会过期，钳位必须用最新值
  const countRef = useRef(count)
  countRef.current = count

  const set = (n: number): void => {
    const clamped = Math.max(0, Math.min(countRef.current - 1, n))
    idxRef.current = clamped
    setIdx(clamped)
  }

  return {
    /** 渲染用的选中下标 */
    idx,
    /** 处理器用：当前选中下标（不受闭包陈旧影响） */
    current: () => idxRef.current,
    next: () => set(idxRef.current + 1),
    prev: () => set(idxRef.current - 1),
    set,
  }
}
