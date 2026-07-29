// test/helpers.ts
import { vi } from 'vitest'
import type { ToolContext } from '../src/tools/types.js'

/** 冻结 Date.now、改由用例手动推进的假时钟。
 *
 *  为什么不能用真等待测「上屏 N ms 内丢弃决策键」这类墙钟窗口：全量跑有 350+ 个测试文件并发，
 *  事件循环被饿住几十毫秒是常态而非例外，于是正反两个方向的断言都会随机翻车——
 *  等短了本该被丢的键反而生效，等长了本该生效的键反而被丢。加大 sleep 只是降低翻车概率
 *  并拖慢整套测试，机器一忙照样翻，本质仍是时序赌博。冻住时钟后墙钟耗时与判定完全解耦。
 *
 *  只替换 Date.now，**不动 setTimeout**：ink 的渲染节流靠真定时器，
 *  用 fake timers 把它一起冻住的话组件根本不会重绘，测试推进不下去。
 *  已确认 ink 与 react-reconciler 都不读 Date.now（前者用定时器、后者用 performance.now），
 *  故此替换不会波及渲染。 */
export function mockClock(start = 1_700_000_000_000) {
  let now = start
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now)
  return {
    advance: (ms: number) => { now += ms },
    restore: () => { spy.mockRestore() },
  }
}

export function makeCtx(cwd: string): ToolContext {
  return { cwd: () => cwd, setCwd: () => {}, signal: new AbortController().signal, fileState: new Map() }
}
