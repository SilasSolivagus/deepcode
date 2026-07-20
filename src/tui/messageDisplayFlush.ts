// src/tui/messageDisplayFlush.ts
export const FLUSH_DEBOUNCE_MS = 1000

export interface FlushState {
  messageId: string
  rawText: string
  flushedOffset: number
  index: number
  lastFlushAt: number
}

export function newFlushState(messageId: string, now: number): FlushState {
  return { messageId, rawText: '', flushedOffset: 0, index: 0, lastFlushAt: now }
}

/** 非 final 需有新完成行（最后换行超出 flushedOffset）；距上次 flush<1000ms 则 defer 剩余时间；
 *  否则返回本批 delta（flushedOffset→最后换行+1；final 则到全文末尾）。end<=flushedOffset（无新内容）→ null。 */
export function computeFlush(
  st: FlushState, now: number, final: boolean,
): { deltaText: string; index: number; end: number } | { defer: number } | null {
  const lastNL = st.rawText.lastIndexOf('\n')
  if (!final && lastNL + 1 <= st.flushedOffset) return null
  if (!final) {
    const m = now - st.lastFlushAt
    if (m < FLUSH_DEBOUNCE_MS) return { defer: FLUSH_DEBOUNCE_MS - m }
  }
  const end = final ? st.rawText.length : lastNL + 1
  if (end <= st.flushedOffset) return null
  return { deltaText: st.rawText.slice(st.flushedOffset, end), index: st.index, end }
}
