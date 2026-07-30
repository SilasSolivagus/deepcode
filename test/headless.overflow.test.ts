// test/headless.overflow.test.ts
// headless 是跑评测与一切程序化调用的路径：runHeadless 消费 runLoop 的循环此前只有
// finally{ mcpCleanup() }，没有任何 catch——上下文超窗时异常直接穿出 runHeadless，
// index.ts 的 exitCode 判定被跳过，调用方只拿到堆栈而非可诊断结果。本文件锁住修复后的行为：
// 首次超窗压缩重试一次，仍失败则返回 status:'context_overflow' 而不是抛出；非超窗错误照常抛；
// mcpCleanup 无论重试与否只跑一次；用户中断优先于「压缩后仍超窗」的判定。
//
// 桩法照 test/subagentRunner.cdFenceEscape.test.ts：只 mock chatStream 脚本化模型返回，
// 工具（Read）走真实实现，断言落在 runHeadless 的真实返回值上。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 脚本：每一项要么是要抛的错、要么是一次正常返回，要么是「本次调用时强制 abort ctx.signal」（中断优先级用例专用）
const script: Array<{ throw?: Error; result?: any; abort?: true }> = []
let seenLengths: number[] = []

vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    // 真实 chatStream 签名是 chatStream(client, opts)，opts.messages 是消息数组、opts.signal 是本轮
    // AbortSignal——不是最初草稿里想当然的 (client, msgs)，这里按真实签名接（headless.test.ts 里
    // `vi.mocked(chatStream).mock.calls` 的用法印证了这一点）。
    chatStream: vi.fn((_client: any, opts: any) => {
      seenLengths.push(JSON.stringify(opts.messages).length) // 记下每次请求的体积，用来证明确实压过
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      if (scene.abort) {
        // AbortSignal.aborted 是原型上的 getter，实例上 defineProperty 出同名属性可以遮蔽它，
        // 让 loop.ts 里 `deps.ctx.signal.aborted` 的判断读到 true，从而真实触发硬中断分支。
        Object.defineProperty(opts.signal, 'aborted', { value: true, configurable: true })
        throw new Error('aborted for test')
      }
      if (scene.throw) throw scene.throw
      return (async function* () { return scene.result })()
    }),
  }
})

let cleanupCalls = 0
vi.mock('../src/mcp.js', async orig => {
  const actual = await orig<typeof import('../src/mcp.js')>()
  return { ...actual, initMcpTools: vi.fn(async () => ({ tools: [], cleanup: async () => { cleanupCalls++ } })) }
})

// 隔离真实设置：不这样做的话 loadLayeredSettings 会读本机 ~/.deepcode/settings.json（真实
// model/provider/permissions/memory 等），测试结果就绑死在开发者个人配置上——换台机器、或本机
// 改了 memory.enabled / 加了 mcpServers / 配了 permissions.deny，结果可能跟着变且看不出是环境导致的。
// 照抄 test/headless.test.ts:18-61 的结构（hooks.js + config.js + settingsLayers.js 三件套）。
vi.mock('../src/hooks.js', async orig => {
  const actual = await orig<typeof import('../src/hooks.js')>()
  return {
    ...actual,
    runHooks: vi.fn(async () => ({ block: false, preventContinuation: false, stop: false, results: [] })),
  }
})

const mockSettings = {
  permissions: { allow: [] },
  compactTokens: 200_000,
  costWarnCNY: 15,
  hooks: {
    SessionStart: [{ matcher: '*', hooks: [] }],
    InstructionsLoaded: [{ matcher: '*', hooks: [] }],
    UserPromptSubmit: [{ matcher: '*', hooks: [] }],
  },
}

vi.mock('../src/config.js', async orig => {
  const actual = await orig<typeof import('../src/config.js')>()
  return { ...actual, loadSettings: vi.fn(() => mockSettings) }
})

vi.mock('../src/settingsLayers.js', async orig => {
  const actual = await orig<typeof import('../src/settingsLayers.js')>()
  return {
    ...actual,
    loadLayeredSettings: vi.fn(() => ({
      settings: mockSettings,
      provenance: {},
      permissionSources: { allow: {}, deny: {} },
      scopes: [],
      strippedDangerousRules: [],
    })),
  }
})

import { runHeadless } from '../src/headless.js'

