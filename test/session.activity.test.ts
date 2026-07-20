// test/session.activity.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { newSession, openSession } from '../src/session.js'
import type { ActivityWriter } from '../src/memdir/activityLog.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const spyWriter = () => {
  const seen: { m: any; turn?: number }[] = []
  const w: ActivityWriter = {
    suppressed: false,
    onMessage: (m, turn) => { if (!w.suppressed) seen.push({ m, turn }) },
    event: () => {},
  }
  return { w, seen }
}

describe('SessionHandle 注入 activity writer', () => {
  it('appendMessage 顺带喂 writer（含 turnId）', () => {
    const { w, seen } = spyWriter()
    const s = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir, w)
    s.appendMessage({ role: 'user', content: 'hi' }, 7)
    expect(seen).toEqual([{ m: { role: 'user', content: 'hi' }, turn: 7 }])
  })

  it('suppressActivity 期间不喂 writer，之后恢复', () => {
    const { w, seen } = spyWriter()
    const s = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir, w)
    s.suppressActivity(() => {
      s.appendMessage({ role: 'user', content: '重放1' }, 1)
      s.appendMessage({ role: 'user', content: '重放2' }, 2)
    })
    s.appendMessage({ role: 'user', content: '新的' }, 3)
    expect(seen.map(x => x.m.content)).toEqual(['新的'])
  })

  it('suppressActivity 内抛异常也会恢复标志（finally）', () => {
    const { w, seen } = spyWriter()
    const s = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir, w)
    expect(() => s.suppressActivity(() => { throw new Error('boom') })).toThrow('boom')
    s.appendMessage({ role: 'user', content: '之后' }, 1)
    expect(seen.map(x => x.m.content)).toEqual(['之后'])
  })

  it('不传 writer 时行为与之前完全一致（向后兼容）', () => {
    const s = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir)
    expect(() => s.appendMessage({ role: 'user', content: 'x' }, 1)).not.toThrow()
    expect(() => s.suppressActivity(() => {})).not.toThrow()
  })

  it('openSession 也能注入 writer（resume 续写同一日志文件）', () => {
    const { w, seen } = spyWriter()
    const s0 = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir)
    const s1 = openSession(s0.file, w)
    s1.appendMessage({ role: 'user', content: 'resumed' }, 1)
    expect(seen.map(x => x.m.content)).toEqual(['resumed'])
  })

  it('activity.onMessage 抛异常不影响会话落盘（fail-safe）', () => {
    const w: ActivityWriter = {
      suppressed: false,
      onMessage: () => { throw new Error('writer boom') },
      event: () => {},
    }
    const s = newSession({ cwd: '/r', model: 'm', thinking: false, permMode: 'default' }, dir, w)
    expect(() => s.appendMessage({ role: 'user', content: 'x' }, 1)).not.toThrow()
  })

  it('makeHandle 支持工厂形式 activity（先建文件再拿 sessionId 造 writer）', () => {
    const { w, seen } = spyWriter()
    let factoryFile: string | undefined
    const s = newSession(
      { cwd: '/r', model: 'm', thinking: false, permMode: 'default' },
      dir,
      (file: string) => { factoryFile = file; return w },
    )
    expect(factoryFile).toBe(s.file)
    s.appendMessage({ role: 'user', content: '工厂' }, 1)
    expect(seen.map(x => x.m.content)).toEqual(['工厂'])
  })
})

describe('toolOk 侧信道', () => {
  it('不污染消息对象（ok 不进 .jsonl、不进 wire）', async () => {
    const { toolOk } = await import('../src/loop.js')
    const msg: any = { role: 'tool', tool_call_id: 't1', content: 'ok' }
    toolOk.set(msg, true)
    expect(Object.keys(msg)).toEqual(['role', 'tool_call_id', 'content'])
    expect(JSON.parse(JSON.stringify(msg))).not.toHaveProperty('ok')
    expect(toolOk.get(msg)).toBe(true)
  })
})
