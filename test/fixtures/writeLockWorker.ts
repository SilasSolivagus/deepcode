// 跨进程写锁的真·多进程压测子进程：被 test/memory.writeLock.test.ts fork 起来。
// 协议：启动后发 ready → 收到 go 开跑一轮 → 跑完发 done + 本轮统计 → 收到 bye 退出。
import fs from 'node:fs'
import { acquireWriteLock, releaseWriteLock, holdsWriteLock } from '../../src/services/memory/writeLock.js'

const [dir, counterFile, iterationsArg] = process.argv.slice(2)
const iterations = Number(iterationsArg)

/** 同步占住临界区，把 read-modify-write 的窗口放大到毫秒级——没有窗口就测不出丢更新。 */
function hold(ms: number): void {
  const end = Date.now() + ms
  while (Date.now() < end) { /* 忙等 */ }
}

async function runRound(): Promise<{ writes: number; misses: number; aborts: number }> {
  let writes = 0
  let misses = 0
  let aborts = 0
  for (let i = 0; i < iterations; i++) {
    const token = await acquireWriteLock(dir)
    if (!token) { misses++; continue } // 重试耗尽：fail-safe 放弃本次写
    try {
      // 落盘前再校验：锁若已被误判抢走，放弃本次写（不算 writes）
      if (!holdsWriteLock(dir, token)) { aborts++; continue }
      const value = parseInt(fs.readFileSync(counterFile, 'utf8').trim(), 10)
      hold(2)
      fs.writeFileSync(counterFile, String(value + 1))
      writes++
    } finally {
      releaseWriteLock(dir, token)
    }
  }
  return { writes, misses, aborts }
}

process.on('message', (msg: unknown) => {
  const m = msg as { type?: string }
  if (m?.type === 'go') {
    void runRound().then(stats => { process.send?.({ type: 'done', ...stats }) })
  } else if (m?.type === 'bye') {
    process.exit(0)
  }
})

process.send?.({ type: 'ready' })