const usage = { prompt_tokens: 1, completion_tokens: 1, prompt_cache_hit_tokens: 0 }
const overflow = () => new Error('This model maximum context length is 128000 tokens')
const home = () => mkdtempSync(path.join(tmpdir(), 'dc-of-'))

// microcompact 的甩弃条件：tool 消息数 > keepRecent(5)，且被甩的旧 tool 消息合计估算 token ≥ floor(20000)。
// 首轮消息（system+user）太薄够不到这两条，直接超窗只会判定 plan.action='report'（不会进重试分支）。
// 用 Read 真读一个大文件撑出够份量的 tool 消息：6 轮工具调用后有 6 条 tool 消息，前 1 条落入「旧」区间，
// 该条内容本身已远超 floor（maxToolResultChars 上限 100000 字符 ≈ 30000 token 估算），足以触发 retry。
function bigFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-of-fixture-'))
  const p = path.join(dir, 'big.txt')
  const line = 'x'.repeat(700)
  writeFileSync(p, Array.from({ length: 300 }, () => line).join('\n'))
  return p
}

/** 6 轮「调用 Read 读大文件」的工具调用脚本项，垫出 microcompact 能甩的体量。 */
function bulkReadTurns(file: string): Array<{ result: any }> {
  return Array.from({ length: 6 }, (_, i) => ({
    result: {
      content: '', toolCalls: [{ id: `r${i}`, name: 'Read', args: JSON.stringify({ file_path: file }) }],
      usage, finishReason: 'tool_calls',
    },
  }))
}

describe('headless 上下文超窗恢复', () => {
  beforeEach(() => { script.length = 0; seenLengths = []; cleanupCalls = 0 })

  it('首次超窗、压缩后重跑成功 → done，且第二次请求更小', async () => {
    script.push(...bulkReadTurns(bigFile()))
    script.push({ throw: overflow() })
    script.push({ result: { content: '压缩后完成', toolCalls: [], usage, finishReason: 'stop' } })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    expect(r.text).toContain('压缩后完成')
    // 第 7 次调用＝抛超窗前那次（未压缩），第 8 次＝压缩重试后那次——必须真的变小，
    // 否则说明 messages 没被原地改写、重试跑的还是旧内容。
    expect(seenLengths).toHaveLength(8)
    expect(seenLengths[7]).toBeLessThan(seenLengths[6])
  })

  it('两次都超窗 → 返回 context_overflow，不抛出', async () => {
    script.push(...bulkReadTurns(bigFile()))
    script.push({ throw: overflow() })
    script.push({ throw: overflow() })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('context_overflow')
  })

  it('非超窗错误照常抛出（不被本机制吞掉）', async () => {
    script.push({ throw: new Error('provider 502') })
    await expect(runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() }))
      .rejects.toThrow('provider 502')
  })

  // spec §5：mcpCleanup 在最外层 finally，重试不得让它跑两次（跑两次会二次关闭已关的 MCP 子进程）
  it('重试场景下 mcpCleanup 只执行一次', async () => {
    script.push(...bulkReadTurns(bigFile()))
    script.push({ throw: overflow() })
    script.push({ result: { content: '完成', toolCalls: [], usage, finishReason: 'stop' } })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    expect(cleanupCalls).toBe(1)
  })

  // spec §6 开放项：重试期间用户中断时，返回的应是 aborted 而非 context_overflow——中断优先。
  // runLoop 返回 'aborted' 的真实触发点是 deps.ctx.signal.aborted（loop.ts:226/409），不是返回值里的
  // 字段，所以在压缩重试后的第二次 chatStream 调用里直接强制 abort ctx 的 signal（见顶部 mock）。
  it('重试期间被中断 → aborted 优先于 context_overflow', async () => {
    script.push(...bulkReadTurns(bigFile()))
    script.push({ throw: overflow() })
    script.push({ abort: true })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('aborted')
  })

  // Critical 1：超窗但 microcompact 无可甩（mc === null）此前会被误判为「非超窗→抛出」，
  // 堆栈穿出 runHeadless、index.ts 的 exitCode 赋值被跳过、崩溃前部分产出全丢。
  // 首请求就超窗（无工具调用、messages 只有 system+user）正是这条路径最常见的入口之一。
  it('薄 messages（无可甩的旧工具输出）+ 单次超窗 → context_overflow，不抛出', async () => {
    script.push({ throw: overflow() })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('context_overflow')
  })
})
