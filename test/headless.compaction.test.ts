// test/headless.compaction.test.ts
// headless（跑评测与一切程序化调用的路径）在 drive() 结束后**不做**主动压缩，尽管它接好了
// 与 TUI 共用的 compactionManager。本文件锁住这个「接线在、但末尾不触发」的行为。
//
// 为什么不触发（详见 headless.ts 对应注释）：drive() 结束后 messages 再也不发给 API，只剩
// 「抽 final 文本」一个消费者，压缩在本 run 内零收益；而代价是一次真实 summarize 调用被计进
// 对外的 usage/costCNY，更严重的是 rebuildMessages 把历史砍成 [system, 总结, 最近 8 条]，
// 会把落在 last-8 之外的最后一条 assistant 文本连同产出一起砍掉——正是 headless.ts 开头承诺
// 要保住的「崩溃前的部分产出」。第二条用例就是这个回归的网。
// 真正的主动闸门要落在 runLoop 轮间，另有一份 spec；届时这两条用例需要随之改写。
//
// 隔离同 test/headless.overflow.test.ts（先读过，本仓踩过的坑）：不 mock config.js/settingsLayers.js/
// mcp.js 就会读本机真实 ~/.deepcode/settings.json，测试结果会绑死在开发者个人配置上。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 与 test/headless.overflow.test.ts 同形的脚本桩：每项是一次 chatStream 返回，或是要抛的错
const script: Array<{ result?: any; throw?: Error }> = []
vi.mock('../src/api.js', async orig => {
  const actual = await orig<typeof import('../src/api.js')>()
  return {
    ...actual,
    chatStream: vi.fn(() => {
      const scene = script.shift()
      if (!scene) throw new Error('script exhausted')
      if (scene.throw) throw scene.throw
      return (async function* () { return scene.result })()
    }),
  }
})
vi.mock('../src/compact.js', async orig => ({
  ...(await orig() as any),
  summarize: vi.fn(async () => ({
    summary: '历史总结', usage: { prompt_tokens: 5, completion_tokens: 5, prompt_cache_hit_tokens: 0 }, truncated: false,
  })),
}))

vi.mock('../src/mcp.js', async orig => {
  const actual = await orig<typeof import('../src/mcp.js')>()
  return { ...actual, initMcpTools: vi.fn(async () => ({ tools: [], cleanup: async () => {} })) }
})

// 隔离真实设置：照抄 test/headless.overflow.test.ts 的三件套（config.js + settingsLayers.js + mcp.js）。
// compactTokens 设为 20000，让阈值靠脚本里的 usage.prompt_tokens 够得着，不用堆真实大文件。
// 不设 hooks 字段：headless.ts 里 SessionStart/UserPromptSubmit/PreCompact/PostCompact 各处
// 都以 `if (settings.hooks)` 为门，留空即可跳过真实 runHooks，不必再多 mock 一个 hooks.js。
const mockSettings = {
  permissions: { allow: [] },
  compactTokens: 20000,
  costWarnCNY: 15,
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
import { summarize } from '../src/compact.js'

const usage = (pt: number) => ({ prompt_tokens: pt, completion_tokens: 1, prompt_cache_hit_tokens: 0 })
const stop = (content: string, pt: number) => ({
  result: { content, toolCalls: [], usage: usage(pt), finishReason: 'stop' },
})
const home = () => mkdtempSync(path.join(tmpdir(), 'dc-hc-'))
const overflow = () => new Error('This model maximum context length is 128000 tokens')

/** 小文件：只为垫出真实 tool 消息，不需要像 overflow 测试那样撑到 microcompact 的甩弃门槛。 */
function smallFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dc-hc-fixture-'))
  const p = path.join(dir, 'small.txt')
  writeFileSync(p, 'hello\n')
  return p
}

/** 一轮「调用 Read 读文件」的工具调用脚本项；content 非空时该轮 assistant 会带上这段文本。 */
const readTurn = (file: string, i: number, pt: number, content = '') => ({
  result: {
    content, toolCalls: [{ id: `r${i}`, name: 'Read', args: JSON.stringify({ file_path: file }) }],
    usage: usage(pt), finishReason: 'tool_calls',
  },
})

describe('headless 末尾不做主动压缩', () => {
  beforeEach(() => { script.length = 0; vi.clearAllMocks() })

  // 防退回网：这行曾经存在（见 git history 的 2284c72），撤掉的理由在文件头。
  // 谁把 `await compaction.maybeCompact(messages)` 加回 drive() 之后，这条会红。
  it('prompt_tokens 远超阈值 → 仍不触发压缩', async () => {
    script.push(stop('完成', 25000))   // ≥ mock settings 里的 compactTokens=20000
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('done')
    expect(summarize).not.toHaveBeenCalled()
  })

  // Critical 回归网：末尾压缩会用 rebuildMessages 把历史砍成 [system, 总结, 最近 8 条]，
  // 让第 3 条消息位上那句「部分产出」落到窗口之外，text 被抽成空串——
  // 而 headless.ts 开头明写超窗要「保住崩溃前的部分产出」。
  // 构造：首轮 assistant 同时带文本与工具调用，其后再垫 4 轮纯工具调用把它推出 last-8，
  // 然后抛超窗。tool 结果都很薄，microcompact 甩不到门槛 → 判 report → 返回 context_overflow 不重试。
  it('超窗路径 → 保住崩溃前的部分产出', async () => {
    const f = smallFile()
    script.push(readTurn(f, 0, 25000, '部分产出'))
    for (let i = 1; i <= 4; i++) script.push(readTurn(f, i, 25000))
    script.push({ throw: overflow() })
    const r = await runHeadless({ client: {} as any, prompt: '干活', yolo: true, home: home() })
    expect(r.status).toBe('context_overflow')
    expect(r.text).toBe('部分产出')
    // 反向锚点：产出保住不是因为「压了但没砍到」，而是压根没压。
    expect(summarize).not.toHaveBeenCalled()
  })
})
