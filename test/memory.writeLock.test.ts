import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  tryAcquireWriteLock,
  acquireWriteLock,
  releaseWriteLock,
  holdsWriteLock,
  withWriteLock,
  WRITE_LOCK,
} from '../src/services/memory/writeLock.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const WORKER = path.join(HERE, 'fixtures', 'writeLockWorker.ts')

describe('跨进程写锁', () => {
  let dir: string
  let lock: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wl-'))
    lock = path.join(dir, WRITE_LOCK)
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  test('首次取锁成功，锁文件内容就是返回的 token', () => {
    const token = tryAcquireWriteLock(dir)
    expect(token).toBeTruthy()
    expect(fs.readFileSync(lock, 'utf8')).toBe(token)
    expect(token!.startsWith(`${process.pid}:`)).toBe(true)
  })

  test('活进程持锁时，第二次取锁失败（不覆盖对方）', () => {
    expect(tryAcquireWriteLock(dir)).toBeTruthy()
    expect(tryAcquireWriteLock(dir)).toBeNull()
  })

  test('释放后可重新取锁，且新 token 与旧的不同', () => {
    const a = tryAcquireWriteLock(dir)!
    releaseWriteLock(dir, a)
    expect(fs.existsSync(lock)).toBe(false)
    const b = tryAcquireWriteLock(dir)!
    expect(b).toBeTruthy()
    expect(b).not.toBe(a)
  })

  test('死进程的锁可抢占（rename 原子夺取）', () => {
    fs.writeFileSync(lock, '999999:dead-holder')
    const token = tryAcquireWriteLock(dir, { isPidAlive: () => false })
    expect(token).toBeTruthy()
    expect(fs.readFileSync(lock, 'utf8')).toBe(token)
  })

  test('陈旧锁（超 30s）即使 pid 活着也可抢占', () => {
    const stale = tryAcquireWriteLock(dir)!
    const token = tryAcquireWriteLock(dir, { now: Date.now() + 31_000, isPidAlive: () => true })
    expect(token).toBeTruthy()
    expect(token).not.toBe(stale)
    expect(fs.readFileSync(lock, 'utf8')).toBe(token)
  })

  test('目录不存在时自动创建', () => {
    const sub = path.join(dir, 'a', 'b')
    expect(tryAcquireWriteLock(sub)).toBeTruthy()
    expect(fs.existsSync(path.join(sub, WRITE_LOCK))).toBe(true)
  })

  test('取锁后不留临时文件与夺取残骸', () => {
    tryAcquireWriteLock(dir)
    expect(fs.readdirSync(dir)).toEqual([WRITE_LOCK])
  })

  // ---- Critical 1：空锁窗口 ----

  test('[C1] 新鲜的 0 字节锁文件不得被抢占（旧实现在此误判陈旧并删掉活锁）', () => {
    fs.writeFileSync(lock, '') // 旧实现 openSync('wx') 后、writeSync 前，活锁就长这样
    expect(tryAcquireWriteLock(dir)).toBeNull()
    expect(fs.existsSync(lock)).toBe(true)
    expect(fs.readFileSync(lock, 'utf8')).toBe('') // 别人的锁必须原封不动
  })

  test('[C1] 内容非法但新鲜的锁不得被抢占；超过 30s 后才可回收（垃圾锁不会永久卡死）', () => {
    fs.writeFileSync(lock, '不是 pid')
    expect(tryAcquireWriteLock(dir)).toBeNull()
    expect(tryAcquireWriteLock(dir, { now: Date.now() + 31_000 })).toBeTruthy()
  })

  test('[C1] 发布出去的锁永远带完整内容（无 0 字节窗口）', () => {
    // linkSync 原子发布：路径上一旦出现锁文件，内容就已经是完整 token
    const token = tryAcquireWriteLock(dir)!
    const st = fs.statSync(lock)
    expect(st.size).toBe(Buffer.byteLength(token))
  })

  // ---- Critical 2：无差别删锁 ----

  test('[C2] 观察到陈旧锁后、夺取前锁已易主 → 不得删掉新持有者的锁', () => {
    fs.writeFileSync(lock, '999999:stale') // 一把陈旧锁（pid 已死）
    const newHolder = `${process.pid}:new-holder`
    let swapped = false
    // isPidAlive 在「观察之后、夺取之前」被调用——在这里模拟 C 抢到锁并进入临界区
    const isPidAlive = (pid: number): boolean => {
      if (!swapped) {
        swapped = true
        fs.rmSync(lock)
        fs.writeFileSync(lock, newHolder) // C 的新活锁
        return false // 我们观察到的那把（999999）确实已死
      }
      return true // C 活着
    }
    expect(tryAcquireWriteLock(dir, { isPidAlive })).toBeNull() // 抢不到 → fail-safe
    expect(fs.readFileSync(lock, 'utf8')).toBe(newHolder) // C 的锁完好无损
    expect(fs.readdirSync(dir)).toEqual([WRITE_LOCK]) // 夺取残骸已清理
  })

  // ---- Critical 3：release 无条件删锁 ----

  test('[C3] release 不得删掉不属于自己的锁', () => {
    const mine = tryAcquireWriteLock(dir)!
    const theirs = `${process.pid}:someone-else`
    fs.writeFileSync(lock, theirs) // 我的锁被误判陈旧、已被别人抢走
    releaseWriteLock(dir, mine) // 我干完活来释放
    expect(fs.existsSync(lock)).toBe(true) // 一次误判不得级联摧毁后续持有者
    expect(fs.readFileSync(lock, 'utf8')).toBe(theirs)
  })

  test('[C3] release 只删自己的锁，且 token 用后即废', () => {
    const token = tryAcquireWriteLock(dir)!
    releaseWriteLock(dir, token)
    expect(fs.existsSync(lock)).toBe(false)
    const next = tryAcquireWriteLock(dir)!
    releaseWriteLock(dir, token) // 拿旧 token 再释放一次：不得删掉新持有者的锁
    expect(fs.readFileSync(lock, 'utf8')).toBe(next)
  })

  // ---- Important 4：落盘前再校验 ----

  test('[I4] holdsWriteLock：锁被抢走后持锁者必须能察觉（放弃本次写而不是静默覆盖）', () => {
    const token = tryAcquireWriteLock(dir)!
    expect(holdsWriteLock(dir, token)).toBe(true)
    fs.writeFileSync(lock, `${process.pid}:thief`) // 被误判陈旧抢走（如 SIGSTOP 后 mtime 停住）
    expect(holdsWriteLock(dir, token)).toBe(false)
    fs.rmSync(lock)
    expect(holdsWriteLock(dir, token)).toBe(false) // 锁没了也算没持有
  })

  // ---- Minor 7：有界重试 ----

  test('[M7] acquireWriteLock 有界重试：持有者中途释放则能抢到', async () => {
    const held = tryAcquireWriteLock(dir)!
    setTimeout(() => releaseWriteLock(dir, held), 40)
    const token = await acquireWriteLock(dir)
    expect(token).toBeTruthy()
  })

  test('[M7] 重试耗尽仍返回 null（fail-safe，绝不抛异常）', async () => {
    tryAcquireWriteLock(dir)
    const token = await acquireWriteLock(dir, { retries: 2 })
    expect(token).toBeNull()
  })

  // ---- fail-safe ----

  test('只读目录取锁安静失败，不抛异常', () => {
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wl-ro-'))
    fs.chmodSync(ro, 0o500)
    try {
      expect(tryAcquireWriteLock(ro)).toBeNull()
    } finally {
      fs.chmodSync(ro, 0o700)
      fs.rmSync(ro, { recursive: true, force: true })
    }
  })

  test('release 传入不存在目录不抛异常', () => {
    expect(() => releaseWriteLock(path.join(dir, 'nope'), 'x')).not.toThrow()
  })

  // ---- withWriteLock：把「正确用法」变成「唯一用法」 ----

  test('[withWriteLock] 成功路径：取锁 → fn 拿到可用的 guard → 释放 → 返回 fn 的返回值', async () => {
    const result = await withWriteLock(dir, guard => {
      expect(guard()).toBe(true) // 落盘前校验：此刻确实持锁
      expect(fs.existsSync(lock)).toBe(true) // fn 执行期间锁确实在
      return 42
    })
    expect(result).toBe(42)
    expect(fs.existsSync(lock)).toBe(false) // 已释放，不留锁文件
  })

  test('[withWriteLock] fn 抛异常时仍然 release，异常向上传播', async () => {
    await expect(withWriteLock(dir, () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(fs.existsSync(lock)).toBe(false) // finally 里 release 执行了
  })

  test('[withWriteLock] fn 返回被拒绝的 Promise 时仍然 release', async () => {
    await expect(withWriteLock(dir, async () => { throw new Error('async boom') })).rejects.toThrow('async boom')
    expect(fs.existsSync(lock)).toBe(false)
  })

  test('[withWriteLock] 锁被误判陈旧抢走后，guard() 能让 fn 发现并弃写；release 不误删新持有者的锁', async () => {
    let observedGuard: boolean | undefined
    const result = await withWriteLock(dir, guard => {
      // 模拟：陈旧夺取窗口里，另一个进程已经把锁换成了它自己的
      fs.writeFileSync(lock, `${process.pid}:thief`)
      observedGuard = guard()
      return 'fn 的返回值不受 guard 影响，由调用方决定要不要真的落盘'
    })
    expect(observedGuard).toBe(false)
    expect(result).toBe('fn 的返回值不受 guard 影响，由调用方决定要不要真的落盘')
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.pid}:thief`) // release 校验 token 不匹配，未误删
  })

  test('[withWriteLock] 抢不到锁时返回 null，fn 完全不被调用', async () => {
    const held = tryAcquireWriteLock(dir)!
    let called = false
    const result = await withWriteLock(dir, () => { called = true; return 'x' })
    expect(result).toBeNull()
    expect(called).toBe(false)
    releaseWriteLock(dir, held)
  })

  // ---- GC：孤儿 .tmp/.steal 文件 ----

  test('[GC] 清理超过 STALE_MS 的孤儿 .tmp/.steal 文件，但不动新鲜的（年龄门槛不能省）', () => {
    const oldTmp = path.join(dir, `${WRITE_LOCK}.tmp.orphan`)
    const oldSteal = path.join(dir, `${WRITE_LOCK}.steal.orphan`)
    fs.writeFileSync(oldTmp, 'x')
    fs.writeFileSync(oldSteal, 'y')
    const old = new Date(Date.now() - 31_000)
    fs.utimesSync(oldTmp, old, old)
    fs.utimesSync(oldSteal, old, old)

    const freshTmp = path.join(dir, `${WRITE_LOCK}.tmp.inflight`)
    fs.writeFileSync(freshTmp, 'z') // 别的进程正在用的 in-flight 临时文件，mtime 是刚才

    expect(tryAcquireWriteLock(dir)).toBeTruthy()

    expect(fs.existsSync(oldTmp)).toBe(false) // 超龄孤儿被清
    expect(fs.existsSync(oldSteal)).toBe(false)
    expect(fs.existsSync(freshTmp)).toBe(true) // 新鲜的绝不误删
  })

  // ---- stealStale：读校验失败时的保守方向 ----

  test('[stealStale] 夺取后读校验失败（如 EIO）证明不了身份 → 按稳妥原则归还而非直接删，取锁失败', () => {
    fs.writeFileSync(lock, '999999:stale') // 一把陈旧锁（pid 已死）
    const realRead = fs.readFileSync.bind(fs)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, enc?: unknown) => {
      if (typeof p === 'string' && p.includes(`${WRITE_LOCK}.steal.`)) {
        const err = new Error('simulated EIO') as NodeJS.ErrnoException
        err.code = 'EIO'
        throw err
      }
      return (realRead as (p: fs.PathOrFileDescriptor, enc?: unknown) => unknown)(p, enc)
    }) as typeof fs.readFileSync)

    try {
      // 读校验失败 → 归还而非删除 → 第二轮 link 仍撞见占用的 p → 抢锁失败（fail-safe）
      expect(tryAcquireWriteLock(dir, { isPidAlive: () => false })).toBeNull()
      expect(fs.readFileSync(lock, 'utf8')).toBe('999999:stale') // 原锁被原样归还，没有被删
      expect(fs.readdirSync(dir)).toEqual([WRITE_LOCK]) // 归还后仍清理了 side 临时文件
    } finally {
      readSpy.mockRestore()
    }
  })

  // ---- observe()：快照一致性 ----

  test('[observe] 先 statSync 后 readFileSync，缩小 mtime/内容快照不一致的窗口', () => {
    fs.writeFileSync(lock, '999999:dead') // 陈旧锁（pid 已死），触发 observe()
    const order: string[] = []
    const realStat = fs.statSync.bind(fs)
    const realRead = fs.readFileSync.bind(fs)
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((p: fs.PathLike, opts?: unknown) => {
      if (p === lock) order.push('stat')
      return (realStat as (p: fs.PathLike, opts?: unknown) => unknown)(p, opts)
    }) as typeof fs.statSync)
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, enc?: unknown) => {
      if (p === lock) order.push('read')
      return (realRead as (p: fs.PathOrFileDescriptor, enc?: unknown) => unknown)(p, enc)
    }) as typeof fs.readFileSync)

    try {
      expect(tryAcquireWriteLock(dir, { isPidAlive: () => false })).toBeTruthy()
      const statIdx = order.indexOf('stat')
      const readIdx = order.indexOf('read')
      expect(statIdx).toBeGreaterThanOrEqual(0)
      expect(readIdx).toBeGreaterThan(statIdx) // stat 必须先于 read
    } finally {
      statSpy.mockRestore()
      readSpy.mockRestore()
    }
  })
})

describe('跨进程写锁 · 非争抢型失败可见性', () => {
  // 用独立的 vi.resetModules() + 动态 import 拿一份全新的模块实例，
  // 避免 warned 这个模块级标志被本文件其它用例（如「只读目录取锁安静失败」）提前置位而误判。
  test('[Minor·可见性] 非 EEXIST 失败（环境坏了，不是争抢）打一次 console.error，重复失败不再刷屏', async () => {
    vi.resetModules()
    const fresh = await import('../src/services/memory/writeLock.js')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ro = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wl-vis-'))
    fs.chmodSync(ro, 0o500) // 可读可执行、不可写 —— 建临时文件会 EACCES，且不是 EEXIST
    try {
      expect(fresh.tryAcquireWriteLock(ro)).toBeNull()
      expect(errSpy).toHaveBeenCalledTimes(1)
      expect(String(errSpy.mock.calls[0][0])).toContain('[memory]')

      expect(fresh.tryAcquireWriteLock(ro)).toBeNull() // 同类失败再来一次
      expect(errSpy).toHaveBeenCalledTimes(1) // 不再重复打印
    } finally {
      errSpy.mockRestore()
      fs.chmodSync(ro, 0o700)
      fs.rmSync(ro, { recursive: true, force: true })
    }
  })

  test('[Minor·可见性] EEXIST（正常争抢）不触发 console.error', () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wl-vis2-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(tryAcquireWriteLock(dir2)).toBeTruthy()
      expect(tryAcquireWriteLock(dir2)).toBeNull() // 活锁挡住 → EEXIST，正常争抢
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
      fs.rmSync(dir2, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// 真·多进程互斥测试。这是唯一能证明互斥成立的测试形态：同进程内的用例（连 isPidAlive
// 都能 mock）对跨进程锁零覆盖——把 STALE_MS 改成 1（= 完全没有互斥）它们照样全绿。
// N 个真 OS 进程屏障同步起跑，临界区做 read-modify-write 计数：
//   counter === 所有子进程实际写入次数之和  ⇔  没有丢更新 ⇔ 互斥成立
//   aborts === 0                            ⇔  没有一把活锁被误判陈旧抢走
// ============================================================================
describe('跨进程写锁 · 真·多进程互斥', () => {
  // 第 1 轮（进程冷启、代码未 JIT）争抢最凶：旧实现的空锁窗口正是在这一轮被撞开的
  // （实测旧实现第 1 轮丢 22%~24%，之后几轮 0% —— 单测测不到它，正是因为窗口被 JIT 缩掉了）。
  const CHILDREN = 10
  const ITERATIONS = 12
  const ROUNDS = 3

  let dir: string
  let counterFile: string
  let kids: ChildProcess[] = []

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-wl-mp-'))
    counterFile = path.join(dir, 'counter.txt')
  })
  afterEach(() => {
    for (const k of kids) k.kill('SIGKILL')
    kids = []
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test(`${CHILDREN} 个真实进程 × ${ROUNDS} 轮争抢：计数器不丢一次更新`, async () => {
    kids = Array.from({ length: CHILDREN }, () => fork(WORKER, [dir, counterFile, String(ITERATIONS)], {
      cwd: REPO_ROOT,
      execArgv: ['--import', 'tsx'], // 子进程直接跑 TS 源码，不继承 vitest 的 execArgv
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }))

    // 屏障：等全部子进程就绪
    await Promise.all(kids.map(k => new Promise<void>((resolve, reject) => {
      k.once('message', (m: { type?: string }) => m?.type === 'ready' ? resolve() : reject(new Error('bad handshake')))
      k.once('error', reject)
      k.once('exit', code => reject(new Error(`子进程启动即退出，code=${code}`)))
    })))

    const totals = { writes: 0, misses: 0, aborts: 0 }
    for (let round = 0; round < ROUNDS; round++) {
      fs.writeFileSync(counterFile, '0')

      const results = kids.map(k => new Promise<{ writes: number; misses: number; aborts: number }>((resolve, reject) => {
        k.once('message', (m: { type?: string; writes?: number; misses?: number; aborts?: number }) => {
          if (m?.type !== 'done') return reject(new Error('bad message'))
          resolve({ writes: m.writes!, misses: m.misses!, aborts: m.aborts! })
        })
        k.once('error', reject)
      }))
      for (const k of kids) k.send({ type: 'go' }) // 同时起跑
      const stats = await Promise.all(results)

      const writes = stats.reduce((s, x) => s + x.writes, 0)
      const misses = stats.reduce((s, x) => s + x.misses, 0)
      const aborts = stats.reduce((s, x) => s + x.aborts, 0)
      const counter = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10)
      totals.writes += writes; totals.misses += misses; totals.aborts += aborts

      // eslint-disable-next-line no-console
      console.log(`[多进程 第 ${round + 1} 轮] 计数器=${counter} 实际写入=${writes} 取锁失败=${misses} 落盘前弃写=${aborts}`)

      // 核心断言：临界区里的 read-modify-write 一次都没被并发覆盖
      expect(counter).toBe(writes)
      // 活着的持有者只占锁几毫秒，绝不该被判陈旧抢走
      expect(aborts).toBe(0)
      // 锁真的在起作用（否则「不丢更新」可能只是因为大家都没写）
      expect(writes).toBeGreaterThan(0)
    }

    // eslint-disable-next-line no-console
    console.log(`[多进程 合计] 尝试=${CHILDREN * ITERATIONS * ROUNDS} 写入=${totals.writes} 取锁失败=${totals.misses} 弃写=${totals.aborts}`)
    expect(fs.existsSync(path.join(dir, WRITE_LOCK))).toBe(false) // 全部正常释放
    expect(fs.readdirSync(dir)).toEqual(['counter.txt']) // 无临时文件/夺取残骸泄漏

    for (const k of kids) k.send({ type: 'bye' })
  }, 120_000)
})
