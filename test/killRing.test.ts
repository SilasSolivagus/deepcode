import { describe, it, expect } from 'vitest'
import { emptyKillRing, kill, yank, yankPop } from '../src/tui/killRing.js'

describe('批1 Task4: kill ring', () => {
  it('kill 新起条目（continuing=false）；空 text 不改', () => {
    let r = emptyKillRing()
    r = kill(r, 'abc', 'append', false)
    expect(r.entries).toEqual(['abc'])
    r = kill(r, '', 'append', false)
    expect(r.entries).toEqual(['abc']) // 空不入
  })
  it('两次非连续 kill → 两条条目（新的在顶）', () => {
    let r = kill(emptyKillRing(), 'foo', 'append', false)
    r = kill(r, 'bar', 'append', false)
    expect(r.entries).toEqual(['bar', 'foo'])
  })
  it('连续 kill append 并入顶部尾（continuing=true）', () => {
    let r = kill(emptyKillRing(), 'foo', 'append', false)
    r = kill(r, 'bar', 'append', true)
    expect(r.entries).toEqual(['foobar'])
  })
  it('连续 kill prepend 并入顶部首（continuing=true）', () => {
    let r = kill(emptyKillRing(), 'bar', 'prepend', false)
    r = kill(r, 'foo', 'prepend', true)
    expect(r.entries).toEqual(['foobar'])
  })
  it('yank 取顶', () => {
    const y = yank(kill(emptyKillRing(), 'hello', 'append', false))
    expect(y.text).toBe('hello')
  })
  it('yankPop 轮换到下一条（多条时）', () => {
    let r = kill(emptyKillRing(), 'one', 'append', false)
    r = kill(r, 'two', 'append', false) // entries: ['two','one']
    const y1 = yank(r)
    expect(y1.text).toBe('two')
    const y2 = yankPop(y1.ring)
    expect(y2.text).toBe('one')
    const y3 = yankPop(y2.ring)
    expect(y3.text).toBe('two') // 环回
  })
  it('空 ring yank/yankPop 返回空串不抛', () => {
    expect(yank(emptyKillRing()).text).toBe('')
    expect(yankPop(emptyKillRing()).text).toBe('')
  })
  it('kill ring 上限 10 条（连续 12 次非 continuing kill 后）', () => {
    let r = emptyKillRing()
    for (let i = 1; i <= 12; i++) {
      r = kill(r, `entry${i}`, 'append', false)
    }
    expect(r.entries.length).toBe(10)
    // 顶 10 条应为 entry12 到 entry3（最旧的被删）
    expect(r.entries[0]).toBe('entry12')
    expect(r.entries[9]).toBe('entry3')
  })
})
