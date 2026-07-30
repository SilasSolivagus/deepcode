// src/overflowRetry.ts
import { isContextOverflowError, microcompact } from './compact.js'

export type OverflowPlan =
  | { action: 'retry'; messages: any[]; tokensSaved: number }
  | { action: 'report' }

/** 上下文超窗时是否值得「甩掉旧工具结果后重跑一次」。
 *
 *  三条判据合成一处（此前散在 useChat.ts 的嵌套 if 里，headless 侧则完全没有）：
 *  ① 确实是超窗错误 ② 本轮尚未重试过 ③ microcompact 真的甩掉了东西。
 *  ② 是单发语义——压完仍超窗就别再压了，否则每轮都白烧一次 API 且可能死循环。
 *  ③ 靠 microcompact 自己的地板值把关：可回收量太小时它返回 null，重试没意义。
 *
 *  本函数**不落地**：只返回压缩后的新数组，由调用方决定怎么写回。
 *  两侧落地动作不同（TUI 还要重置 lastPromptTokens/baselineLen），放这里会绑死其中一边。 */
export function planOverflowRetry(
  err: unknown,
  messages: any[],
  alreadyRetried: boolean,
): OverflowPlan {
  if (!isContextOverflowError(err) || alreadyRetried) return { action: 'report' }
  const mc = microcompact(messages)
  if (!mc) return { action: 'report' }
  return { action: 'retry', messages: mc.messages, tokensSaved: mc.tokensSaved }
}
