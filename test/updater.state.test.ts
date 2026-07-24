import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readUpdateState, writeUpdateState, tryAcquireUpdateLock, releaseUpdateLock } from '../src/updater.js'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-upd-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('update state', () => {
  it('无文件读到 null', () => {
    expect(readUpdateState(dir)).toBeNull()
  })

  it('写后可读回', () => {
    writeUpdateState(dir, { lastCheckAt: 123, latest: '0.9.3' })
    expect(readUpdateState(dir)).toEqual({ lastCheckAt: 123, latest: '0.9.3' })
  })

  it('损坏 JSON 读到 null 而不抛', () => {
    fs.writeFileSync(path.join(dir, 'update.json'), '{ 坏掉的')
    expect(readUpdateState(dir)).toBeNull()
  })

  it('目录不存在时写入自动建目录', () => {
    const sub = path.join(dir, 'a', 'b')
    writeUpdateState(sub, { lastCheckAt: 1 })
    expect(readUpdateState(sub)?.lastCheckAt).toBe(1)
  })

  it('写失败不抛异常', () => {
    const f = path.join(dir, 'file')
    fs.writeFileSync(f, 'x') // 用文件当目录 → 写必失败
    expect(() => writeUpdateState(f, { lastCheckAt: 1 })).not.toThrow()
  })
})

describe('update lock', () => {
  const now = 1_000_000

  it('无锁可取', () => {
    expect(tryAcquireUpdateLock(dir, now)).toBe(true)
  })

  it('活进程持有的新鲜锁拒绝抢占', () => {
    tryAcquireUpdateLock(dir, now)
    expect(tryAcquireUpdateLock(dir, now + 1000, () => true)).toBe(false)
  })

  it('持有者进程已死可抢占', () => {
    tryAcquireUpdateLock(dir, now)
    expect(tryAcquireUpdateLock(dir, now + 1000, () => false)).toBe(true)
  })

  it('超过 10 分钟的过期锁可抢占', () => {
    tryAcquireUpdateLock(dir, now)
    expect(tryAcquireUpdateLock(dir, now + 600_001, () => true)).toBe(true)
  })

  it('释放后可再取', () => {
    tryAcquireUpdateLock(dir, now)
    releaseUpdateLock(dir)
    expect(tryAcquireUpdateLock(dir, now + 1, () => true)).toBe(true)
  })
})
