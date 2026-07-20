import { describe, it, expect } from 'vitest'
import { checkDreamGates } from '../src/services/memory/dreamGate.js'

describe('checkDreamGates 回传 n 与 sessionFiles', () => {
  it('通过时带上会话数与文件列表（修 sessionCount 恒 0）', () => {
    const r = checkDreamGates({
      memdir: '/mem', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', projectKey: 'k',
      cfg: { enabled: true, minHours: 0, minSessions: 2 }, now: 1e12, lastScanAt: 0,
      readLastAt: () => 0,
      listSessions: () => ['/s/a.jsonl', '/s/b.jsonl', '/s/c.jsonl'],
    })
    expect(r.pass).toBe(true)
    expect(r.n).toBe(3)
    expect(r.sessionFiles).toEqual(['/s/a.jsonl', '/s/b.jsonl', '/s/c.jsonl'])
  })

  it('会话数不足时不通过', () => {
    const r = checkDreamGates({
      memdir: '/mem', sessionsDir: '/s', currentSessionFile: '/s/cur.jsonl', projectKey: 'k',
      cfg: { enabled: true, minHours: 0, minSessions: 5 }, now: 1e12, lastScanAt: 0,
      readLastAt: () => 0, listSessions: () => ['/s/a.jsonl'],
    })
    expect(r.pass).toBe(false)
    expect(r.reason).toBe('sessions')
  })
})
