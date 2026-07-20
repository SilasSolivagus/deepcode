// test/compact.breaker.test.ts
import { describe, it, expect } from 'vitest'
import { newCompactState, bumpTurnCounter, checkRapidRefill, recordCompact } from '../src/compact.js'

describe('快速回填熔断', () => {
  it('首个 compact 不算 refill', () => {
    const s = newCompactState()
    const r = checkRapidRefill(s) // compacted=false → rapidRefills 0
    expect(r).toEqual({ rapidRefills: 0, tripped: false })
    recordCompact(s, r.rapidRefills)
    expect(s).toMatchObject({ turnCounter: 0, consecutiveRapidRefills: 0, compacted: true })
  })

  it('compact 后 <3 轮内又 compact 连续 3 次 → trip', () => {
    const s = newCompactState()
    recordCompact(s, checkRapidRefill(s).rapidRefills) // 第1次 compact
    // 第2次：turnCounter=0 (<3) → refill 1
    let r = checkRapidRefill(s); expect(r.rapidRefills).toBe(1); expect(r.tripped).toBe(false); recordCompact(s, r.rapidRefills)
    // 第3次：turnCounter=0 (<3) → refill 2
    r = checkRapidRefill(s); expect(r.rapidRefills).toBe(2); expect(r.tripped).toBe(false); recordCompact(s, r.rapidRefills)
    // 第4次：turnCounter=0 (<3) → refill 3 → trip
    r = checkRapidRefill(s); expect(r.rapidRefills).toBe(3); expect(r.tripped).toBe(true)
  })

  it('间隔 ≥3 轮归零（自愈）', () => {
    const s = newCompactState()
    recordCompact(s, checkRapidRefill(s).rapidRefills)
    let r = checkRapidRefill(s); recordCompact(s, r.rapidRefills) // refill 1
    // 隔 3 轮不 compact
    bumpTurnCounter(s); bumpTurnCounter(s); bumpTurnCounter(s) // turnCounter=3
    r = checkRapidRefill(s) // turnCounter=3 不 <3 → 归零
    expect(r.rapidRefills).toBe(0); expect(r.tripped).toBe(false)
  })

  it('bumpTurnCounter 仅在 compacted 后才 ++', () => {
    const s = newCompactState()
    bumpTurnCounter(s); expect(s.turnCounter).toBe(0) // 未 compact 过 → 不 ++
    recordCompact(s, 0)
    bumpTurnCounter(s); expect(s.turnCounter).toBe(1)
  })
})
