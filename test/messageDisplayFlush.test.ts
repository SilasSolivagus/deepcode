import { describe, it, expect } from 'vitest'
import { newFlushState, computeFlush, FLUSH_DEBOUNCE_MS } from '../src/tui/messageDisplayFlush.js'

describe('批B Task4: computeFlush', () => {
  it('无新完成行（无换行超出 flushedOffset）→ null', () => {
    const st = newFlushState('m', 0); st.rawText = 'partial no newline'
    expect(computeFlush(st, 5000, false)).toBeNull()
  })
  it('有新完成行且距上次≥1s → 立即 flush 到最后换行', () => {
    const st = newFlushState('m', 0); st.rawText = 'line1\nline2\npart'; st.lastFlushAt = 0
    const r = computeFlush(st, FLUSH_DEBOUNCE_MS, false)
    expect(r).toEqual({ deltaText: 'line1\nline2\n', index: 0, end: 12 })
  })
  it('有新完成行但距上次<1s → defer 剩余时间', () => {
    const st = newFlushState('m', 0); st.rawText = 'line1\n'; st.lastFlushAt = 500
    const r = computeFlush(st, 900, false) // m=400 < 1000
    expect(r).toEqual({ defer: 600 })
  })
  it('final=true → flush 到全文末尾（含未完成行）', () => {
    const st = newFlushState('m', 0); st.rawText = 'a\nbcd'; st.flushedOffset = 2; st.lastFlushAt = 0
    const r = computeFlush(st, 10, true) // final 无视 debounce
    expect(r).toEqual({ deltaText: 'bcd', index: 0, end: 5 })
  })
  it('final=true 但无新内容 → null', () => {
    const st = newFlushState('m', 0); st.rawText = 'a\n'; st.flushedOffset = 2
    expect(computeFlush(st, 10, true)).toBeNull()
  })
})
