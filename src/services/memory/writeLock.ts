import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const WRITE_LOCK = '.write-lock'

/** 写操作只有毫秒级，超过这个时长的锁一定是崩溃残留。 */
const STALE_MS = 30_000
/** 有界重试：写是毫秒级的，几十毫秒的退避几乎能救回全部瞬时争抢。 */
const DEFAULT_RETRIES = 5
const RETRY_MIN_MS = 20
const RETRY_MAX_MS = 50

export interface WriteLockOptions {
  /** 陈旧判定用的当前时刻；不传则每次尝试各自取 Date.now()。 */
  now?: number
  isPidAlive?: (pid: number) => boolean
  /** 有界重试次数（含首次尝试）。 */
  retries?: number
}

function pidAliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function errCode(e: unknown): string {
  return (e as NodeJS.ErrnoException | null)?.code ?? ''
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * 非争抢型失败（EPERM/EACCES/ENOSPC/锁路径变目录……）是环境坏了，不是正常抢占——
 * 且是永久性、全静默的：一旦命中，用户的记忆从此一条都写不进去，界面上却毫无提示。
 * 这里打破「绝不静默失效」的红线，所以要见光；但只打一次，防止刷屏。
 * 注意：EEXIST（正常争抢）永远不会走到这里，调用点已经把它筛掉了。
 */
let warnedUnexpectedFailure = false
function warnUnexpectedFailure(e: unknown): void {
  if (warnedUnexpectedFailure) return
  warnedUnexpectedFailure = true
  console.error('[memory] 写锁遇到非争抢型失败（环境异常，后续同类错误不再重复打印）：' + ((e instanceof Error) ? e.message : String(e)))
}

/** 锁文件的一次观察快照。raw 就是持有者 token（全局唯一），可当作这把锁的身份。 */
interface Observed { raw: string; pid: number; mtimeMs: number }

function observe(p: string): Observed | null {
  try {
    // stat 先于 read：缩小「mtime 来自新锁、raw 来自旧锁」的快照不一致窗口。
    const st = fs.statSync(p)
    const raw = fs.readFileSync(p, 'utf8')
    return { raw, pid: parseInt(raw.split(':')[0], 10), mtimeMs: st.mtimeMs }
  } catch {
    return null // 锁不存在/读不到 —— 什么都别删，交给调用方重新 link
  }
}

/**
 * 廉价 GC：清理进程被 SIGKILL 时残留的空 `.tmp.*` / `.steal.*` 文件，避免无界增长。
 * 年龄门槛不能省——没超过 STALE_MS 的文件可能是别的进程正在用的 in-flight 临时文件，
 * 删了会让它的 linkSync 发布失败。
 */
function gcOrphans(dir: string, now: number): void {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(`${WRITE_LOCK}.tmp.`) && !name.startsWith(`${WRITE_LOCK}.steal.`)) continue
      const p = path.join(dir, name)
      try {
        if (now - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true })
      } catch { /* 文件可能已被其所属进程清理，忽略 */ }
    }
  } catch { /* 目录不可读等，忽略——GC 是锦上添花，不能挡住取锁 */ }
}

/**
 * 陈旧判定。注意：内容非法（含 0 字节）但还新鲜时**不判陈旧** —— 我们无法证明它已死，
 * 宁可这次不写（fail-safe），也不要删掉一把可能还活着的锁。超过 STALE_MS 才回收，
 * 保证一把垃圾锁也不会永久卡死目录。
 */
function isStale(o: Observed, now: number, isPidAlive: (pid: number) => boolean): boolean {
  if (now - o.mtimeMs > STALE_MS) return true
  if (!Number.isFinite(o.pid) || o.pid <= 0) return false
  return !isPidAlive(o.pid)
}

/**
 * 原子夺取一把陈旧锁。renameSync 保证同一个存在的路径只有一个进程能移走，输家拿 ENOENT
 * 即知自己输了 —— 这是「无差别删锁」的解药：绝不用 rmSync 去删「此刻路径上的任何东西」。
 * 移走后再校验拿到的确实是当初观察到的那把陈旧锁；若在观察与夺取之间已被别人换成一把新活锁，
 * 用 linkSync 原样放回（linkSync 遇 EEXIST 不覆盖，是非破坏性的）。
 */
function stealStale(p: string, o: Observed): void {
  const side = `${p}.steal.${randomUUID()}`
  try { fs.renameSync(p, side) } catch { return } // ENOENT：别人抢先移走了，或持有者已正常释放
  let raw: string | null = null
  try { raw = fs.readFileSync(side, 'utf8') } catch { raw = null }
  if (raw === null || raw !== o.raw) {
    // 移走的不是那把陈旧锁（内容对不上），或读失败（如 EIO）证明不了它是谁 ——
    // 与 isStale() 同一条保守原则：证明不了它死，就不许删 → 原样归还（同一个 inode，内容/mtime 全不变）
    try { fs.linkSync(side, p) } catch { /* 路径已被他人占用 → 放弃归还 */ }
  }
  try { fs.rmSync(side, { force: true }) } catch { /* 忽略 */ }
}

