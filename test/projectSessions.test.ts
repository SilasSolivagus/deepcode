import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listProjectSessions } from '../src/memdir/projectSessions.js'
import { sanitizeProjectKey } from '../src/memdir/paths.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const write = (name: string, cwd: string, mtime: number) => {
  const f = path.join(dir, name)
  fs.writeFileSync(f, JSON.stringify({ t: 'meta', cwd }) + '\n')
  fs.utimesSync(f, new Date(mtime), new Date(mtime))
  return f
}

describe('listProjectSessions：按 projectKey 过滤（防串项目）', () => {
  it('只返回本项目的会话，别项目的会话不出现', () => {
    const mine = write('a.jsonl', dir, Date.now())
    write('other.jsonl', '/somewhere/else', Date.now())
    const key = sanitizeProjectKey(dir)
    expect(listProjectSessions(dir, key, 0)).toEqual([mine])
  })

  it('sinceMs 之前的会话被过滤', () => {
    write('old.jsonl', dir, 1000)
    const fresh = write('new.jsonl', dir, 9_000_000_000_000)
    expect(listProjectSessions(dir, sanitizeProjectKey(dir), 5_000_000_000_000)).toEqual([fresh])
  })

  it('excludeFile（当前会话）被排除', () => {
    const cur = write('cur.jsonl', dir, Date.now())
    write('b.jsonl', dir, Date.now())
    const out = listProjectSessions(dir, sanitizeProjectKey(dir), 0, cur)
    expect(out).not.toContain(cur)
  })

  it('损坏的首行不抛，跳过该文件', () => {
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), '不是 json\n')
    expect(() => listProjectSessions(dir, 'k', 0)).not.toThrow()
  })

  it('目录不存在返回空数组', () => {
    expect(listProjectSessions('/nope/nope', 'k', 0)).toEqual([])
  })
})
