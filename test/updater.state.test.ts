import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('latest 含 ESC 控制序列 → 读回 undefined（/doctor 会把 latest 插值进终端，读侧须与写侧同一白名单）', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'update.json'),
      JSON.stringify({ lastCheckAt: 1, latest: '1.0.0\x1b]0;pwned\x07' }),
    )
    const s = readUpdateState(dir)
    expect(s?.lastCheckAt).toBe(1)
    expect(s?.latest).toBeUndefined()
  })

  it('latest 超长串 → 读回 undefined', () => {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'update.json'),
      JSON.stringify({ lastCheckAt: 1, latest: '9'.repeat(5000) }),
    )
    const s = readUpdateState(dir)
    expect(s?.lastCheckAt).toBe(1)
    expect(s?.latest).toBeUndefined()
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

  it('release 不会误删已被别的进程重新抢占的锁（缺陷1：持有者身份校验）', () => {
    tryAcquireUpdateLock(dir, now) // A（当前测试进程）抢到锁
    // 模拟 A 的锁过期后 B 合法抢占：锁文件被覆写为 B 的 pid（与当前进程不同）
    const lockPath = path.join(dir, 'update.lock')
    const bPid = process.pid + 1
    fs.writeFileSync(lockPath, String(bPid))
    releaseUpdateLock(dir) // A 结束后调用释放，但此时锁已经不是 A 的了
    expect(fs.existsSync(lockPath)).toBe(true)
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe(String(bPid))
  })

  it('检测与写入之间的竞态窗口不会静默覆盖已存在的锁（缺陷2：排他创建 wx）', () => {
    // 模拟另一进程恰好在"判定可抢占"之后、"写入"之前抢先创建了锁文件
    fs.mkdirSync(dir, { recursive: true })
    const lockPath = path.join(dir, 'update.lock')
    fs.writeFileSync(lockPath, '424242')
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    const result = tryAcquireUpdateLock(dir, now, () => true)
    statSpy.mockRestore()
    expect(result).toBe(false)
    expect(fs.readFileSync(lockPath, 'utf8').trim()).toBe('424242')
  })
})