/**
 * 单次尝试取锁。成功返回本次持有的 token（`pid:uuid`，全局唯一），失败返回 null。
 *
 * 发布锁分两步：先把 token 写进同目录临时文件，再 linkSync 到锁路径。linkSync 与
 * openSync('wx') 同样原子（已存在抛 EEXIST），但锁一出现在路径上就已带完整内容 ——
 * 不存在「先创建 0 字节文件、后写内容」的空锁窗口，别的进程不会读到空内容而误判陈旧。
 *
 * 任何失败（只读目录、ENOSPC、锁文件损坏……）都安静返回 null，绝不抛异常。
 */
export function tryAcquireWriteLock(dir: string, opts: WriteLockOptions = {}): string | null {
  const isPidAlive = opts.isPidAlive ?? pidAliveDefault
  const now = opts.now ?? Date.now()
  const p = path.join(dir, WRITE_LOCK)
  try { fs.mkdirSync(dir, { recursive: true }) } catch (e) { warnUnexpectedFailure(e); return null }

  gcOrphans(dir, now)

  const token = `${process.pid}:${randomUUID()}`
  const tmp = path.join(dir, `${WRITE_LOCK}.tmp.${process.pid}.${randomUUID()}`)
  try { fs.writeFileSync(tmp, token) } catch (e) { warnUnexpectedFailure(e); return null }

  try {
    // 两轮：第一轮发布；若锁已存在且陈旧，原子夺取后第二轮再发布。
    for (let round = 0; round < 2; round++) {
      try {
        fs.linkSync(tmp, p)
        return token
      } catch (e) {
        if (errCode(e) !== 'EEXIST') { warnUnexpectedFailure(e); return null } // 只读/不支持硬链接/ENOSPC → 见光一次后安静放弃
      }
      const o = observe(p)
      if (!o) continue // 锁刚好被释放 → 直接重来一轮 link
      if (!isStale(o, now, isPidAlive)) return null
      stealStale(p, o) // 夺取成败都回到 link：失败说明别人抢先了，link 会给出正确结果
    }
    return null
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 忽略 */ }
  }
}

/**
 * 有界重试取锁：写是毫秒级的，瞬时争抢退避几十毫秒几乎总能拿到。
 * 重试耗尽仍返回 null —— fail-safe 语义不变：宁可这次没记，也不要覆盖别人刚写的。
 */
export async function acquireWriteLock(dir: string, opts: WriteLockOptions = {}): Promise<string | null> {
  const retries = Math.max(1, opts.retries ?? DEFAULT_RETRIES)
  for (let i = 0; i < retries; i++) {
    const token = tryAcquireWriteLock(dir, opts)
    if (token) return token
    if (i < retries - 1) await sleep(RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS))
  }
  return null
}

/**
 * 持锁者落盘前必须再校验一次。锁是 advisory 的：进程被 SIGSTOP 挂起（Ctrl+Z）时 pid 仍存活、
 * mtime 却停住，锁可能被误判陈旧抢走。校验不通过就放弃本次写 —— 把「静默覆盖」降级为「静默丢一次」。
 */
export function holdsWriteLock(dir: string, token: string): boolean {
  try { return fs.readFileSync(path.join(dir, WRITE_LOCK), 'utf8') === token } catch { return false }
}

/**
 * 只删自己的锁。token 不匹配说明锁已易主 —— 无条件删锁会删掉当前持有者的锁，
 * 一次误判就级联摧毁后续每一位持有者。
 */
export function releaseWriteLock(dir: string, token: string): void {
  const p = path.join(dir, WRITE_LOCK)
  try {
    if (fs.readFileSync(p, 'utf8') !== token) return
    fs.rmSync(p, { force: true })
  } catch { /* 忽略 */ }
}

/**
 * 取锁 → 落盘前校验 → 释放，一步到位，把「正确用法」变成「唯一用法」。
 *
 * 三步式 API（acquire → 校验 → write → release）允许调用方漏掉 holdsWriteLock 校验——
 * 一旦漏掉，陈旧锁被两个进程同时夺取的微秒级窗口里就会并发写、丢更新。这里把校验
 * 通过 guard() 塞进 fn 的参数里，调用方想漏都漏不掉。
 *
 * 抢不到锁返回 null（fn 不会被调用）。fn 内部落盘前必须调用 guard()，返回 false 就
 * 弃写。fn 同步抛出或返回的 Promise 拒绝，都会向上传播，但 release 一定执行。
 */
export async function withWriteLock<T>(dir: string, fn: (guard: () => boolean) => T | Promise<T>): Promise<T | null> {
  const token = await acquireWriteLock(dir)
  if (!token) return null
  try {
    return await fn(() => holdsWriteLock(dir, token))
  } finally {
    releaseWriteLock(dir, token)
  }
}
